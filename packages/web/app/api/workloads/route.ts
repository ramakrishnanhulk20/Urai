import { parseWorkload } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "../../../lib/config";
import { db, toJsonb } from "../../../lib/db";
import { HttpError, handle, json, readJson } from "../../../lib/http";
import { hashToken, newId, newOwnerToken } from "../../../lib/ids";
import { ipHash } from "../../../lib/ip";
import { enforceRateLimit } from "../../../lib/rate";

const bodySchema = z.strictObject({ workload: z.unknown() });

/**
 * Stores a team's test set.
 * Body: { workload }, checked by the engine's parseWorkload and capped at CONFIG.bodyMaxBytes.
 * Returns 201 { workloadId, ownerToken }. The token is shown once and only its hash is kept.
 * Refuses with 429 rate_limited (per IP hash), 413 body_too_large, 415, 400 invalid_json,
 * invalid_body or invalid_workload. Reasons are not echoed here; POST /api/lint returns the
 * engine's reasons to the sender only, as JSON, never stored, and the frontend must render them
 * as text (C20).
 */
export async function POST(req: Request): Promise<Response> {
  return handle("POST /api/workloads", async () => {
    await enforceRateLimit("workloads", ipHash(req));
    const body = await readJson(req, bodySchema);
    const parsed = parseWorkload(body.workload);
    if (!parsed.ok) throw new HttpError(400, "invalid_workload");
    const data = toJsonb(parsed.workload);
    if (data === null) throw new HttpError(400, "invalid_workload");

    const workloadId = newId();
    const ownerToken = newOwnerToken();
    const sql = db();
    await sql`
      INSERT INTO workloads (id, owner_hash, is_sample, data, expires_at)
      VALUES (${workloadId}, ${hashToken(ownerToken)}, false, ${data}::jsonb,
              now() + make_interval(days => ${CONFIG.workloadRetentionDays}))`;
    return json(201, { workloadId, ownerToken });
  });
}
