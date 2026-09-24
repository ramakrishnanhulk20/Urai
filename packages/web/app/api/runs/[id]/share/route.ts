import { db } from "../../../../../lib/db";
import { handle, json, requireOwnedRun } from "../../../../../lib/http";

const ROUTE = "POST /api/runs/[id]/share";

/**
 * Makes the run's report public at its report id (C11). Only the run's owner token in
 * x-urai-owner can do this; a report link alone cannot. No body is read. Sharing twice is harmless.
 * Returns 200 { reportId }. A missing or wrong token, or an unknown run, is 404 not_found.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(ROUTE, async () => {
    const { id } = await params;
    const run = await requireOwnedRun(req, id, ROUTE);
    const rows = await db()`UPDATE runs SET shared = true WHERE id = ${run.id} RETURNING report_id`;
    if (rows[0] === undefined) throw new Error("run vanished while sharing");
    return json(200, { reportId: String(rows[0].report_id) });
  });
}
