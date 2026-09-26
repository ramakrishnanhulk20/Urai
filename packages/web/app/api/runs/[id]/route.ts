import { z } from "zod";
import { CONFIG, OWNER_HEADER } from "../../../../lib/config";
import { db } from "../../../../lib/db";
import { HttpError, handle, json } from "../../../../lib/http";
import { isGeneratedId, tokenMatches } from "../../../../lib/ids";
import { canonicalConfigs } from "../../../../lib/run-config";

const resultRowSchema = z.object({
  case_id: z.string(),
  config_idx: z.number().int(),
  status: z.string(),
  finished_at: z.union([z.date(), z.string()]).nullable(),
});

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Run status for the run's owner.
 * Header x-urai-owner must hold the owner token returned when the run was created. A missing or
 * wrong token gets the same 404 not_found as an unknown run, so a stranger learns nothing, not
 * even that the run exists. The report id, workload id and every hash stay server-side (C9).
 * Returns 200 { payer, shared, configs, totalCalls, totals: { [status]: count }, results: [{ caseId,
 * configIdx, status, finishedAt }] }. shared is true while the report is public, so the owner's
 * page can show it; the report id itself is never returned here. Status only: answers are never read or returned here; the
 * report carries them under its own caps (C29). A body over CONFIG.statusResponseMaxBytes is
 * refused with 500 response_too_large rather than sent cut.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle("GET /api/runs/[id]", async () => {
    const { id } = await params;
    if (!isGeneratedId(id)) throw new HttpError(404, "not_found");

    const sql = db();
    const rows = await sql`
      SELECT r.owner_hash, r.payer, r.shared, r.configs, COALESCE(jsonb_array_length(r.case_ids), json_array_length(w.data->'cases')) AS case_count
      FROM runs r JOIN workloads w ON w.id = r.workload_id
      WHERE r.id = ${id}`;
    const run = rows[0];
    if (run === undefined) throw new HttpError(404, "not_found");
    if (!tokenMatches(req.headers.get(OWNER_HEADER), String(run.owner_hash))) {
      console.warn("[urai] GET /api/runs/[id]: run owner token missing or wrong");
      throw new HttpError(404, "not_found");
    }

    if (typeof run.shared !== "boolean") throw new Error("stored run sharing state is not a boolean");
    const configs = canonicalConfigs(run.configs);
    if (configs === null) throw new Error("stored run configs failed validation");
    const caseCount = Number(run.case_count);

    const resultRows = z.array(resultRowSchema).parse(
      await sql`
        SELECT case_id, config_idx, status, finished_at
        FROM case_results
        WHERE run_id = ${id}
        ORDER BY case_id, config_idx`,
    );

    const totals = new Map<string, number>();
    for (const r of resultRows) totals.set(r.status, (totals.get(r.status) ?? 0) + 1);

    const body = {
      payer: run.payer,
      shared: run.shared,
      configs,
      totalCalls: caseCount * configs.length,
      totals: Object.fromEntries(totals),
      results: resultRows.map((r) => ({
        caseId: r.case_id,
        configIdx: r.config_idx,
        status: r.status,
        finishedAt: r.finished_at,
      })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bytes > CONFIG.statusResponseMaxBytes) {
      console.error(`[urai] GET /api/runs/[id]: status of ${bytes} bytes is over the response cap, refused`);
      throw new HttpError(500, "response_too_large");
    }
    return json(200, body);
  });
}
