import { db } from "../../../../../lib/db";
import { handle, json, requireOwnedRun } from "../../../../../lib/http";

const ROUTE = "POST /api/runs/[id]/unshare";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Makes a shared report private again (C30). Only the run's owner token in x-urai-owner can do
 * this, the same proof sharing needs (C11). No body is read. Unsharing a private report is
 * harmless. From then on GET /api/reports/:reportId answers 404 not_found; sharing again brings
 * the same report id back.
 * Returns 200 { shared: false }. A missing or wrong token, or an unknown run, is 404 not_found.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(ROUTE, async () => {
    const { id } = await params;
    const run = await requireOwnedRun(req, id, ROUTE);
    const rows = await db()`UPDATE runs SET shared = false WHERE id = ${run.id} RETURNING shared`;
    if (rows[0] === undefined) throw new Error("run vanished while unsharing");
    console.info(`[urai] ${ROUTE}: report made private`);
    return json(200, { shared: false });
  });
}
