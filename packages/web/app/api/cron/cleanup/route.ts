import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CONFIG } from "../../../../lib/config";
import { db } from "../../../../lib/db";
import { cronSecret } from "../../../../lib/env";
import { HttpError, handle, json } from "../../../../lib/http";
import sampleReports from "../../../../lib/sample-reports.json";

// Read like input: a malformed file throws before the statement, so nothing is deleted (C26).
const sampleReportIds = z.array(z.looseObject({ reportId: z.string().min(1) }));

const count = z.number().int().nonnegative();
// What urai_cleanup() returns; anything else is refused as a server error, never shown as a count.
const deletedSchema = z.strictObject({
  workloads: count,
  runs: count,
  caseResults: count,
  demoRuns: count,
  demoCaseResults: count,
  unrunWorkloads: count,
  rateLimits: count,
  budgetDays: count,
});

const ROUTE = "GET /api/cron/cleanup";

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

/**
 * The daily clean-up, called by Vercel Cron (vercel.json) with "Authorization: Bearer <CRON_SECRET>".
 * Any other caller, and every caller while CRON_SECRET is missing or too short, gets 401
 * unauthorized (fail closed, C26). The deletes run inside urai_cleanup() (migration 007), a
 * function owned by the migrating login, so the app's own login holds no DELETE on the tables that
 * carry its limits (C35). One statement, so a failure deletes nothing: the case results, then the
 * runs, then the workloads of every non-sample workload past its retention date; demo runs older
 * than CONFIG.demoRunRetentionDays with their case results; team workloads that never got a run,
 * once older than CONFIG.unrunWorkloadRetentionHours; rate-limit windows older than
 * CONFIG.rateLimitRetentionDays; demo budget days older than CONFIG.demoBudgetRetentionDays.
 * Samples are never deleted. The demo run clean-up never touches a team run, nor any run on a
 * workload behind a report in the kept_reports table.
 * The statement deletes nothing and the route answers 500 internal when a report listed in
 * lib/sample-reports.json is missing from kept_reports, or when urai_retention() disagrees with
 * CONFIG, so a stale table or a changed config can only ever stop the clean-up, never widen it.
 * Returns 200 { deleted: { workloads, runs, caseResults, demoRuns, demoCaseResults, unrunWorkloads,
 * rateLimits, budgetDays } }.
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
    const retention = JSON.stringify({
      demoRunRetentionDays: CONFIG.demoRunRetentionDays,
      unrunWorkloadRetentionHours: CONFIG.unrunWorkloadRetentionHours,
      rateLimitRetentionDays: CONFIG.rateLimitRetentionDays,
      demoBudgetRetentionDays: CONFIG.demoBudgetRetentionDays,
    });
    /*
     * The two checks gate the call in the same statement, so the clean-up cannot run between a
     * check passing and the deletes. A volatile function in the select list runs only for a row
     * the WHERE lets through.
     */
    const rows = await db()`
      SELECT urai_cleanup() AS deleted
      WHERE urai_retention() = ${retention}::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${keptReports}::text[]) AS listed(report_id)
          WHERE listed.report_id NOT IN (SELECT report_id FROM kept_reports))`;
    if (rows[0] === undefined) {
      console.error(`[urai] ${ROUTE}: refused, a listed sample report is missing from kept_reports or urai_retention() differs from CONFIG; nothing deleted`);
      throw new Error("clean-up preconditions failed");
    }
    const deleted = deletedSchema.parse(rows[0].deleted);
    console.info(`[urai] ${ROUTE}: ${JSON.stringify(deleted)}`);
    return json(200, { deleted });
  });
}
