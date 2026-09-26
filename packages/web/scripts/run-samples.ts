import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWorkload, type RunConfig, type Workload } from "@urai/engine";
import { db } from "../lib/db";
import type { ModelEntry } from "../lib/models";
import { callCostUsd } from "../lib/prices";
import * as api from "./lib/client";

/*
 * Runs the four sample reports the landing page links to, as team runs paid by the operator's key
 * (C4: nothing operator-authored goes through the demo path or its budget), then shares them and
 * writes lib/sample-reports.json. Spends real money, so spend is a running total of each call's
 * token counts at the higher of the table price and SERV's live price (lib/prices.ts), and the
 * whole script stops before it reaches CAP_USD. Token counts cannot see SERV's one-off graph build
 * for a prompt it has not seen, so the hard warm-up call is charged FIRST_SIGHT_RESERVE_USD on top.
 * New runs carry no balance reading: SERV began billing the balance probe on 25 Sep 2026 and it
 * was removed.
 */

const CAP_USD = 1.5;
// New calls stop this far below the cap, leaving room for the calls already in flight.
const STOP_MARGIN_USD = 0.05;
// SERV builds a reasoning graph the first time plain mode meets a system prompt, about 0.60 USD.
const FIRST_SIGHT_RESERVE_USD = 0.7;
// Pre-run estimates, and the charge for a call SERV reported no token counts for: prompt
// characters per token on the low side, and a generous answer length.
const CHARS_PER_TOKEN = 3;
const ANSWER_TOKENS = 400;
const EXTENDED_UNTIL = "2027-12-31T23:59:59Z";
const MODEL = "gpt-6-luna";
const RAW: RunConfig = { model: MODEL, mode: "raw" };
const PLAIN: RunConfig = { model: MODEL, mode: "plain" };
const OUT = fileURLToPath(new URL("../lib/sample-reports.json", import.meta.url));

interface Spec {
  slug: string;
  title: string;
  workload: Workload;
  configs: RunConfig[];
}

function loadWorkload(file: string): Workload {
  const path = fileURLToPath(new URL(`../../engine/workloads/${file}`, import.meta.url));
  const parsed = parseWorkload(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`${file} does not parse`);
  return parsed.workload;
}

function priced(cost: number | null, cfg: RunConfig): number {
  if (cost === null) throw new Error(`${label(cfg)} has no price, so its spend cannot be counted`);
  return cost;
}

function estimateCallUsd(w: Workload, caseId: string, cfg: RunConfig, live: readonly ModelEntry[]): number {
  const c = w.cases.find((x) => x.id === caseId);
  const chars = w.systemPrompt.length + (w.context?.length ?? 0) + (c?.input.length ?? 0);
  return priced(callCostUsd(cfg, { inputTokens: chars / CHARS_PER_TOKEN, outputTokens: ANSWER_TOKENS }, live), cfg);
}

function estimateRunUsd(w: Workload, cases: string[], configs: RunConfig[], live: readonly ModelEntry[]): number {
  return configs.reduce((sum, cfg) => sum + cases.reduce((part, id) => part + estimateCallUsd(w, id, cfg, live), 0), 0);
}

const usd = (n: number) => n.toFixed(4);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const label = (c: RunConfig) => `${c.model} ${c.mode}`;

