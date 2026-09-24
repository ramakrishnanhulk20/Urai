import { handle, json, requireSharedRun } from "../../../../lib/http";
import { ipHash } from "../../../../lib/ip";
import { enforceRateLimit } from "../../../../lib/rate";
import { loadReport } from "../../../../lib/report";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * A shared report, looked up by report id alone (C9). Needs no header. A report that was never
 * shared, was taken back with unshare (C30), an unknown id, or a run id used in its place is 404
 * not_found. The shape is the same Report the owner sees, and nothing in it leads back to the run.
 * Rate-limited per client address in the "report" bucket before any lookup, so guessing ids
 * counts too (C31): 429 rate_limited past CONFIG.reportPerIpPerWindow reads in a window.
 * 500 response_too_large when the report passes CONFIG.reportResponseMaxBytes (C29).
 */
export async function GET(req: Request, { params }: { params: Promise<{ reportId: string }> }): Promise<Response> {
  return handle("GET /api/reports/[reportId]", async () => {
    await enforceRateLimit("report", ipHash(req));
    const { reportId } = await params;
    const run = await requireSharedRun(reportId);
    return json(200, await loadReport(run));
  });
}
