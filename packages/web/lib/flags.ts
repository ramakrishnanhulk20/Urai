import { db } from "./db";
import { HttpError } from "./http";

/**
 * Server-wide stops, one row per name in app_flags.
 * "demo_off": the operator's kill switch for the demo (C28). While it is set, every demo call is
 * refused with 429 budget_exhausted before any budget is reserved or the operator key is read.
 * The operator sets and clears it by hand:
 *   INSERT INTO app_flags (name, detail) VALUES ('demo_off', 'why') ON CONFLICT (name) DO NOTHING;
 *   DELETE FROM app_flags WHERE name = 'demo_off';
 */
export type FlagName = "demo_off";

/** True when the flag is set. Throws 503 unavailable when it cannot be read, so callers deny (C26). */
export async function isSet(name: FlagName): Promise<boolean> {
  try {
    const rows = await db()`SELECT 1 AS set FROM app_flags WHERE name = ${name}`;
    return rows[0] !== undefined;
  } catch {
    console.error(`[urai] flag ${name} could not be read, request denied`);
    throw new HttpError(503, "unavailable");
  }
}

/** Sets the flag. Setting it again keeps the first time and detail. detail is our own words, never caller input. */
export async function setFlag(name: FlagName, detail: string): Promise<void> {
  await db()`INSERT INTO app_flags (name, detail) VALUES (${name}, ${detail}) ON CONFLICT (name) DO NOTHING`;
  console.error(`[urai] flag ${name} set: ${detail}`);
}
