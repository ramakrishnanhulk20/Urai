/*
 * Reruns the published bench measurements through the engine, live, with the operator key:
 * invoices-good raw and plain, invoices-bad plain, gpt-6-luna. Spends real credit, so spend is a
 * running total of each call's token counts at SERV's live price for the model, and new calls stop
 * once it passes STOP_AT_USD. The stop line sits below the 0.50 USD cap because up to CONCURRENCY
 * calls are in flight. Token counts cannot see SERV's one-off graph build for a prompt it has not
 * cached, so this script is only run on prompts SERV has already seen (threat model C28).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlausibleKey, listModels, normaliseModelId, parseWorkload, runCase, type CaseResult, type CaseStatus, type RunConfig, type Workload } from "../src/index.js";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAP_USD = 0.5;
const STOP_AT_USD = 0.4;
const CONCURRENCY = 3;
// A call SERV reported no token counts for is charged as if its prompt were this dense and its answer this long.
const CHARS_PER_TOKEN = 3;
const UNKNOWN_ANSWER_TOKENS = 1_000;
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
const models = await listModels(apiKey);
if (!models.ok) fail("SERV's model list could not be read, so spend cannot be priced; not spending blind.");
const listed = models.models.find((m) => normaliseModelId(m.id) === normaliseModelId(MODEL));
if (listed === undefined) fail(`${MODEL} is not in SERV's model list, so spend cannot be priced; not spending blind.`);
const price = listed;
console.log(`${MODEL} live price ${price.inputUsdPerM} in / ${price.outputUsdPerM} out USD per million tokens. Cap ${CAP_USD.toFixed(2)} USD, stop line ${STOP_AT_USD.toFixed(2)} USD.`);

const stop = new AbortController();
let stopReason: string | null = null;
let spentUsd = 0;

// An unknown count is charged the whole prompt and a long answer, so a gap in SERV's usage can only make the guard stricter.
function callUsd(w: Workload, r: CaseResult): number {
  const { inputTokens, outputTokens } = r.usage;
  if (inputTokens !== null && outputTokens !== null) return (inputTokens * price.inputUsdPerM + outputTokens * price.outputUsdPerM) / 1_000_000;
  const chars = w.systemPrompt.length + (w.context?.length ?? 0) + (w.cases.find((c) => c.id === r.caseId)?.input.length ?? 0);
  return ((chars / CHARS_PER_TOKEN) * price.inputUsdPerM + UNKNOWN_ANSWER_TOKENS * price.outputUsdPerM) / 1_000_000;
}

async function runAll(w: Workload, label: string, cfg: RunConfig): Promise<CaseResult[]> {
  const ids = w.cases.map((c) => c.id);
  const results: CaseResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length && !stop.signal.aborted) {
        const r = await runCase(w, ids[next++]!, cfg, apiKey, { signal: stop.signal });
        results.push(r);
        spentUsd += callUsd(w, r);
        if (spentUsd > STOP_AT_USD && !stop.signal.aborted) {
          stopReason = `spent ${spentUsd.toFixed(4)} USD by ${label} call ${results.length}, past the ${STOP_AT_USD.toFixed(2)} stop line`;
          stop.abort();
        }
      }
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

console.log("");
console.log("| Run | Calls | Correct | Accuracy | Published | scored / failed / refused / filtered / upstream_error / timeout | Mean latency | Tokens in / out / cached |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) console.log(r);
console.log("");
console.log(`Spent about ${spentUsd.toFixed(4)} USD from SERV's token counts at the live price.`);
if (stopReason !== null) fail(`Stopped early: ${stopReason}.`);
if (spentUsd > CAP_USD) fail(`Spend passed the ${CAP_USD.toFixed(2)} USD cap.`);
