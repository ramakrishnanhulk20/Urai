import { CONFIG } from "./config";
import { db } from "./db";
import { HttpError } from "./http";

export type RateKind = "workloads" | "runs" | "lint" | "report" | "key_refusals" | "demo_calls" | "models" | "serv_unavailable";

// A Record over RateKind, so a kind added without a limit is a compile error.
const LIMIT: Record<RateKind, number> = {
  workloads: CONFIG.workloadsPerIpPerWindow,
  runs: CONFIG.runsPerIpPerWindow,
  lint: CONFIG.lintPerIpPerWindow,
  report: CONFIG.reportPerIpPerWindow,
  key_refusals: CONFIG.keyRefusalsPerIpPerWindow,
  demo_calls: CONFIG.demoCallsPerIpPerWindow,
  models: CONFIG.modelsPerIpPerWindow,
  serv_unavailable: CONFIG.servUnavailablePerIpPerWindow,
};

// A kind with no limit is only reachable past the type checker; it is denied, never waved through (C26).
function limitFor(kind: RateKind): number {
  const limit = Object.hasOwn(LIMIT, kind) ? LIMIT[kind] : undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    console.error("[urai] rate limit has no entry for this kind, request denied");
    throw new HttpError(503, "unavailable");
  }
  return limit;
}

/**
 * Counts one attempt for this kind and IP hash in the current fixed window, unless the window's
 * count has already reached the limit, in which case nothing is counted and it throws 429. One
 * atomic conditional upsert, so concurrent requests cannot both read a stale count, and a refused
 * attempt never adds to the count (so a refund later hands back a real charge, not a refusal).
 * The window start comes from the database clock in UTC, one clock for every instance.
 * Returns the start of the window it charged, in Unix seconds, for refundRateLimit.
 * If the query fails for any reason, or kind has no limit (only reachable past the type checker),
 * the request is denied with 503 (fail closed, C26).
 */
export async function enforceRateLimit(kind: RateKind, ipHash: string): Promise<number> {
  const limit = limitFor(kind);
  const bucket = `${kind}:${ipHash}`;
  let row: Record<string, unknown> | undefined;
  try {
    const sql = db();
    const rows = await sql`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (
        ${bucket},
        to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds}),
        1
      )
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
        WHERE rate_limits.count < ${limit}
      RETURNING count, floor(extract(epoch FROM window_start))::bigint AS window`;
    row = rows[0];
  } catch {
    console.error(`[urai] rate limit check failed for ${kind}, request denied`);
    throw new HttpError(503, "unavailable");
  }
  // No row: the window was already full, so the conditional update counted nothing.
  if (row === undefined) {
    console.warn(`[urai] rate limited: ${kind} ${ipHash.slice(0, 12)} at the limit of ${limit}`);
    throw new HttpError(429, "rate_limited");
  }
  const count = Number(row.count);
  const window = Number(row.window);
  if (!Number.isInteger(count) || !Number.isSafeInteger(window)) throw new HttpError(503, "unavailable");
  // The WHERE above makes this unreachable for any limit of 1 or more; kept so a bad limit still refuses.
  if (count > limit) {
    console.warn(`[urai] rate limited: ${kind} ${ipHash.slice(0, 12)} count ${count}`);
    throw new HttpError(429, "rate_limited");
  }
  return window;
}

/**
 * Hands back one attempt that enforceRateLimit charged, in the window it charged (window is its
 * return value), so a charge taken before an outcome was known can be undone once the outcome
 * turns out not to count (C33: SERV accepted the key). Never takes a count below zero, and does
 * nothing once that window's row is gone. Throws on a database error; the caller logs it and
 * keeps its answer, since a refund that fails only leaves the budget stricter.
 */
export async function refundRateLimit(kind: RateKind, ipHash: string, window: number): Promise<void> {
  const bucket = `${kind}:${ipHash}`;
  await db()`
    UPDATE rate_limits SET count = greatest(count - 1, 0)
    WHERE bucket = ${bucket} AND window_start = to_timestamp(${window})`;
}

/**
 * Reads this kind's count for this IP hash in the current window without adding to it, and throws
 * 429 rate_limited once the count has reached the limit, so a caller whose budget is already
 * spent is refused before it claims anything (C33). Same window and clock as enforceRateLimit. Any database error, a count that is
 * not an integer, or a kind with no limit denies with 503 unavailable (fail closed, C26).
 */
export async function assertUnderRateLimit(kind: RateKind, ipHash: string): Promise<void> {
  const limit = limitFor(kind);
  const bucket = `${kind}:${ipHash}`;
  let count: number;
  try {
    const rows = await db()`
      SELECT count FROM rate_limits
      WHERE bucket = ${bucket}
        AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds})`;
    count = rows[0] === undefined ? 0 : Number(rows[0].count);
  } catch {
    console.error(`[urai] rate limit read failed for ${kind}, request denied`);
    throw new HttpError(503, "unavailable");
  }
  if (!Number.isInteger(count)) throw new HttpError(503, "unavailable");
  if (count >= limit) {
    console.warn(`[urai] rate limited: ${kind} ${ipHash.slice(0, 12)} count ${count}`);
    throw new HttpError(429, "rate_limited");
  }
}
