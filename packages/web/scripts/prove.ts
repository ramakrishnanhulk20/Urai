import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunConfig, Workload } from "@urai/engine";
import type { Report } from "../lib/report";
import * as api from "./lib/client";

/*
 * The prove-it command: exercises Urai end to end over HTTP against a running server and prints
 * PASS or FAIL per step. Spends real money (about 0.05 USD): a small team run paid with the
 * operator's key used as a team key, and a demo run paid from the day's demo budget. Spend is
 * counted from SERV's token counts at the live price, and new calls stop once it nears CAP_USD.
 * Exits 1 on any FAIL.
 */

const CAP_USD = 0.1;
// New calls stop this far below the cap, leaving room for the calls already in flight.
const STOP_MARGIN_USD = 0.01;
const TEAM_CASES = 10;
const DEMO_SAMPLE = "sample-invoices-good";
const DEMO_CASES = 12;
const MODEL = "gpt-6-luna";
const CONFIGS: RunConfig[] = [
  { model: MODEL, mode: "raw" },
  { model: MODEL, mode: "plain" },
];

interface Price {
  inputUsdPerM: number;
  outputUsdPerM: number;
}

class StepFailed extends Error {}

const usd = (n: number) => n.toFixed(4);
const pct = (t: { correct: number; calls: number; accuracy: number | null }) =>
  `${t.correct}/${t.calls} = ${t.accuracy === null ? "n/a" : `${(t.accuracy * 100).toFixed(1)}%`}`;

function accuracyLine(rep: Report): string {
  return rep.totals.map((t, i) => `${rep.configs[i]!.model} ${rep.configs[i]!.mode} ${pct(t)}`).join(", ");
}

function check(ok: boolean, why: string): void {
  if (!ok) throw new StepFailed(why);
}

