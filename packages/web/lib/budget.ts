import { CONFIG } from "./config";
import { db } from "./db";
import { serverEnv } from "./env";
import { isSet } from "./flags";
import { HttpError } from "./http";

/** A reservation held against one day's demo budget. The day is fixed at reserve time. */
export interface Reservation {
  day: string;
  estimateUsd: number;
}

/**
 * The budget day: the UTC calendar date as YYYY-MM-DD. The one function every reservation and
 * every report of the budget uses (C6, C24), so the window never depends on a server's time zone.
 */
export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const SCALE = 10 ** CONFIG.budgetUsdPlaces;
// Float products such as 0.07 * 10,000 come out a hair above the integer; without this they would round up a whole step.
const FLOAT_SLACK = 1e-9;

/** Rounded up to the column's places, so the stored spend is never below the real one. */
function roundUp(usd: number): number {
  return Math.ceil(usd * SCALE - FLOAT_SLACK) / SCALE;
}

/**
 * Reserves CONFIG.demoCallEstimateUsd from today's demo budget before a demo call (C6).
 * Creates the day's row with the cap from DEMO_DAILY_BUDGET_USD if it is missing (an existing
 * row keeps its cap), then reserves with one conditional UPDATE, so concurrent callers can never
 * together pass the cap on settled spend (C28). Returns null when the budget cannot cover one more
 * estimate, when the operator stopped the day (demo_budget.stopped), or when the operator's global
 * demo_off flag is set; the flag is read before anything is written, and the stop and the flag are
 * also in the UPDATE's own WHERE, so one set mid-request still holds.
 * Throws 503 unavailable on any database error: the call must not go ahead (C26).
 */
export async function reserveDemoCall(): Promise<Reservation | null> {
  const day = budgetDay();
  const est = CONFIG.demoCallEstimateUsd;
  if (await isSet("demo_off")) {
    console.warn(`[urai] demo call refused on ${day}: the demo_off stop is set`);
    return null;
  }
  let rows: Record<string, unknown>[];
  try {
    const sql = db();
    await sql`
      INSERT INTO demo_budget (day, cap_usd) VALUES (${day}::date, ${serverEnv().demoDailyBudgetUsd}::numeric)
      ON CONFLICT (day) DO NOTHING`;
    rows = await sql`
      UPDATE demo_budget SET reserved_usd = reserved_usd + ${est}::numeric
      WHERE day = ${day}::date AND stopped = false AND spent_usd + reserved_usd + ${est}::numeric <= cap_usd
        AND NOT EXISTS (SELECT 1 FROM app_flags WHERE name = 'demo_off')
      RETURNING day`;
  } catch {
    console.error(`[urai] demo budget reserve failed on ${day}, call denied`);
    throw new HttpError(503, "unavailable");
  }
  if (rows[0] === undefined) {
    console.warn(`[urai] demo budget exhausted on ${day}`);
    return null;
  }
  console.info(`[urai] demo budget: reserved ${est} USD on ${day}`);
  return { day, estimateUsd: est };
}

/**
 * Swaps a reservation for the real cost after the call (C6): one UPDATE takes the estimate out of
 * reserved and adds the cost, rounded up, to spent. A null or unusable cost counts as the full
 * estimate. The day is the reservation's own, so a call that spans midnight settles where it
 * reserved. The same UPDATE counts the call, and the day's new call count is returned for the log.
 * Throws 503 unavailable on a database error or a missing row; the reservation then stays
 * counted, which can only make the budget stricter.
 */
export async function settleDemoCall(r: Reservation, costUsd: number | null): Promise<number> {
  const cost = costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : r.estimateUsd;
  const spent = roundUp(cost);
  let rows: Record<string, unknown>[];
  try {
    rows = await db()`
      UPDATE demo_budget
      SET reserved_usd = reserved_usd - ${r.estimateUsd}::numeric, spent_usd = spent_usd + ${spent}::numeric, calls = calls + 1
      WHERE day = ${r.day}::date
      RETURNING calls`;
  } catch {
    console.error(`[urai] demo budget settle failed on ${r.day}, estimate stays reserved`);
    throw new HttpError(503, "unavailable");
  }
  if (rows[0] === undefined) {
    console.error(`[urai] demo budget row for ${r.day} missing at settle`);
    throw new HttpError(503, "unavailable");
  }
  const calls = Number(rows[0].calls);
  if (!Number.isInteger(calls) || calls < 1) throw new HttpError(503, "unavailable");
  console.info(`[urai] demo budget: spent ${spent} USD on ${r.day}, call ${calls} of the day`);
  return calls;
}
