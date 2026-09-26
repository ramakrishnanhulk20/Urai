/*
 * Calls GET /api/cron/cleanup directly against the real Neon database with rows made for the
 * test, as the owner login; the app login's rights are proved by npm run check-app-role. The
 * route is the real clean-up, so it also removes any real expired rows in this database; a first
 * authorised call clears those so the counts below are exact. Not covered here: Vercel actually
 * calling the route on its schedule, a failure part-way through urai_cleanup() (read in review:
 * one statement, so it rolls back and nothing is deleted), timing of the secret comparison, the
 * real lib/sample-reports.json (replaced here by a one-entry list naming a report made for the
 * test, added to kept_reports), and a run created on an unrun workload in the same instant the
 * clean-up deletes it (read in review: the foreign key fails the whole statement).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as cleanup } from "../app/api/cron/cleanup/route";
import { budgetDay } from "../lib/budget";
import { CONFIG } from "../lib/config";
import { db } from "../lib/db";
import { newId } from "../lib/ids";

const kept = vi.hoisted(() => ({ report: `kept-report-${Math.random().toString(36).slice(2)}` }));
vi.mock("../lib/sample-reports.json", () => ({ default: [{ slug: "test", reportId: kept.report }] }));

// Moves one retention number away from what urai_retention() holds, to prove the route then refuses.
const drift = vi.hoisted(() => ({ on: false }));
vi.mock("../lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/config")>();
  return {
    ...real,
    CONFIG: {
      ...real.CONFIG,
      get demoRunRetentionDays() {
        return real.CONFIG.demoRunRetentionDays + (drift.on ? 1 : 0);
      },
    },
  };
});

const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const DAY_MS = 86_400_000;

const expired = { workload: newId(), run: newId() };
const live = { workload: newId(), run: newId() };
const demo = { sample: `test-sample-${randomBytes(6).toString("hex")}`, oldRun: newId(), recentRun: newId(), oldTeamRun: newId() };
const listed = { workload: newId(), teamRun: newId(), oldDemoRun: newId() };
const unrun = { old: newId(), recent: newId(), oldSample: `test-sample-${randomBytes(6).toString("hex")}` };
const allRuns = [expired.run, live.run, demo.oldRun, demo.recentRun, demo.oldTeamRun, listed.teamRun, listed.oldDemoRun];
const expiredSample = `test-sample-${randomBytes(6).toString("hex")}`;
const buckets = { old: `test-old:${randomBytes(8).toString("hex")}`, recent: `test-recent:${randomBytes(8).toString("hex")}` };
const r = randomBytes(3);
const oldDay = budgetDay(new Date(Date.UTC(1980 + (r[0]! % 10), r[1]! % 12, 1 + (r[2]! % 28), 12)));
const recentDay = budgetDay(new Date(Date.now() + (3000 + (r[0]! % 200)) * DAY_MS));

async function call(authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  const res = await cleanup(new Request(`${BASE}/api/cron/cleanup`, { headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

async function insertWorkload(id: string, sample: boolean, expiresSql: "past" | "future", ageHours = 0) {
  const at = expiresSql === "past" ? new Date(Date.now() - DAY_MS) : new Date(Date.now() + DAY_MS);
  const createdAt = new Date(Date.now() - ageHours * 3_600_000);
  await db()`INSERT INTO workloads (id, owner_hash, is_sample, data, expires_at, size_bytes, created_at)
    VALUES (${id}, 'x', ${sample}, '{}'::json, ${at}, 2, ${createdAt})`;
}

async function insertRun(id: string, workloadId: string, cases: string[], opts: { payer?: "team" | "demo"; ageDays?: number; reportId?: string } = {}) {
  const createdAt = new Date(Date.now() - (opts.ageDays ?? 0) * DAY_MS);
  await db()`INSERT INTO runs (id, workload_id, report_id, owner_hash, payer, configs, created_at)
    VALUES (${id}, ${workloadId}, ${opts.reportId ?? newId()}, 'x', ${opts.payer ?? "team"}, '[]'::jsonb, ${createdAt})`;
  for (const c of cases) {
    await db()`INSERT INTO case_results (run_id, case_id, config_idx, status, finished_at) VALUES (${id}, ${c}, 0, 'scored', now())`;
  }
}

async function exists(table: "workloads" | "runs", id: string): Promise<boolean> {
  const rows = table === "workloads" ? await db()`SELECT 1 FROM workloads WHERE id = ${id}` : await db()`SELECT 1 FROM runs WHERE id = ${id}`;
  return rows.length === 1;
}

beforeAll(async () => {
  vi.stubEnv("CRON_SECRET", SECRET);
  await db()`INSERT INTO kept_reports (report_id) VALUES (${kept.report})`;
  expect((await call(`Bearer ${SECRET}`)).status).toBe(200);

  await insertWorkload(expired.workload, false, "past");
  await insertRun(expired.run, expired.workload, ["c0", "c1"]);
  await insertWorkload(live.workload, false, "future");
  await insertRun(live.run, live.workload, ["c0"]);
  await insertWorkload(expiredSample, true, "past");

  const pastRetention = CONFIG.demoRunRetentionDays + 1;
  await insertWorkload(demo.sample, true, "future");
  await insertRun(demo.oldRun, demo.sample, ["c0", "c1"], { payer: "demo", ageDays: pastRetention });
  await insertRun(demo.recentRun, demo.sample, ["c0"], { payer: "demo", ageDays: CONFIG.demoRunRetentionDays - 1 });
  await insertRun(demo.oldTeamRun, live.workload, ["c0"], { payer: "team", ageDays: pastRetention });
  await insertWorkload(listed.workload, false, "future", CONFIG.unrunWorkloadRetentionHours + 1);
  await insertRun(listed.teamRun, listed.workload, ["c0"], { payer: "team", reportId: kept.report });
  await insertRun(listed.oldDemoRun, listed.workload, ["c0"], { payer: "demo", ageDays: pastRetention });
  // Old enough that the unrun rule is the only one that can take it: its retention date is still ahead.
  const pastUnrun = CONFIG.unrunWorkloadRetentionHours + 1;
  await insertWorkload(unrun.old, false, "future", pastUnrun);
  await insertWorkload(unrun.recent, false, "future", CONFIG.unrunWorkloadRetentionHours - 1);
  await insertWorkload(unrun.oldSample, true, "future", pastUnrun);
  const sql = db();
  await sql`INSERT INTO rate_limits (bucket, window_start, count) VALUES
    (${buckets.old}, now() - make_interval(days => ${CONFIG.rateLimitRetentionDays + 1}), 1),
    (${buckets.recent}, now() - make_interval(days => ${CONFIG.rateLimitRetentionDays - 1}), 1)`;
  await sql`INSERT INTO demo_budget (day, cap_usd) VALUES (${oldDay}::date, 1), (${recentDay}::date, 1)`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${allRuns})`;
  await sql`DELETE FROM runs WHERE id = ANY(${allRuns})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${[expired.workload, live.workload, expiredSample, demo.sample, listed.workload, unrun.old, unrun.recent, unrun.oldSample]})`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${[buckets.old, buckets.recent]})`;
  await sql`DELETE FROM demo_budget WHERE day = ANY(${[oldDay, recentDay]}::date[])`;
  await sql`DELETE FROM kept_reports WHERE report_id = ${kept.report}`;
});

async function nothingDeleted(): Promise<void> {
  expect(await exists("workloads", expired.workload)).toBe(true);
  expect(await exists("runs", expired.run)).toBe(true);
  expect(await exists("runs", demo.oldRun)).toBe(true);
  expect(await exists("workloads", unrun.old)).toBe(true);
  expect(await db()`SELECT 1 FROM rate_limits WHERE bucket = ${buckets.old}`).toHaveLength(1);
  expect(await db()`SELECT 1 FROM demo_budget WHERE day = ${oldDay}::date`).toHaveLength(1);
}

describe("GET /api/cron/cleanup", () => {
  it("refuses every call without the exact secret, and deletes nothing (C26)", async () => {
    for (const auth of [undefined, "", "Bearer", `Bearer ${SECRET}x`, `bearer ${SECRET}`, SECRET, `Bearer ${SECRET.slice(0, -1)}`]) {
      expect(await call(auth)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    }
    expect(await exists("workloads", expired.workload)).toBe(true);
    expect(await exists("runs", expired.run)).toBe(true);
    expect(await exists("runs", demo.oldRun)).toBe(true);
  });

  it("refuses every call, even an empty bearer, while CRON_SECRET is missing or too short", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    for (const auth of [undefined, "Bearer ", "Bearer undefined", "Bearer null", `Bearer ${SECRET}`]) {
      expect((await call(auth)).status).toBe(401);
    }
    const short = "s".repeat(CONFIG.cronSecretMinChars - 1);
    vi.stubEnv("CRON_SECRET", short);
    expect((await call(`Bearer ${short}`)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(await exists("workloads", expired.workload)).toBe(true);
  });

  it("deletes nothing and answers 500 while a listed sample report is missing from kept_reports", async () => {
    await db()`DELETE FROM kept_reports WHERE report_id = ${kept.report}`;
    try {
      expect(await call(`Bearer ${SECRET}`)).toMatchObject({ status: 500, body: { error: "internal" } });
      await nothingDeleted();
    } finally {
      await db()`INSERT INTO kept_reports (report_id) VALUES (${kept.report})`;
    }
  });

  it("deletes nothing and answers 500 when a retention number in CONFIG differs from urai_retention()", async () => {
    drift.on = true;
    try {
      expect(await call(`Bearer ${SECRET}`)).toMatchObject({ status: 500, body: { error: "internal" } });
      await nothingDeleted();
    } finally {
      drift.on = false;
    }
  });

  it("keeps urai_retention() equal to CONFIG and runs as a SECURITY DEFINER function with a fixed search_path", async () => {
    const [retention] = await db()`SELECT urai_retention() AS r`;
    expect(retention!.r).toEqual({
      demoRunRetentionDays: CONFIG.demoRunRetentionDays,
      unrunWorkloadRetentionHours: CONFIG.unrunWorkloadRetentionHours,
      rateLimitRetentionDays: CONFIG.rateLimitRetentionDays,
      demoBudgetRetentionDays: CONFIG.demoBudgetRetentionDays,
    });
    const fns = await db()`
      SELECT proname, prosecdef, proconfig, pg_get_userbyid(proowner) AS owner, has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc WHERE proname IN ('urai_cleanup', 'urai_retention') AND pronamespace = 'public'::regnamespace ORDER BY proname`;
    const owner = String((await db()`SELECT current_user AS u`)[0]!.u);
    expect(fns).toEqual([
      { proname: "urai_cleanup", prosecdef: true, proconfig: ["search_path=pg_catalog, public"], owner, public_exec: false },
      { proname: "urai_retention", prosecdef: false, proconfig: ["search_path=pg_catalog, public"], owner, public_exec: false },
    ]);
  });

  it("deletes the expired team workload with its run and results, old rate windows and old budget days", async () => {
    const r = await call(`Bearer ${SECRET}`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({
      deleted: { workloads: 1, runs: 1, caseResults: 2, demoRuns: 1, demoCaseResults: 2, unrunWorkloads: 1, rateLimits: 1, budgetDays: 1 },
    });

    expect(await exists("workloads", expired.workload)).toBe(false);
    expect(await exists("runs", expired.run)).toBe(false);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${expired.run}`).toHaveLength(0);
    expect(await db()`SELECT bucket FROM rate_limits WHERE bucket = ANY(${[buckets.old, buckets.recent]})`).toEqual([{ bucket: buckets.recent }]);
    const days = await db()`SELECT to_char(day, 'YYYY-MM-DD') AS d FROM demo_budget WHERE day = ANY(${[oldDay, recentDay]}::date[])`;
    expect(days).toEqual([{ d: recentDay }]);
  });

  it("keeps live workloads, their runs and results, and every sample, expired or not", async () => {
    expect(await exists("workloads", live.workload)).toBe(true);
    expect(await exists("runs", live.run)).toBe(true);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${live.run}`).toHaveLength(1);
    expect(await exists("workloads", expiredSample)).toBe(true);
    for (const id of ["sample-invoices-good", "sample-invoices-bad", "sample-invoices-hard"]) {
      expect(await exists("workloads", id)).toBe(true);
    }
    expect(await call(`Bearer ${SECRET}`)).toMatchObject({
      status: 200,
      body: { deleted: { workloads: 0, runs: 0, caseResults: 0, demoRuns: 0, demoCaseResults: 0, unrunWorkloads: 0 } },
    });
  });

  it("deletes a team workload that never got a run once past the unrun retention, and keeps a younger one and any sample", async () => {
    expect(await exists("workloads", unrun.old)).toBe(false);
    expect(await exists("workloads", unrun.recent)).toBe(true);
    expect(await exists("workloads", unrun.oldSample)).toBe(true);
    // Older than the unrun retention too, but it has a run, so only its retention date can remove it.
    expect(await exists("workloads", listed.workload)).toBe(true);
  });

  it("deletes only demo runs past retention, never a team run or a run on a listed sample report's workload", async () => {
    expect(await exists("runs", demo.oldRun)).toBe(false);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${demo.oldRun}`).toHaveLength(0);
    expect(await exists("runs", demo.recentRun)).toBe(true);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${demo.recentRun}`).toHaveLength(1);
    expect(await exists("runs", demo.oldTeamRun)).toBe(true);
    expect(await exists("runs", listed.teamRun)).toBe(true);
    expect(await exists("runs", listed.oldDemoRun)).toBe(true);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${listed.oldDemoRun}`).toHaveLength(1);
    expect(await exists("workloads", demo.sample)).toBe(true);
  });
});