async function main(): Promise<void> {
  const base = api.baseFromArgs();
  const key = api.loadOperatorKey();
  let spent = 0;

  const list = await api.models(base);
  const live = list.models;
  const price = live.find((m) => m.id === MODEL);
  if (price === undefined) throw new Error(`${MODEL} is not in the model list, so no spend estimate is possible`);
  console.log(`model list: ${live.length} models, verified ${list.verified}; ${MODEL} ${price.inputUsdPerM}/${price.outputUsdPerM} USD per M tokens live, charged at the higher of that and the table price`);

  const bad = loadWorkload("invoices-bad.json");
  const lint = await api.lint(base, bad);
  if (lint.fix === null) throw new Error("the lint returned no fix for invoices-bad");
  console.log(`lint on invoices-bad: ${lint.findings.map((f) => f.id).join(", ")}; fix moved ${lint.fix.moved.map((m) => `${m.heading ?? "DATA"} (${m.chars} chars)`).join(", ")}`);

  const hard = loadWorkload("invoices-hard.json");
  const specs: Spec[] = [
    { slug: "fix-before", title: "Before the fix: supplier book inside the system prompt, SERV plain", workload: bad, configs: [PLAIN] },
    { slug: "fix-after", title: "After the one-click fix: supplier book moved to the user message, SERV plain", workload: { ...lint.fix.workload, name: "Invoice approvals after the one-click fix: supplier book moved to the user message" }, configs: [PLAIN] },
    { slug: "parity", title: "Good layout: SERV off against SERV plain", workload: loadWorkload("invoices-good.json"), configs: [RAW, PLAIN] },
    { slug: "hard", title: "Hard set, 152 clauses in four sources: SERV off against SERV plain", workload: hard, configs: [RAW, PLAIN] },
  ];

  const workloads = new Map<string, api.WorkloadCreated>();
  for (const s of specs) workloads.set(s.slug, await api.createWorkload(base, s.workload));

  const drive = async (run: api.RunCreated, w: Workload, cases: string[]): Promise<number> => {
    const summary = await api.driveRun(base, { runId: run.runId, cases, configs: run.configs }, api.runHeaders(run.ownerToken, key), 3, {
      shouldStop: () => spent > CAP_USD - STOP_MARGIN_USD,
      onResult: ({ caseId, configIdx, result }) => {
        const cfg = run.configs[configIdx]!;
        spent += callCostUsd(cfg, result.usage, live) ?? estimateCallUsd(w, caseId, cfg, live);
      },
    });
    if (summary.stopped !== null) throw new Error(`run stopped: ${summary.stopped}; spent so far about ${usd(spent)} USD`);
    return summary.results.length;
  };

  const headroom = (needUsd: number, what: string): void => {
    if (spent + needUsd > CAP_USD - STOP_MARGIN_USD) {
      throw new Error(`not starting ${what}: about ${usd(needUsd)} USD needed, ${usd(spent)} of ${CAP_USD} already spent`);
    }
  };

  // Plain mode may never have met the hard prompt, so its first call can build a graph that token
  // counts do not show. That one call runs alone, on a run of its own, and the reserve is counted
  // as spent before it goes out, so the cap holds for any build that costs up to the reserve.
  const hardIds = workloads.get("hard")!;
  const warm = await api.createRun(base, { workloadId: hardIds.workloadId, configs: [PLAIN], payer: "team" }, hardIds.ownerToken);
  const firstCase = warm.cases[0]!;
  headroom(FIRST_SIGHT_RESERVE_USD, "the hard warm-up call");
  const warmStart = spent;
  spent += FIRST_SIGHT_RESERVE_USD;
  await drive(warm, hard, [firstCase]);
  console.log(`hard warm-up (1 plain call, first sight of the prompt): ${usd(spent - warmStart - FIRST_SIGHT_RESERVE_USD)} USD from token counts, plus the ${FIRST_SIGHT_RESERVE_USD} USD graph reserve`);

  const done: { spec: Spec; run: api.RunCreated; spentUsd: number }[] = [];
  for (const spec of specs) {
    const ids = workloads.get(spec.slug)!;
    const run = await api.createRun(base, { workloadId: ids.workloadId, configs: spec.configs, payer: "team" }, ids.ownerToken);
    headroom(estimateRunUsd(spec.workload, run.cases, run.configs, live), spec.slug);
    const before = spent;
    const calls = await drive(run, spec.workload, run.cases);
    if (calls !== run.cases.length * run.configs.length) throw new Error(`${spec.slug}: ${calls} of ${run.cases.length * run.configs.length} calls came back`);
    console.log(`${spec.slug}: ${calls} calls, ${usd(spent - before)} USD from token counts`);
    done.push({ spec, run, spentUsd: spent - before });
  }

  const ids = [...workloads.values()].map((w) => w.workloadId);
  const extended = await db()`
    UPDATE workloads SET expires_at = ${EXTENDED_UNTIL}::timestamptz
    WHERE id = ANY(${ids}) AND NOT is_sample
    RETURNING id`;
  console.log(`operator action: SQL UPDATE workloads SET expires_at = '${EXTENDED_UNTIL}' on the ${ids.length} sample-report team workloads, ${extended.length} rows updated`);
  if (extended.length !== ids.length) throw new Error("not every sample-report workload was extended");

  const out = [];
  const rows: string[] = [];
  for (const { spec, run, spentUsd } of done) {
    const { reportId } = await api.share(base, run.runId, run.ownerToken);
    const rep = await api.report(base, run.runId, run.ownerToken);
    const shared = await api.publicReport(base, reportId);
    if (JSON.stringify(shared.totals) !== JSON.stringify(rep.totals)) throw new Error(`${spec.slug}: the shared report does not match the owner's`);
    const accuracy = rep.totals.map((t) => (t.accuracy === null ? null : round4(t.accuracy)));
    out.push({
      slug: spec.slug,
      title: spec.title,
      reportId,
      headline: { configs: rep.configs.map(label), accuracy },
      // A new run has no balance reading; the stored 23 Sep samples keep theirs.
      balanceDeltaUsd: null,
    });
    rep.totals.forEach((t, i) => {
      rows.push(
        [spec.slug, label(rep.configs[i]!), `${t.correct}/${t.calls} = ${t.accuracy === null ? "n/a" : (t.accuracy * 100).toFixed(1)}%`, `est ${t.estCostUsd === null ? "n/a" : usd(t.estCostUsd)}`, i === 0 ? `run ${usd(spentUsd)}` : ""].join(" | "),
      );
    });
  }

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log("");
  console.log("slug | config | accuracy | token-estimated cost USD | run spend from token counts USD");
  for (const r of rows) console.log(r);
  console.log(`total spend from token counts, graph reserve included: ${usd(spent)} USD, cap ${CAP_USD}`);
  console.log(`wrote lib/sample-reports.json with ${out.length} shared reports`);
}

main().catch((err: unknown) => {
  // An ApiError carries only a status and a code; anything else is reported by its message, which this script writes itself.
  console.error(`run-samples failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
