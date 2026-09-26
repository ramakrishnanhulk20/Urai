import { parseWorkload } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "../../../lib/config";
import { db, toJsonb } from "../../../lib/db";
import { HttpError, handle, json, readJson, requireJsonRequest } from "../../../lib/http";
import { hashToken, newId, newOwnerToken } from "../../../lib/ids";
import { ipHash } from "../../../lib/ip";
import { enforceRateLimit } from "../../../lib/rate";
import { assertStorageRoom } from "../../../lib/storage";

const bodySchema = z.strictObject({ workload: z.unknown() });

/**
 * Stores a team's test set as json text, so its keys keep the order the team wrote them in.
 * Body: { workload }, checked by the engine's parseWorkload and capped at CONFIG.bodyMaxBytes.
 * Returns 201 { workloadId, ownerToken }. The token is shown once and only its hash is kept.
 * Refuses with 429 rate_limited (per IP hash), 413 body_too_large, 415, 400 invalid_json,
 * invalid_body or invalid_workload, and 503 storage_full when the whole database is over
 * CONFIG.dbSizeStopBytes or the stored, unexpired team workloads plus this one would pass
 * CONFIG.workloadStoreMaxBytes (C26); 503 unavailable when the database size cannot be read. Reasons are not echoed here;
 * POST /api/lint returns the engine's reasons to the sender only, as JSON, never stored, and the
 * frontend must render them as text (C20).
 */
export async function POST(req: Request): Promise<Response> {
  return handle("POST /api/workloads", async () => {
    requireJsonRequest(req);
    await enforceRateLimit("workloads", ipHash(req));
    const body = await readJson(req, bodySchema);
    const parsed = parseWorkload(body.workload);
    if (!parsed.ok) throw new HttpError(400, "invalid_workload");
    const data = toJsonb(parsed.workload);
    if (data === null) throw new HttpError(400, "invalid_workload");

    await assertStorageRoom();

    const workloadId = newId();
    const ownerToken = newOwnerToken();
    /*
     * The size check and the insert are one statement, so nothing is stored when the cap would be
     * passed. Two inserts racing can both see room; the overshoot is at most one body per request
     * in flight, which the gap between the cap and the database's real limit absorbs. is_sample is
     * left to its default of false: the app's database login cannot write it.
     */
    const rows = await db()`
      WITH incoming AS (SELECT ${data}::json AS data)
      INSERT INTO workloads (id, owner_hash, data, expires_at, size_bytes)
      SELECT ${workloadId}, ${hashToken(ownerToken)}, incoming.data,
             now() + make_interval(days => ${CONFIG.workloadRetentionDays}), octet_length(incoming.data::text)
      FROM incoming
      WHERE (SELECT COALESCE(sum(size_bytes), 0) FROM workloads WHERE NOT is_sample AND expires_at > now())
            + octet_length(incoming.data::text) <= ${CONFIG.workloadStoreMaxBytes}
      RETURNING id`;
    if (rows[0] === undefined) {
      console.error("[urai] POST /api/workloads: team workload storage is full, refused");
      throw new HttpError(503, "storage_full");
    }
    return json(201, { workloadId, ownerToken });
  });
}
