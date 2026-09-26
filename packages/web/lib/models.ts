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

/*
 * Takes the refresh lease for CONFIG.modelRefreshLeaseSeconds with one conditional UPDATE, so only
 * one instance asks SERV at a time. With no row yet there is nothing to lease, and the first refresh
 * goes ahead unguarded: that happens once per database, costs one free list call per instance at
 * most, and the in-process promise still holds it to one call per instance. A lease is never
 * released on failure; letting it lapse keeps the other instances off SERV during an outage too.
 */
async function takeLease(): Promise<"taken" | "held" | "no_row"> {
  const rows = await db()`
    WITH took AS (
      UPDATE model_cache SET refresh_lease_until = now() + make_interval(secs => ${CONFIG.modelRefreshLeaseSeconds})
      WHERE id = 1 AND (refresh_lease_until IS NULL OR refresh_lease_until <= now())
      RETURNING 1)
    SELECT (SELECT count(*) FROM took)::int AS took, (SELECT count(*) FROM model_cache WHERE id = 1)::int AS present`;
  const took = Number(rows[0]?.took);
  const present = Number(rows[0]?.present);
  if (!Number.isInteger(took) || !Number.isInteger(present)) throw new Error("model cache lease returned no count");
  if (took === 1) return "taken";
  return present === 0 ? "no_row" : "held";
}

async function writeCache(models: ModelEntry[]): Promise<string> {
  const json = toJsonb(models);
  if (json === null) throw new Error("model list is not storable");
  const rows = await db()`
    INSERT INTO model_cache (id, models, fetched_at) VALUES (1, ${json}::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET models = EXCLUDED.models, fetched_at = EXCLUDED.fetched_at, refresh_lease_until = NULL
    RETURNING fetched_at`;
  const at = rows[0]?.fetched_at;
  if (!(at instanceof Date) && typeof at !== "string") throw new Error("model cache write returned no time");
  return iso(at);
}

async function refresh(cached: Cached | null, rowMark: string | null): Promise<ModelListView> {
  let lease: Awaited<ReturnType<typeof takeLease>>;
  try {
    lease = await takeLease();
  } catch {
    console.error("[urai] model cache lease failed");
    throw new HttpError(503, "unavailable");
  }
  // Another instance is asking SERV right now; until it writes, the stale list is all there is.
  if (lease === "held") return unverified(cached);

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

// The refresh this instance is running, so concurrent requests share one SERV call.
let refreshing: Promise<ModelListView> | null = null;

/**
 * SERV's model list for the picker and the lint. A cached list younger than
 * CONFIG.modelCacheMaxAgeSeconds is returned as is. Otherwise the list is fetched with the
 * operator key, which is the only thing sent (C4), and stored. When SERV cannot be read, the
 * last cached list comes back with verified false, or an empty list with verified false when
 * there is none: a list is never invented (C18).
 * One instance refreshes at a time: a refresh first takes model_cache.refresh_lease_until for
 * CONFIG.modelRefreshLeaseSeconds, and while another instance holds it the cached list comes
 * back unverified. Within an instance, requests that arrive during a refresh wait for it and
 * share its answer.
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
  if (refreshing !== null) return refreshing;
  if (backingOff(rowMark)) return unverified(cached);

  const running = refresh(cached, rowMark);
  refreshing = running;
  try {
    return await running;
  } finally {
    if (refreshing === running) refreshing = null;
  }
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
