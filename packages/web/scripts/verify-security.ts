import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { access } from "./checks/access";
import { budget } from "./checks/budget";
import { input } from "./checks/input";
import { keys } from "./checks/keys";
import { bucketsFor, type CheckRecord, type Ctx, database, loadEnv, makeCtx, redact, REPO_ROOT } from "./checks/shared";
import { surface } from "./checks/surface";

/*
 * Rules whose proof is a unit test, not a request. Each named test is looked up in its file before
 * it is listed, so a renamed or deleted test shows up here as missing.
 */
const UNIT_TESTS: { rule: string; file: string; tests: string[] }[] = [
  {
    rule: "C15",
    file: "packages/engine/test/score.test.ts",
    tests: [
      "normalises both sides for exact",
      "reads a numeric string and a number the same way with tolerance 0",
      "never matches null, objects or NaN, on either side",
      "matches oneOf against any option after normalising both sides",
    ],
  },
  { rule: "C16", file: "packages/engine/test/serv.test.ts", tests: ["classifies %s as failed with answer null (C16)"] },
  {
    rule: "C17",
    file: "packages/engine/test/serv.test.ts",
    tests: ["runCase response validation (C17)", "keeps missing token counts as null, never 0"],
  },
  { rule: "C18", file: "packages/engine/test/lint.test.ts", tests: ["with a failed model list the check says model-unverified as info, never model-unknown (C18)"] },
  {
    rule: "C18",
    file: "packages/web/test/models.test.ts",
    tests: ["serves a stale cache as unverified when SERV cannot be read, never as current (C18)", "says could not verify, never unknown, when the list is unverified (C18)"],
  },
];

interface UnitLine {
  rule: string;
  file: string;
  test: string;
  found: boolean;
}

function unitCoverage(): UnitLine[] {
  const out: UnitLine[] = [];
  for (const u of UNIT_TESTS) {
    const path = `${REPO_ROOT}${u.file}`;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    for (const test of u.tests) out.push({ rule: u.rule, file: u.file, test, found: text.includes(`"${test}"`) || text.includes(`\`${test}\``) });
  }
  return out;
}

function args(): { base: string; skipBudget: boolean; serverLog: string | null } {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      "skip-budget": { type: "boolean", default: false },
      "server-log": { type: "string" },
    },
  });
  if (values.base === undefined) throw new Error("usage: npm run verify-security -- --base <url> [--skip-budget] [--server-log <file>]");
  const url = new URL(values.base);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("--base must be https, or http on localhost");
  return { base: url.origin, skipBudget: values["skip-budget"] === true, serverLog: values["server-log"] ?? null };
}

async function group(ctx: Ctx, name: string, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  ctx.rec.group = name;
  console.log(`\n${name}`);
  try {
    await fn(ctx);
  } catch (err) {
    // A group that cannot finish proves nothing, so it counts as BROKEN rather than being skipped.
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.rec.add("-", `${name} group stopped early`, "see the checks above", why.slice(0, 300), false);
  }
}

async function cleanup(ctx: Ctx): Promise<Record<string, number>> {
  const { sql, created } = ctx;
  const runs = [...created.runs];
  const workloads = [...created.workloads];
  const buckets = [...created.ips].flatMap(bucketsFor);
  const n = (rows: Record<string, unknown>[]) => Number(rows[0]?.n);
  const caseResults = n(await sql`WITH gone AS (DELETE FROM case_results WHERE run_id = ANY(${runs}) RETURNING 1) SELECT count(*)::int AS n FROM gone`);
  const runRows = n(await sql`WITH gone AS (DELETE FROM runs WHERE id = ANY(${runs}) RETURNING 1) SELECT count(*)::int AS n FROM gone`);
  // NOT is_sample: a sample id can never reach this list, and this makes sure of it.
  const workloadRows = n(await sql`WITH gone AS (DELETE FROM workloads WHERE id = ANY(${workloads}) AND NOT is_sample RETURNING 1) SELECT count(*)::int AS n FROM gone`);
  const rateRows = n(await sql`WITH gone AS (DELETE FROM rate_limits WHERE bucket = ANY(${buckets}) RETURNING 1) SELECT count(*)::int AS n FROM gone`);
  return { case_results: caseResults, runs: runRows, workloads: workloadRows, rate_limits: rateRows };
}

