import { db } from "./db";
import { HttpError } from "./http";

/**
 * Server-wide stops, one row per name in app_flags.
 * "probe_ran": a balance probe was billed as a real call somewhere (C7 amended). While it is set,
 * every balance probe and every demo call is refused, because the next probe on the same key
 * would be just as dangerous.
 * The app only ever sets a flag. Clearing one is a deliberate operator action, run by hand after
 * the cause is understood: DELETE FROM app_flags WHERE name = 'probe_ran';
 */
export type FlagName = "probe_ran";

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
