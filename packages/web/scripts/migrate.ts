import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@neondatabase/serverless";
import { databaseUrl } from "../lib/env";
import { loadRootEnv } from "../lib/root-env";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
// Any fixed number works; it only has to be the same for every copy of this script.
const MIGRATION_LOCK = 72_401;

/*
 * Applies every file in db/migrations that is not yet in schema_migrations, in name order, each
 * inside its own transaction together with its bookkeeping row. The WebSocket client is used
 * because a migration file holds several statements, which the one-shot HTTP driver cannot send.
 */
async function main(): Promise<void> {
  loadRootEnv();
  const client = new Client(databaseUrl());
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      console.log(`applied ${file}`);
      applied++;
    }
    console.log(applied === 0 ? `nothing to apply (${files.length} already applied)` : `${applied} migration(s) applied`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
