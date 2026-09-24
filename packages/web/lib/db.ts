import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { databaseUrl } from "./env";

let client: NeonQueryFunction<false, false> | undefined;

/**
 * The shared Neon client, used only as a tagged template so every value is sent as a query
 * parameter and never spliced into SQL text.
 */
export function db(): NeonQueryFunction<false, false> {
  client ??= neon(databaseUrl());
  return client;
}

/**
 * JSON text for a jsonb parameter, or null when any key or string holds a NUL character,
 * which Postgres jsonb cannot store. Checked here so it is refused as bad input, not a server error.
 */
export function toJsonb(value: unknown): string | null {
  let hasNul = false;
  const text = JSON.stringify(value, (key, v: unknown) => {
    if (key.includes("\0") || (typeof v === "string" && v.includes("\0"))) hasNul = true;
    return v;
  });
  return hasNul || text === undefined ? null : text;
}
