import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { budgetDay } from "../../../../lib/budget";
import { CONFIG } from "../../../../lib/config";
import { db } from "../../../../lib/db";
import { cronSecret } from "../../../../lib/env";
import { HttpError, handle, json } from "../../../../lib/http";
import sampleReports from "../../../../lib/sample-reports.json";

// Read like input: a malformed file throws before the transaction, so nothing is deleted (C26).
const sampleReportIds = z.array(z.looseObject({ reportId: z.string().min(1) }));

const ROUTE = "GET /api/cron/cleanup";
const DAY_MS = 86_400_000;

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/*
 * Both sides are hashed first, so the comparison is constant-time whatever length was sent, and
 * the secret's length is not revealed by an early exit.
 */
function authorized(header: string | null, secret: string | null): boolean {
  if (secret === null || header === null) return false;
  const given = createHash("sha256").update(header, "utf8").digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(given, expected);
}

function count(rows: Record<string, unknown>[]): number {
  const n = Number(rows[0]?.n);
  if (!Number.isInteger(n) || n < 0) throw new Error("cleanup count is not a number");
  return n;
}

/**
 * The daily clean-up, called by Vercel Cron (vercel.json) with "Authorization: Bearer <CRON_SECRET>".
 * Any other caller, and every caller while CRON_SECRET is missing or too short, gets 401
 * unauthorized (fail closed, C26). In one transaction, so a failure deletes nothing: the case
 * results, then the runs, then the workloads of every non-sample workload past its retention date;
 * rate-limit windows older than CONFIG.rateLimitRetentionDays; demo budget days older than
 * CONFIG.demoBudgetRetentionDays; demo runs older than CONFIG.demoRunRetentionDays with their case
 * results. Samples are never deleted. The demo run clean-up never touches a team run, nor any run
 * on a workload behind a report listed in lib/sample-reports.json (the landing page links to them).
 * Returns 200 { deleted: { workloads, runs, caseResults, demoRuns, demoCaseResults, rateLimits, budgetDays } }.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(ROUTE, async () => {
    const secret = cronSecret();
    if (secret === null) console.error(`[urai] ${ROUTE}: CRON_SECRET missing or too short, refused`);
    if (!authorized(req.headers.get("authorization"), secret)) {
      console.warn(`[urai] ${ROUTE}: unauthorized call refused`);
      throw new HttpError(401, "unauthorized");
    }

    const keptReports = sampleReportIds.parse(sampleReports).map((s) => s.reportId);
    const oldestBudgetDay = budgetDay(new Date(Date.now() - CONFIG.demoBudgetRetentionDays * DAY_MS));
    const sql = db();
    /*
     * now() is the transaction's start time, so all three workload deletes use one cut-off, and the
     * two demo deletes, which carry the same condition, pick the same runs.
     */
    const [demoCaseResults, demoRuns, caseResults, runs, workloads, rateLimits, budgetDays] = await sql.transaction([
      sql`
        WITH gone AS (
          DELETE FROM case_results WHERE run_id IN (
            SELECT id FROM runs
            WHERE payer = 'demo' AND created_at < now() - make_interval(days => ${CONFIG.demoRunRetentionDays})
              AND workload_id NOT IN (SELECT workload_id FROM runs WHERE report_id = ANY(${keptReports})))
          RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (
          DELETE FROM runs
          WHERE payer = 'demo' AND created_at < now() - make_interval(days => ${CONFIG.demoRunRetentionDays})
            AND workload_id NOT IN (SELECT workload_id FROM runs WHERE report_id = ANY(${keptReports}))
          RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (
          DELETE FROM case_results WHERE run_id IN (
            SELECT r.id FROM runs r JOIN workloads w ON w.id = r.workload_id
            WHERE w.expires_at <= now() AND NOT w.is_sample)
          RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (
          DELETE FROM runs WHERE workload_id IN (
            SELECT id FROM workloads WHERE expires_at <= now() AND NOT is_sample)
          RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (DELETE FROM workloads WHERE expires_at <= now() AND NOT is_sample RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (
          DELETE FROM rate_limits WHERE window_start < now() - make_interval(days => ${CONFIG.rateLimitRetentionDays})
          RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
      sql`
        WITH gone AS (DELETE FROM demo_budget WHERE day < ${oldestBudgetDay}::date RETURNING 1)
        SELECT count(*)::int AS n FROM gone`,
    ]);
    const deleted = {
      workloads: count(workloads!),
      runs: count(runs!),
      caseResults: count(caseResults!),
      demoRuns: count(demoRuns!),
      demoCaseResults: count(demoCaseResults!),
      rateLimits: count(rateLimits!),
      budgetDays: count(budgetDays!),
    };
    console.info(`[urai] ${ROUTE}: ${JSON.stringify(deleted)}`);
    return json(200, { deleted });
  });
}
