import { LIMITS, listModels, type ModelList } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "./config";
import { db, toJsonb } from "./db";
import { operatorServKey } from "./env";
import { HttpError } from "./http";

export interface ModelEntry {
  id: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
}

/** What the model picker and the lint get: the list, when it was fetched, and whether it is current. */
export interface ModelListView {
  models: ModelEntry[];
  /** ISO time of the SERV fetch behind this list; null when there has never been one. */
  fetchedAt: string | null;
  /** True only for a list SERV returned within CONFIG.modelCacheMaxAgeSeconds. */
  verified: boolean;
}

const usdPerM = z.number().nonnegative().finite();

// The cached row is read back as untrusted (trust boundary 3): a row that fails this shape counts as no cache.
const storedModels = z
  .array(z.strictObject({ id: z.string().min(1).max(LIMITS.modelIdMaxChars), inputUsdPerM: usdPerM, outputUsdPerM: usdPerM }))
  .min(1)
  .max(LIMITS.modelsMax);

const cacheRow = z.object({
  models: z.unknown(),
  fetched_at: z.union([z.date(), z.string()]),
  fresh: z.boolean(),
});

interface Cached {
  models: ModelEntry[];
  fetchedAt: string;
  fresh: boolean;
}

function iso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("model cache time is not a date");
  return d.toISOString();
}

/**
 * The cache, or null when there is none usable, plus rowMark: the stored fetched_at of whatever row
 * is there, valid or not, used only to tell whether the row changed since a failed refresh.
 */
async function readCache(): Promise<{ cached: Cached | null; rowMark: string | null }> {
  const rows = await db()`
    SELECT models, fetched_at, fetched_at > now() - make_interval(secs => ${CONFIG.modelCacheMaxAgeSeconds}) AS fresh
    FROM model_cache WHERE id = 1`;
  if (rows[0] === undefined) return { cached: null, rowMark: null };
  const row = cacheRow.safeParse(rows[0]);
  if (!row.success) return { cached: null, rowMark: null };
  const at = row.data.fetched_at;
  const rowMark = at instanceof Date ? String(at.getTime()) : at;
  const models = storedModels.safeParse(row.data.models);
  if (!models.success) {
    console.warn("[urai] model cache row failed validation and is ignored");
    return { cached: null, rowMark };
  }
  return { cached: { models: models.data, fetchedAt: iso(at), fresh: row.data.fresh }, rowMark };
}

/*
 * The last failed refresh in this server instance, with the cache row as it stood then. Held in
 * memory rather than in the row because the row has no column for it. Each instance backs off on
 * its own, so a cold instance may try SERV once more; that costs one free list call, never money.
 */
let lastFailure: { at: number; rowMark: string | null } | null = null;

/* A back-off only describes the row it saw. Once another instance refreshes or clears the row,
 * the next call looks again rather than serving an answer about a row that no longer exists. */
function backingOff(rowMark: string | null): boolean {
  if (lastFailure === null || lastFailure.rowMark !== rowMark) return false;
  const age = Date.now() - lastFailure.at;
  return age >= 0 && age < CONFIG.modelFailureBackoffSeconds * 1000;
}

function unverified(cached: Cached | null): ModelListView {
  return cached === null ? { models: [], fetchedAt: null, verified: false } : { models: cached.models, fetchedAt: cached.fetchedAt, verified: false };
}

async function writeCache(models: ModelEntry[]): Promise<string> {
  const json = toJsonb(models);
  if (json === null) throw new Error("model list is not storable");
  const rows = await db()`
    INSERT INTO model_cache (id, models, fetched_at) VALUES (1, ${json}::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET models = EXCLUDED.models, fetched_at = EXCLUDED.fetched_at
    RETURNING fetched_at`;
  const at = rows[0]?.fetched_at;
  if (!(at instanceof Date) && typeof at !== "string") throw new Error("model cache write returned no time");
  return iso(at);
}

/**
 * SERV's model list for the picker and the lint. A cached list younger than
 * CONFIG.modelCacheMaxAgeSeconds is returned as is. Otherwise the list is fetched with the
 * operator key, which is the only thing sent (C4), and stored. When SERV cannot be read, the
 * last cached list comes back with verified false, or an empty list with verified false when
 * there is none: a list is never invented (C18).
 * After a failed refresh, SERV is not asked again for CONFIG.modelFailureBackoffSeconds while the
 * cache row is unchanged; those calls get the same unverified answer, never verified true (C18).
 * Throws 503 unavailable on any database error (C26); nothing is fetched after a failed read.
 */
export async function getModelList(): Promise<ModelListView> {
  let cached: Cached | null;
  let rowMark: string | null;
  try {
    ({ cached, rowMark } = await readCache());
  } catch {
    console.error("[urai] model cache read failed");
    throw new HttpError(503, "unavailable");
  }
  if (cached?.fresh === true) return { models: cached.models, fetchedAt: cached.fetchedAt, verified: true };
  if (backingOff(rowMark)) return unverified(cached);

  let live: ModelList;
  try {
    live = await listModels(operatorServKey());
  } catch {
    // listModels is documented never to throw; if it does, the list reads as unverified.
    live = { ok: false };
  }
  const models = live.ok ? storedModels.safeParse(live.models) : null;
  if (models === null || !models.success) {
    lastFailure = { at: Date.now(), rowMark };
    console.warn(`[urai] SERV model list unavailable; serving the cached list as unverified, next try in ${CONFIG.modelFailureBackoffSeconds} s`);
    return unverified(cached);
  }
  lastFailure = null;
  let fetchedAt: string;
  try {
    fetchedAt = await writeCache(models.data);
  } catch {
    console.error("[urai] model cache write failed");
    throw new HttpError(503, "unavailable");
  }
  return { models: models.data, fetchedAt, verified: true };
}

/**
 * The cached SERV model list as stored, whatever its age, or null when there is no usable row.
 * Never calls SERV. For pricing (C28): an old price is still a price SERV once charged, and it is
 * only ever used to raise a cost, never to lower one. Throws on a database error.
 */
export async function readCachedModels(): Promise<ModelEntry[] | null> {
  return (await readCache()).cached?.models ?? null;
}

/** The view as the engine's lintWorkload takes it: an unverified list is { ok:false }, never a partial one (C18). */
export function toModelList(view: ModelListView): ModelList {
  return view.verified ? { ok: true, models: view.models } : { ok: false };
}