// The record is read as markdown, and C20 puts real markup into it, so angle brackets are escaped to show as text (C25).
function cell(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

function writeRecord(stamp: string, opts: { base: string; skipBudget: boolean }, records: CheckRecord[], unit: UnitLine[], deleted: Record<string, number> | string): string {
  const count = (o: string) => records.filter((r) => r.outcome === o).length;
  const missing = unit.filter((u) => !u.found).length;
  const lines = [
    `# Security check run, ${stamp}`,
    "",
    `Target: ${opts.base}. Budget checks: ${opts.skipBudget ? "skipped (--skip-budget)" : "run"}.`,
    "",
    `Result: ${count("OK")} OK, ${count("BROKEN")} BROKEN, ${count("PENDING")} PENDING. Unit tests listed: ${unit.length - missing} found, ${missing} missing.`,
    "",
  ];
  for (const g of [...new Set(records.map((r) => r.group))]) {
    lines.push(`## ${g}`, "", "| Rule | Check | Sent | Came back | Result |", "| --- | --- | --- | --- | --- |");
    for (const r of records.filter((x) => x.group === g)) {
      lines.push(`| ${r.rule} | ${cell(r.check)} | ${cell(r.sent)} | ${cell(r.got)} | ${r.outcome} |`);
    }
    lines.push("");
  }
  lines.push("## Covered by unit tests (listed, not re-run here)", "", "| Rule | File | Test | Found |", "| --- | --- | --- | --- |");
  for (const u of unit) lines.push(`| ${u.rule} | ${u.file} | ${cell(u.test)} | ${u.found ? "yes" : "MISSING"} |`);
  lines.push("", "## Clean-up", "");
  lines.push(typeof deleted === "string" ? deleted : `Deleted the suite's own rows: ${Object.entries(deleted).map(([k, v]) => `${k} ${v}`).join(", ")}. demo_budget.spent_usd is left as is: that money was really spent.`);
  lines.push("");
  const dir = `${REPO_ROOT}docs/security/checks`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/run-${stamp.replaceAll(":", "-")}.md`;
  writeFileSync(file, redact(lines.join("\n")), "utf8");
  // The landing page shows these counts. It imports this file, so they ship with the build instead of
  // being read from docs/ at runtime, where a Vercel deploy of packages/web cannot see them.
  const summary = { ok: count("OK"), broken: count("BROKEN"), pending: count("PENDING"), runAt: stamp, budgetChecks: !opts.skipBudget };
  writeFileSync(`${REPO_ROOT}packages/web/lib/security-summary.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return file;
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString();
  const opts = args();
  const ctx = makeCtx(opts.base, database(loadEnv()), opts.serverLog);
  let deleted: Record<string, number> | string = "not run";
  try {
    await group(ctx, "keys", keys);
    await group(ctx, "access", access);
    await group(ctx, "input", input);
    await group(ctx, "surface", surface);
    if (!opts.skipBudget) await group(ctx, "budget", budget);
  } finally {
    try {
      deleted = await cleanup(ctx);
      console.log(`\nclean-up deleted: ${Object.entries(deleted).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    } catch (err) {
      deleted = `Clean-up failed (${err instanceof Error ? err.name : "error"}); the suite's rows may still be in the database.`;
      console.warn(`\nWARNING: ${deleted}`);
    }
  }

  const unit = unitCoverage();
  ctx.rec.group = "unit tests";
  for (const u of unit) if (!u.found) ctx.rec.add(u.rule, `unit test missing: ${u.test}`, u.file, "not found in the file", false);
  const file = writeRecord(stamp, opts, ctx.rec.records, unit, deleted);
  const broken = ctx.rec.records.filter((r) => r.outcome === "BROKEN");
  const ok = ctx.rec.records.filter((r) => r.outcome === "OK").length;
  const pending = ctx.rec.records.filter((r) => r.outcome === "PENDING").length;
  console.log(`\n${ok} OK, ${broken.length} BROKEN, ${pending} PENDING; ${unit.filter((u) => u.found).length} of ${unit.length} listed unit tests found`);
  for (const b of broken) console.log(`BROKEN ${b.rule} ${b.check}: ${b.got}`);
  console.log(`record: ${file}`);
  process.exitCode = broken.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(redact(`verify-security failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
