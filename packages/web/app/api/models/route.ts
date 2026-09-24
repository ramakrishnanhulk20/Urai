import { handle, json } from "../../../lib/http";
import { getModelList } from "../../../lib/models";

// Reads the database and may call SERV; it must never be rendered once at build time.
export const dynamic = "force-dynamic";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * SERV's model list for the model picker.
 * Returns 200 { models: [{ id, inputUsdPerM, outputUsdPerM }], fetchedAt, verified }. verified is
 * false when SERV could not be read and the list is the last cached one, or empty (C18).
 * 503 unavailable when the cache cannot be read or written (C26).
 */
export async function GET(): Promise<Response> {
  return handle("GET /api/models", async () => json(200, await getModelList()));
}
