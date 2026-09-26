import { CONFIG } from "./config";
import { db } from "./db";
import { HttpError } from "./http";

/*
 * performance.now() rather than Date.now(): it only moves forward, so a clock change on the
 * server can neither pin a stale reading nor force a read on every request.
 */
let cached: { bytes: number; readAtMs: number } | undefined;

async function databaseBytes(): Promise<number> {
  const now = performance.now();
  if (cached !== undefined && now - cached.readAtMs < CONFIG.dbSizeCacheSeconds * 1000) return cached.bytes;
  let bytes: number;
  try {
    const rows = await db()`SELECT pg_database_size(current_database())::bigint AS bytes`;
    bytes = Number(rows[0]?.bytes);
  } catch {
    console.error("[urai] database size could not be read, request denied");
    throw new HttpError(503, "unavailable");
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    console.error("[urai] database size is not a number, request denied");
    throw new HttpError(503, "unavailable");
  }
  cached = { bytes, readAtMs: now };
  return bytes;
}

/**
 * True when the whole database is above CONFIG.dbSizeStopBytes (C26), read with
 * pg_database_size(current_database()) and kept per server instance for CONFIG.dbSizeCacheSeconds.
 * Only a successful reading is kept. Throws 503 unavailable when the size cannot be read or is not
 * a number, so an unknown size never counts as room (fail closed).
 */
export async function databaseFull(): Promise<boolean> {
  return (await databaseBytes()) > CONFIG.dbSizeStopBytes;
}

/*
 * The daily clean-up deletes old rows, but Postgres keeps the freed space inside its files, so
 * pg_database_size does not fall and the stop would hold for good without a VACUUM FULL.
 */
const FULL_FIX =
  "to clear it, run npm run vacuum in packages/web with the owner login once the daily clean-up has deleted old rows; Postgres files do not shrink until VACUUM FULL";

/**
 * Logs one refusal by the size stop, naming what was refused and the operator's fix, so the log
 * line alone says how to clear it. Carries no request data.
 */
export function logStorageFull(refused: string): void {
  console.error(`[urai] database is over its size stop, ${refused} refused; ${FULL_FIX}`);
}

/**
 * Throws 503 storage_full when databaseFull() is true, before anything new is stored, so the
 * database stops well short of the plan's hard limit, past which every write, the rate counts
 * included, would fail. Throws 503 unavailable when the size cannot be read.
 */
export async function assertStorageRoom(): Promise<void> {
  if (await databaseFull()) {
    logStorageFull("new data");
    throw new HttpError(503, "storage_full");
  }
}
