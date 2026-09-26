import { handle, json } from "../../../lib/http";
import { ipHash } from "../../../lib/ip";
import { getModelList } from "../../../lib/models";
import { enforceRateLimit } from "../../../lib/rate";

// Reads the database and may call SERV; it must never be rendered once at build time.
export const dynamic = "force-dynamic";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * SERV's model list for the model picker.
 * Returns 200 { models: [{ id, inputUsdPerM, outputUsdPerM }], fetchedAt, verified }. verified is
 * false when SERV could not be read and the list is the last cached one, or empty (C18).
 * Charged to the per-address "models" bucket first, since a stale cache makes a read call SERV
 * on the operator key: 429 rate_limited past CONFIG.modelsPerIpPerWindow (C31).
 * 503 unavailable when the cache or the rate counter cannot be read or written (C26).
 */
export async function GET(req: Request): Promise<Response> {
  return handle("GET /api/models", async () => {
    await enforceRateLimit("models", ipHash(req));
    return json(200, await getModelList());
  });
}
