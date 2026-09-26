/*
 * The signature moment, live: lint invoices-bad, apply the one-click layout fix, then run
 * gpt-6-luna under plain SERV on the bad workload and on the fixed one with the operator key.
 * The fixed system prompt is byte-identical to invoices-good's, so SERV reuses the reasoning
 * graph it already built for it and the run costs cents. Spend is a running total of each call's
 * token counts at SERV's live price for the model, and new calls stop once it passes STOP_AT_USD.
 * The stop line sits below the cap because up to CONCURRENCY calls are in flight. Token counts
 * cannot see SERV's one-off graph build for a prompt it has not cached, so this script is only run
 * on prompts SERV has already seen (threat model C28).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyLayoutFix,
  isPlausibleKey,
  lintWorkload,
  listModels,
  normaliseModelId,
  parseWorkload,
  runCase,
  type CaseResult,
  type LintFinding,
  type RunConfig,
  type Workload,
} from "../src/index.js";

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAP_USD = 0.2;
const STOP_AT_USD = 0.15;
const CONCURRENCY = 3;
// A call SERV reported no token counts for is charged as if its prompt were this dense and its answer this long.
const CHARS_PER_TOKEN = 3;
const UNKNOWN_ANSWER_TOKENS = 1_000;
const CFG: RunConfig = { model: "gpt-6-luna", mode: "plain" };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printFindings(label: string, findings: LintFinding[]): void {
  console.log(`Lint findings for ${label}:`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.id}${f.fixable ? " (fixable)" : ""}: ${f.title}.${f.evidence === null ? "" : ` Evidence: ${f.evidence}`}`);
  }
}

process.loadEnvFile(path.resolve(ENGINE_DIR, "..", "..", ".env"));
const key = process.env.SERV_API_KEY?.trim();
if (!isPlausibleKey(key)) fail("SERV_API_KEY in the root .env is missing or not shaped like a key.");
const apiKey: string = key;

const parsed = parseWorkload(JSON.parse(readFileSync(path.join(ENGINE_DIR, "workloads", "invoices-bad.json"), "utf8")));
if (!parsed.ok) fail(`invoices-bad.json does not parse: ${parsed.errors.join("; ")}`);
const bad = parsed.workload;

const models = await listModels(apiKey);
const badFindings = lintWorkload(bad, { models, configs: [CFG] });
printFindings("invoices-bad", badFindings);
if (!badFindings.some((f) => f.id === "data-in-system-prompt" && f.fixable)) fail("The lint did not flag the supplier book; nothing to prove.");

const { workload: fixed, moved } = applyLayoutFix(bad);
console.log(`Fix applied: moved ${moved.map((m) => `${m.heading ?? "DATA"} (${m.kind}, ${m.chars} characters)`).join(", ")} into context.`);
console.log(`System prompt ${bad.systemPrompt.length} -> ${fixed.systemPrompt.length} characters.`);
console.log("");

if (!models.ok) fail("SERV's model list could not be read, so spend cannot be priced; not spending blind.");
const listed = models.models.find((m) => normaliseModelId(m.id) === normaliseModelId(CFG.model));
if (listed === undefined) fail(`${CFG.model} is not in SERV's model list, so spend cannot be priced; not spending blind.`);
const price = listed;
console.log(`${CFG.model} live price ${price.inputUsdPerM} in / ${price.outputUsdPerM} out USD per million tokens. Cap ${CAP_USD.toFixed(2)} USD, stop line ${STOP_AT_USD.toFixed(2)} USD.`);

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

async function runAll(w: Workload, label: string): Promise<CaseResult[]> {
  const ids = w.cases.map((c) => c.id);
  const results: CaseResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length && !stop.signal.aborted) {
        const r = await runCase(w, ids[next++]!, CFG, apiKey, { signal: stop.signal });
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

const rows: string[] = [];
for (const [label, w] of [
  ["bad (book in system prompt)", bad],
  ["fixed (after one click)", fixed],
] as const) {
  if (stop.signal.aborted) break;
  const results = await runAll(w, label);
  const correct = results.filter((r) => r.correct).length;
  const statuses = [...new Set(results.map((r) => r.status))].map((s) => `${s} ${results.filter((r) => r.status === s).length}`).join(", ");
  rows.push(`  ${label}: ${correct} of ${results.length} correct, ${((100 * correct) / Math.max(results.length, 1)).toFixed(1)}% (${statuses})`);
}

console.log("");
console.log(`gpt-6-luna, plain SERV, ${CONCURRENCY} at a time:`);
for (const r of rows) console.log(r);
console.log(`Spent about ${spentUsd.toFixed(4)} USD from SERV's token counts at the live price.`);
console.log("");

const fixedFindings = lintWorkload(fixed, { models, configs: [CFG] });
printFindings("the fixed workload", fixedFindings);
if (fixedFindings.some((f) => f.id === "data-in-system-prompt")) fail("data-in-system-prompt is still present after the fix.");
if (stopReason !== null) fail(`Stopped early: ${stopReason}.`);
if (spentUsd > CAP_USD) fail(`Spend passed the ${CAP_USD.toFixed(2)} USD cap.`);
