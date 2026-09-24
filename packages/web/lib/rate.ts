import { CONFIG } from "./config";
import { db } from "./db";
import { HttpError } from "./http";

export type RateKind = "workloads" | "runs" | "lint" | "report" | "key_refusals";

// A Record over RateKind, so a kind added without a limit is a compile error.
const LIMIT: Record<RateKind, number> = {
  workloads: CONFIG.workloadsPerIpPerWindow,
  runs: CONFIG.runsPerIpPerWindow,
  lint: CONFIG.lintPerIpPerWindow,
  report: CONFIG.reportPerIpPerWindow,
  key_refusals: CONFIG.keyRefusalsPerIpPerWindow,
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
 * Counts one attempt for this kind and IP hash in the current fixed window and throws 429 once
 * the count passes the limit. One atomic upsert, so concurrent requests cannot both read a stale
 * count. The window start comes from the database clock in UTC, one clock for every instance.
 * If the query fails for any reason, or kind has no limit (only reachable past the type checker),
 * the request is denied with 503 (fail closed, C26).
 */
export async function enforceRateLimit(kind: RateKind, ipHash: string): Promise<void> {
  const limit = limitFor(kind);
  const bucket = `${kind}:${ipHash}`;
  let count: number;
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
      RETURNING count`;
    count = Number(rows[0]?.count);
  } catch {
    console.error(`[urai] rate limit check failed for ${kind}, request denied`);
    throw new HttpError(503, "unavailable");
  }
  if (!Number.isInteger(count)) throw new HttpError(503, "unavailable");
  if (count > limit) {
    console.warn(`[urai] rate limited: ${kind} ${ipHash.slice(0, 12)} count ${count}`);
    throw new HttpError(429, "rate_limited");
  }
}

/**
 * Reads this kind's count for this IP hash in the current window without adding to it, and throws
 * 429 rate_limited once the count has reached the limit. For budgets that are charged after the
 * fact (C33): the caller checks here first and counts with enforceRateLimit only when the costly
 * thing happened. Same window and clock as enforceRateLimit. Any database error, a count that is
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
