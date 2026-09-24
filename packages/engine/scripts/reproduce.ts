/*
 * Reruns the published bench measurements through the engine, live, with the operator key:
 * invoices-good raw and plain, invoices-bad plain, gpt-6-luna. Spends real credit, so the
 * balance is read before, after every CHECK_EVERY calls and after each plain run's first call,
 * and the run stops once spend passes STOP_AT_USD. The stop line sits below the 0.50 USD cap
 * because the balance only moves in whole cents and up to CONCURRENCY calls are in flight.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlausibleKey, parseWorkload, readBalance, runCase, type CaseResult, type CaseStatus, type RunConfig, type Workload } from "../src/index.js";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAP_USD = 0.5;
const STOP_AT_USD = 0.4;
const CONCURRENCY = 3;
const CHECK_EVERY = 12;
const MODEL = "gpt-6-luna";

const RUNS: { label: string; file: string; cfg: RunConfig; published: string }[] = [
  { label: "good raw", file: "invoices-good.json", cfg: { model: MODEL, mode: "raw" }, published: "96.3%" },
  { label: "good plain", file: "invoices-good.json", cfg: { model: MODEL, mode: "plain" }, published: "93.8%" },
  { label: "bad plain", file: "invoices-bad.json", cfg: { model: MODEL, mode: "plain" }, published: "66.3 to 72.5%" },
];

const STATUSES: CaseStatus[] = ["scored", "failed", "refused", "filtered", "upstream_error", "timeout"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadWorkload(file: string): Workload {
  const parsed = parseWorkload(JSON.parse(readFileSync(path.join(ENGINE_DIR, "workloads", file), "utf8")));
  if (!parsed.ok) fail(`${file} does not parse: ${parsed.errors.join("; ")}. Run scripts/convert-bench.ts first.`);
  return parsed.workload;
}

process.loadEnvFile(path.resolve(ENGINE_DIR, "..", "..", ".env"));
const key = process.env.SERV_API_KEY?.trim();
if (!isPlausibleKey(key)) fail("SERV_API_KEY in the root .env is missing or not shaped like a key.");

const apiKey: string = key;
const before = await readBalance(apiKey);
if (!before.ok) fail(`Balance unavailable before the run (${before.reason}); not spending blind.`);
const startUsd = before.usd;
console.log(`Balance before: ${startUsd.toFixed(2)} USD. Cap ${CAP_USD.toFixed(2)} USD, stop line ${STOP_AT_USD.toFixed(2)} USD.`);

const stop = new AbortController();
let stopReason: string | null = null;

async function checkSpend(where: string): Promise<void> {
  const now = await readBalance(apiKey);
  if (now.ok && startUsd - now.usd <= STOP_AT_USD) return;
  stopReason = now.ok ? `spent ${(startUsd - now.usd).toFixed(2)} USD by ${where}, past the ${STOP_AT_USD.toFixed(2)} stop line` : `balance ${now.reason} at ${where}`;
  stop.abort();
}

async function runAll(w: Workload, label: string, cfg: RunConfig): Promise<CaseResult[]> {
  const ids = w.cases.map((c) => c.id);
  const results: CaseResult[] = [];
  const one = async (id: string) => {
    if (stop.signal.aborted) return;
    results.push(await runCase(w, id, cfg, apiKey, { signal: stop.signal }));
    if (results.length % CHECK_EVERY === 0 && !stop.signal.aborted) await checkSpend(`${label} call ${results.length}`);
  };
  // A plain run's first call is where SERV would build a reasoning graph if its cache had lost this prompt, so it runs alone.
  if (cfg.mode !== "raw") {
    await one(ids.shift()!);
    if (!stop.signal.aborted) await checkSpend(`${label} first call`);
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length && !stop.signal.aborted) await one(ids[next++]!);
    }),
  );
  return results;
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
const rows: string[] = [];
for (const run of RUNS) {
  if (stop.signal.aborted) break;
  const w = loadWorkload(run.file);
  const results = await runAll(w, run.label, run.cfg);
  const correct = results.filter((r) => r.correct).length;
  const counts = STATUSES.map((s) => results.filter((r) => r.status === s).length);
  const errors = [...new Set(results.filter((r) => r.error !== null).map((r) => r.error))];
  const missingUsage = results.filter((r) => r.usage.inputTokens === null).length;
  rows.push(
    `| ${run.label} | ${results.length} | ${correct} | ${((100 * correct) / Math.max(results.length, 1)).toFixed(1)}% | ${run.published} | ` +
      `${counts.join(" / ")} | ${(sum(results.map((r) => r.latencyMs)) / Math.max(results.length, 1) / 1000).toFixed(1)} s | ` +
      `${sum(results.map((r) => r.usage.inputTokens))} / ${sum(results.map((r) => r.usage.outputTokens))} / ${sum(results.map((r) => r.usage.cachedTokens))}` +
      `${missingUsage > 0 ? ` (${missingUsage} unknown)` : ""} |`,
  );
  console.error(`${run.label}: ${results.length} calls done${errors.length > 0 ? `, errors: ${errors.join(", ")}` : ""}`);
}

const after = await readBalance(apiKey);
console.log("");
console.log("| Run | Calls | Correct | Accuracy | Published | scored / failed / refused / filtered / upstream_error / timeout | Mean latency | Tokens in / out / cached |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) console.log(r);
console.log("");
console.log(`Balance before ${startUsd.toFixed(2)} USD, after ${after.ok ? `${after.usd.toFixed(2)} USD, spent ${(startUsd - after.usd).toFixed(2)} USD` : `unavailable (${after.reason})`}.`);
if (stopReason !== null) fail(`Stopped early: ${stopReason}.`);
if (after.ok && startUsd - after.usd > CAP_USD) fail(`Spend passed the ${CAP_USD.toFixed(2)} USD cap.`);
