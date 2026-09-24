/*
 * The signature moment, live: lint invoices-bad, apply the one-click layout fix, then run
 * gpt-6-luna under plain SERV on the bad workload and on the fixed one with the operator key.
 * The fixed system prompt is byte-identical to invoices-good's, so SERV reuses the reasoning
 * graph it already built for it and the run costs cents. The balance is read before, after each
 * run's first call and every CHECK_EVERY calls, and the run stops once spend passes STOP_AT_USD.
 * The stop line sits below the cap because the balance moves in whole cents and up to
 * CONCURRENCY calls are in flight.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyLayoutFix,
  isPlausibleKey,
  lintWorkload,
  listModels,
  parseWorkload,
  readBalance,
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
const CHECK_EVERY = 12;
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

async function runAll(w: Workload, label: string): Promise<CaseResult[]> {
  const ids = w.cases.map((c) => c.id);
  const results: CaseResult[] = [];
  const one = async (id: string) => {
    if (stop.signal.aborted) return;
    results.push(await runCase(w, id, CFG, apiKey, { signal: stop.signal }));
    if (results.length % CHECK_EVERY === 0 && !stop.signal.aborted) await checkSpend(`${label} call ${results.length}`);
  };
  // The first call is where SERV would build a reasoning graph if its cache had lost this prompt, so it runs alone.
  await one(ids.shift()!);
  if (!stop.signal.aborted) await checkSpend(`${label} first call`);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ids.length && !stop.signal.aborted) await one(ids[next++]!);
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

const after = await readBalance(apiKey);
console.log("");
console.log(`gpt-6-luna, plain SERV, ${CONCURRENCY} at a time:`);
for (const r of rows) console.log(r);
console.log(`Balance before ${startUsd.toFixed(2)} USD, after ${after.ok ? `${after.usd.toFixed(2)} USD, spent ${(startUsd - after.usd).toFixed(2)} USD` : `unavailable (${after.reason})`}.`);
console.log("");

const fixedFindings = lintWorkload(fixed, { models, configs: [CFG] });
printFindings("the fixed workload", fixedFindings);
if (fixedFindings.some((f) => f.id === "data-in-system-prompt")) fail("data-in-system-prompt is still present after the fix.");
if (stopReason !== null) fail(`Stopped early: ${stopReason}.`);
if (after.ok && startUsd - after.usd > CAP_USD) fail(`Spend passed the ${CAP_USD.toFixed(2)} USD cap.`);
