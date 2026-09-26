import { handle, json, requireOwnedRun } from "../../../../../lib/http";
import { ipHash } from "../../../../../lib/ip";
import { enforceRateLimit } from "../../../../../lib/rate";
import { loadReport } from "../../../../../lib/report";

const ROUTE = "GET /api/runs/[id]/report";

/**
 * The run's report for its owner (header x-urai-owner), shared or not. The shape is lib/report.ts
 * Report; it holds no run id, workload id, report id, hash or token (C9).
 * Charged to the same per-address "report" bucket as the public report before any lookup, because
 * it does the same work per read (C31): 429 rate_limited past CONFIG.reportPerIpPerWindow.
 * 404 not_found for a missing or wrong token, an unknown run, or a workload past its retention date.
 */
export const maxDuration = 60;
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(ROUTE, async () => {
    await enforceRateLimit("report", ipHash(req));
    const { id } = await params;
    const run = await requireOwnedRun(req, id, ROUTE);
    return json(200, await loadReport(run));
  });
}
