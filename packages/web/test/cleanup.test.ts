/*
 * Calls GET /api/cron/cleanup directly against the real Neon database with rows made for the
 * test. The route is the real clean-up, so it also removes any real expired rows in this
 * database; a first authorised call clears those so the counts below are exact. Not covered
 * here: Vercel actually calling the route on its schedule, a failure part-way through the
 * transaction (read in review: the transaction rolls back and nothing is deleted), timing
 * of the secret comparison, and the real lib/sample-reports.json (replaced here by a one-entry
 * list naming a report made for the test).
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

const BASE = "http://localhost:3000";
const SECRET = randomBytes(32).toString("hex");
const DAY_MS = 86_400_000;

const expired = { workload: newId(), run: newId() };
const live = { workload: newId(), run: newId() };
const demo = { sample: `test-sample-${randomBytes(6).toString("hex")}`, oldRun: newId(), recentRun: newId(), oldTeamRun: newId() };
const listed = { workload: newId(), teamRun: newId(), oldDemoRun: newId() };
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

async function insertWorkload(id: string, sample: boolean, expiresSql: "past" | "future") {
  const at = expiresSql === "past" ? new Date(Date.now() - DAY_MS) : new Date(Date.now() + DAY_MS);
  await db()`INSERT INTO workloads (id, owner_hash, is_sample, data, expires_at) VALUES (${id}, 'x', ${sample}, '{}'::jsonb, ${at})`;
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
  await insertWorkload(listed.workload, false, "future");
  await insertRun(listed.teamRun, listed.workload, ["c0"], { payer: "team", reportId: kept.report });
  await insertRun(listed.oldDemoRun, listed.workload, ["c0"], { payer: "demo", ageDays: pastRetention });
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
  await sql`DELETE FROM workloads WHERE id = ANY(${[expired.workload, live.workload, expiredSample, demo.sample, listed.workload]})`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${[buckets.old, buckets.recent]})`;
  await sql`DELETE FROM demo_budget WHERE day = ANY(${[oldDay, recentDay]}::date[])`;
});

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

  it("deletes the expired team workload with its run and results, old rate windows and old budget days", async () => {
    const r = await call(`Bearer ${SECRET}`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({ deleted: { workloads: 1, runs: 1, caseResults: 2, demoRuns: 1, demoCaseResults: 2, rateLimits: 1, budgetDays: 1 } });

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
      body: { deleted: { workloads: 0, runs: 0, caseResults: 0, demoRuns: 0, demoCaseResults: 0 } },
    });
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