async function main(): Promise<number> {
  const base = api.baseFromArgs();
  const key = api.loadOperatorKey();
  const results: boolean[] = [];
  let spent = 0;
  let price: Price | null = null;
  let fixed: Workload | null = null;
  let demo: { runId: string; ownerToken: string; report: Report } | null = null;

  const callCost = (usage: { inputTokens: number | null; outputTokens: number | null }): number => {
    // Unknown token counts are charged a whole cent, well above any real gpt-6-luna call on these sets.
    if (price === null || usage.inputTokens === null || usage.outputTokens === null) return STOP_MARGIN_USD;
    return (usage.inputTokens * price.inputUsdPerM + usage.outputTokens * price.outputUsdPerM) / 1_000_000;
  };
  const shouldStop = () => spent > CAP_USD - STOP_MARGIN_USD;

  const step = async (n: number, name: string, fn: () => Promise<string[]>): Promise<void> => {
    try {
      const lines = await fn();
      console.log(`[PASS] ${n} ${name}`);
      for (const l of lines) console.log(`       ${l}`);
      results.push(true);
    } catch (err) {
      // An ApiError carries only a status and a code, never a header or the key (C1).
      const why = err instanceof Error ? err.message : "unknown error";
      console.log(`[FAIL] ${n} ${name}: ${why}`);
      results.push(false);
    }
  };

  console.log(`Urai prove-it against ${base}`);

  await step(1, "GET /api/models", async () => {
    const list = await api.models(base);
    const luna = list.models.find((m) => m.id === MODEL);
    check(list.models.length > 0, "the model list is empty");
    check(list.verified, `the list is not verified (fetched ${list.fetchedAt ?? "never"})`);
    check(luna !== undefined, `${MODEL} is not in the list`);
    price = luna!;
    return [`${list.models.length} models, verified ${list.verified}, fetched ${list.fetchedAt}`, `${MODEL}: ${luna!.inputUsdPerM} in / ${luna!.outputUsdPerM} out USD per million tokens`];
  });

  await step(2, "POST /api/lint on invoices-bad", async () => {
    const path = fileURLToPath(new URL("../../engine/workloads/invoices-bad.json", import.meta.url));
    const out = await api.lint(base, JSON.parse(readFileSync(path, "utf8")), CONFIGS);
    const ids = out.findings.map((f) => `${f.id} (${f.severity})`);
    check(out.findings.some((f) => f.id === "data-in-system-prompt"), "no data-in-system-prompt finding");
    check(out.fix !== null, "no one-click fix came back");
    fixed = out.fix!.workload;
    return [`findings: ${ids.join(", ")}`, `fix: yes, moved ${out.fix!.moved.map((m) => `${m.heading ?? "DATA"} (${m.chars} chars)`).join(", ")} out of the system prompt`];
  });

  await step(3, `team run: the fixed workload's first ${TEAM_CASES} cases, raw and plain`, async () => {
    check(fixed !== null, "skipped: step 2 returned no fix");
    check(price !== null, "skipped: step 1 returned no price, so spend cannot be estimated");
    const w = { ...fixed!, cases: fixed!.cases.slice(0, TEAM_CASES) };
    const created = await api.createWorkload(base, w);
    const run = await api.createRun(base, { workloadId: created.workloadId, configs: CONFIGS, payer: "team" }, created.ownerToken);
    const summary = await api.driveRun(base, run, api.runHeaders(run.ownerToken, key), 3, {
      shouldStop,
      onResult: ({ result }) => {
        spent += callCost(result.usage);
      },
    });
    check(spent <= CAP_USD, `spend from token counts reached ${usd(spent)} USD, over the ${CAP_USD} cap`);
    check(summary.stopped === null, `stopped: ${summary.stopped}`);
    check(summary.results.length === TEAM_CASES * CONFIGS.length, `${summary.results.length} of ${TEAM_CASES * CONFIGS.length} calls came back`);
    const rep = await api.report(base, run.runId, run.ownerToken);
    return [`accuracy: ${accuracyLine(rep)}`, `spend so far from token counts: ${usd(spent)} USD of the ${CAP_USD} cap`];
  });

  await step(4, `demo run: ${DEMO_SAMPLE}, ${DEMO_CASES} cases x ${CONFIGS.length} configs, no key`, async () => {
    check(price !== null, "skipped: step 1 returned no price, so spend cannot be estimated");
    const run = await api.createRun(base, { workloadId: DEMO_SAMPLE, configs: CONFIGS, payer: "demo" });
    check(run.cases.length === DEMO_CASES, `the demo run has ${run.cases.length} cases, expected ${DEMO_CASES}`);
    const summary = await api.driveRun(base, run, api.runHeaders(run.ownerToken), 3, {
      shouldStop,
      onResult: ({ result }) => {
        spent += callCost(result.usage);
      },
    });
    check(summary.stopped === null, `stopped: ${summary.stopped}`);
    check(summary.results.length === DEMO_CASES * CONFIGS.length, `${summary.results.length} of ${DEMO_CASES * CONFIGS.length} calls came back`);
    const rep = await api.report(base, run.runId, run.ownerToken);
    const cost = rep.totals.reduce<number | null>((sum, t) => (sum === null || t.estCostUsd === null ? null : sum + t.estCostUsd), 0);
    check(rep.balance === null, "a demo run carries a balance reading");
    demo = { runId: run.runId, ownerToken: run.ownerToken, report: rep };
    return [`accuracy: ${accuracyLine(rep)}`, `demo budget effect: about ${cost === null ? "unknown" : usd(cost)} USD, from the report's per-config cost`];
  });

  await step(5, "share the demo run, then GET /api/reports/:reportId with no header", async () => {
    check(demo !== null, "skipped: step 4 did not finish");
    const d = demo!;
    const { reportId } = await api.share(base, d.runId, d.ownerToken);
    const shared = await api.publicReport(base, reportId);
    check(JSON.stringify(shared.totals) === JSON.stringify(d.report.totals), "the shared report's totals differ from the owner's");
    check(!JSON.stringify(shared).includes(d.runId), "the shared report contains the run id");
    return [`reportId ${reportId}: same totals as the owner's report (${accuracyLine(shared)}), and the run id is nowhere in it`];
  });

  const passed = results.filter(Boolean).length;
  console.log(`spend: about ${usd(spent)} USD from token counts, cap ${CAP_USD}`);
  console.log(`RESULT: ${passed === results.length ? "PASS" : "FAIL"} (${passed} of ${results.length} steps)`);
  return passed === results.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`prove failed: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  },
);
