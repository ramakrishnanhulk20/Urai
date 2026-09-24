import { type Balance, readBalance } from "@urai/engine";
import { CONFIG } from "./config";
import { db } from "./db";
import { operatorServKey } from "./env";
import { isSet, setFlag } from "./flags";

/**
 * within_cap: the balance was read and the day's realised drop is at or under the cap.
 * stopped: the balance was read and the drop passed the cap, or the day was already stopped.
 * probe_ran: SERV billed the probe as a real call; the global stop is now set (C7).
 * probe_disabled: the global stop was already set, so no probe was sent.
 * probe_limit: the day has used CONFIG.probesPerDayMax operator probes; the day is stopped.
 * unavailable: the balance could not be read; nothing changed.
 */
export type OperatorCheck = "within_cap" | "stopped" | "probe_ran" | "probe_disabled" | "probe_limit" | "unavailable";

const UNAVAILABLE: Balance = { ok: false, reason: "unavailable" };

/** True for the day's settled call counts that read the operator balance: the first call, then every CONFIG.demoOperatorProbeEvery. */
export function isOperatorProbeCall(calls: number): boolean {
  return Number.isInteger(calls) && (calls === 1 || (calls > 0 && calls % CONFIG.demoOperatorProbeEvery === 0));
}

// The probes a day has reached by this call count: one at the first call, one more every demoOperatorProbeEvery.
function probesReached(calls: number): number {
  return calls < 1 ? 0 : 1 + Math.floor(calls / CONFIG.demoOperatorProbeEvery);
}

function stopDay(day: string) {
  return db()`UPDATE demo_budget SET stopped = true WHERE day = ${day}::date`;
}

/**
 * Checks the day's demo spend against the operator's real balance (C28). Reads the operator
 * balance with the engine's free probe (C7). The day's first good reading is stored as
 * balance_start_usd; each later one computes realised = balance_start_usd - balance, and once that
 * passes the day's cap_usd the day is stopped, so reserveDemoCall refuses every later demo call.
 * Realised includes any other use of the operator key that day, which errs towards stopping.
 * A probe SERV ran as a paid call sets the global probe_ran flag and stops the day. An unreadable
 * balance changes nothing. The number of probes per day is capped at CONFIG.probesPerDayMax,
 * derived from the day's call count; past it the day stops, because real spend can no longer be
 * checked (C26). Throws on a database error; the caller has already stored and settled the call.
 */
export async function checkOperatorSpend(day: string): Promise<OperatorCheck> {
  if (await isSet("probe_ran")) return "probe_disabled";
  const sql = db();
  const rows = await sql`SELECT calls, stopped FROM demo_budget WHERE day = ${day}::date`;
  const row = rows[0];
  if (row === undefined) throw new Error("demo budget row missing at the operator check");
  if (row.stopped === true) return "stopped";
  const calls = Number(row.calls);
  if (!Number.isInteger(calls) || calls < 0) throw new Error("demo call count is not a number");
  if (probesReached(calls) > CONFIG.probesPerDayMax) {
    await stopDay(day);
    console.warn(`[urai] operator balance: ${CONFIG.probesPerDayMax} probes used on ${day}, demo stopped for the day`);
    return "probe_limit";
  }

  let balance: Balance;
  try {
    balance = await readBalance(operatorServKey());
  } catch {
    // readBalance is documented never to throw; if it does, no number is guessed (C19).
    balance = UNAVAILABLE;
  }

  if (!balance.ok && balance.reason === "probe_ran") {
    await setFlag("probe_ran", "the operator balance probe was billed as a real call");
    await stopDay(day);
    return "probe_ran";
  }
  if (!balance.ok) {
    console.warn(`[urai] operator balance unavailable on ${day}; demo budget unchanged`);
    return "unavailable";
  }

  // SET reads the old row, so the first reading of the day compares the balance with itself: realised 0.
  const updated = await sql`
    UPDATE demo_budget
    SET balance_start_usd = COALESCE(balance_start_usd, ${balance.usd}::numeric),
        stopped = stopped OR COALESCE(balance_start_usd, ${balance.usd}::numeric) - ${balance.usd}::numeric > cap_usd
    WHERE day = ${day}::date
    RETURNING (balance_start_usd - ${balance.usd}::numeric)::float8 AS realised, cap_usd::float8 AS cap, stopped`;
  const out = updated[0];
  if (out === undefined) throw new Error("demo budget row missing at the operator check");
  if (out.stopped === true) {
    console.error(`[urai] operator balance: realised ${String(out.realised)} USD passed the cap ${String(out.cap)} USD on ${day}; demo stopped for the day`);
    return "stopped";
  }
  console.info(`[urai] operator balance: realised ${String(out.realised)} of ${String(out.cap)} USD on ${day}`);
  return "within_cap";
}
