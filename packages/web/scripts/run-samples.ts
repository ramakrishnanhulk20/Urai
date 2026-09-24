import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWorkload, type RunConfig, type Workload } from "@urai/engine";
import { db } from "../lib/db";
import * as api from "./lib/client";

/*
 * Runs the four sample reports the landing page links to, as team runs paid by the operator's key
 * (C4: nothing operator-authored goes through the demo path or its budget), then shares them and
 * writes lib/sample-reports.json. Spends real money: every run is bracketed by two balance probes
 * and the whole script stops once the operator balance has dropped by CAP_USD.
 */

const CAP_USD = 1.5;
// New calls stop this far below the cap, leaving room for the calls already in flight.
const STOP_MARGIN_USD = 0.05;
// SERV builds a reasoning graph the first time plain mode meets a system prompt, about 0.60 USD.
const FIRST_SIGHT_RESERVE_USD = 0.7;
// Pre-run estimate only: prompt characters per token on the low side, and a generous answer length.
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

interface Price {
  inputUsdPerM: number;
  outputUsdPerM: number;
}

function loadWorkload(file: string): Workload {
  const path = fileURLToPath(new URL(`../../engine/workloads/${file}`, import.meta.url));
  const parsed = parseWorkload(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new Error(`${file} does not parse`);
  return parsed.workload;
}

function estimateCallUsd(w: Workload, caseId: string, price: Price): number {
  const c = w.cases.find((x) => x.id === caseId);
  const chars = w.systemPrompt.length + (w.context?.length ?? 0) + (c?.input.length ?? 0);
  return ((chars / CHARS_PER_TOKEN) * price.inputUsdPerM + ANSWER_TOKENS * price.outputUsdPerM) / 1_000_000;
}

function estimateRunUsd(w: Workload, cases: string[], configs: RunConfig[], price: Price): number {
  return cases.reduce((sum, id) => sum + estimateCallUsd(w, id, price), 0) * configs.length;
}

const usd = (n: number) => n.toFixed(4);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const label = (c: RunConfig) => `${c.model} ${c.mode}`;

/**
 * What the operator has spent since the first probe: the realised drop between probes, plus an
 * estimate from token counts for the calls made since the last probe. Anyone else spending on the
 * same key in the meantime counts too, which only makes the cap stricter.
 */
class Ledger {
  private start: number | null = null;
  private last: number | null = null;
  private sinceProbe = 0;

  record(balanceUsd: number): void {
    this.start ??= balanceUsd;
    this.last = balanceUsd;
    this.sinceProbe = 0;
  }

  add(estimateUsd: number): void {
    this.sinceProbe += estimateUsd;
  }

  spent(): number {
    return this.start === null || this.last === null ? this.sinceProbe : this.start - this.last + this.sinceProbe;
  }

  realised(): number | null {
    return this.start === null || this.last === null ? null : this.start - this.last;
  }
}

async function main(): Promise<void> {
  const base = api.baseFromArgs();
  const key = api.loadOperatorKey();
  const ledger = new Ledger();

  const list = await api.models(base);
  const price = list.models.find((m) => m.id === MODEL);
  if (price === undefined) throw new Error(`${MODEL} is not in the model list, so no spend estimate is possible`);
  console.log(`model list: ${list.models.length} models, verified ${list.verified}; ${MODEL} ${price.inputUsdPerM}/${price.outputUsdPerM} USD per M tokens`);

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

  const probe = async (run: api.RunCreated, when: string): Promise<number> => {
    const b = await api.balance(base, run.runId, run.ownerToken, key);
    if (!("usd" in b)) throw new Error(`balance unavailable ${when}; stopping because spend can no longer be checked`);
    ledger.record(b.usd);
    return b.usd;
  };

  const drive = async (run: api.RunCreated, w: Workload, cases: string[]): Promise<number> => {
    const summary = await api.driveRun(base, { runId: run.runId, cases, configs: run.configs }, api.runHeaders(run.ownerToken, key), 3, {
      shouldStop: () => ledger.spent() > CAP_USD - STOP_MARGIN_USD,
      onResult: ({ caseId, result }) => {
        const { inputTokens, outputTokens } = result.usage;
        ledger.add(
          inputTokens === null || outputTokens === null
            ? estimateCallUsd(w, caseId, price)
            : (inputTokens * price.inputUsdPerM + outputTokens * price.outputUsdPerM) / 1_000_000,
        );
      },
    });
    if (summary.stopped !== null) throw new Error(`run stopped: ${summary.stopped}; spent so far about ${usd(ledger.spent())} USD`);
    return summary.results.length;
  };

  const headroom = (needUsd: number, what: string): void => {
    if (ledger.spent() + needUsd > CAP_USD - STOP_MARGIN_USD) {
      throw new Error(`not starting ${what}: about ${usd(needUsd)} USD needed, ${usd(ledger.spent())} of ${CAP_USD} already spent`);
    }
  };

  // Plain mode has never met the hard prompt, so its first call builds a graph. That one call runs
  // alone, on a run of its own, so its real cost is read before anything else is spent.
  const hardIds = workloads.get("hard")!;
  const warm = await api.createRun(base, { workloadId: hardIds.workloadId, configs: [PLAIN], payer: "team" }, hardIds.ownerToken);
  const firstCase = warm.cases[0]!;
  headroom(FIRST_SIGHT_RESERVE_USD, "the hard warm-up call");
  const warmBefore = await probe(warm, "before the hard warm-up");
  await drive(warm, hard, [firstCase]);
  const warmAfter = await probe(warm, "after the hard warm-up");
  console.log(`hard warm-up (1 plain call, first sight of the prompt): balance ${usd(warmBefore)} -> ${usd(warmAfter)}, spent ${usd(warmBefore - warmAfter)} USD`);

  const done: { spec: Spec; run: api.RunCreated; before: number; after: number }[] = [];
  for (const spec of specs) {
    const ids = workloads.get(spec.slug)!;
    const run = await api.createRun(base, { workloadId: ids.workloadId, configs: spec.configs, payer: "team" }, ids.ownerToken);
    headroom(estimateRunUsd(spec.workload, run.cases, run.configs, price), spec.slug);
    const before = await probe(run, `before ${spec.slug}`);
    const calls = await drive(run, spec.workload, run.cases);
    const after = await probe(run, `after ${spec.slug}`);
    if (calls !== run.cases.length * run.configs.length) throw new Error(`${spec.slug}: ${calls} of ${run.cases.length * run.configs.length} calls came back`);
    console.log(`${spec.slug}: ${calls} calls, balance ${usd(before)} -> ${usd(after)}, spent ${usd(before - after)} USD`);
    done.push({ spec, run, before, after });
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
  for (const { spec, run, before, after } of done) {
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
      balanceDeltaUsd: round4(before - after),
    });
    rep.totals.forEach((t, i) => {
      rows.push(
        [spec.slug, label(rep.configs[i]!), `${t.correct}/${t.calls} = ${t.accuracy === null ? "n/a" : (t.accuracy * 100).toFixed(1)}%`, `est ${t.estCostUsd === null ? "n/a" : usd(t.estCostUsd)}`, i === 0 ? `delta ${usd(before - after)}` : ""].join(" | "),
      );
    });
  }

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log("");
  console.log("slug | config | accuracy | token-estimated cost USD | balance delta USD");
  for (const r of rows) console.log(r);
  console.log(`total spend (first probe to last probe, realised): ${usd(ledger.realised() ?? 0)} USD, cap ${CAP_USD}`);
  console.log(`wrote lib/sample-reports.json with ${out.length} shared reports`);
}

main().catch((err: unknown) => {
  // An ApiError carries only a status and a code; anything else is reported by its message, which this script writes itself.
  console.error(`run-samples failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
