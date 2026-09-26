import { parseArgs } from "node:util";
import { Client } from "@neondatabase/serverless";
import { databaseUrl } from "../lib/env";
import { loadRootEnv } from "../lib/root-env";

// Every table the app reads or writes, the same list create-app-role grants on. Fixed names, never input.
const APP_TABLES = ["case_results", "runs", "workloads", "rate_limits", "demo_budget", "model_cache", "app_flags", "kept_reports"] as const;
const APP_ROLE = "urai_app";

const HELP = `npm run vacuum

Gives the space the daily clean-up freed back to the database, so the size stop (C26, 503
storage_full) clears. Postgres keeps deleted rows' space inside its files, so pg_database_size
does not fall after a delete; VACUUM FULL rewrites each table without that space.

Connects with DATABASE_URL from the root .env, which must be the owner login, not ${APP_ROLE}.
Runs VACUUM FULL on these tables one at a time: ${APP_TABLES.join(", ")}.
Prints the database size before and after. Nothing secret is printed.

Each table is locked while it is rewritten, so calls that touch it wait for a moment. Run it once
the daily clean-up has deleted old rows; it changes no data.`;

function sqlstate(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code).slice(0, 8) : "no code";
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}

async function databaseBytes(client: Client): Promise<number> {
  const rows = (await client.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes")).rows;
  const bytes = Number(rows[0]?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("the database size is not a number");
  return bytes;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { help: { type: "boolean", default: false } } });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  loadRootEnv();
  const url = databaseUrl();
  if (new URL(url).username === APP_ROLE) {
    console.error(`DATABASE_URL must be the owner login, not ${APP_ROLE}: only a table's owner can run VACUUM FULL on it`);
    return 2;
  }

  const client = new Client(url);
  try {
    await client.connect();
  } catch (err) {
    // The driver's message can name the host; the code is enough to act on.
    console.error(`could not connect with DATABASE_URL (SQLSTATE ${sqlstate(err)})`);
    return 1;
  }
  try {
    const before = await databaseBytes(client);
    console.log(`database size before: ${megabytes(before)}`);
    for (const table of APP_TABLES) {
      const started = performance.now();
      // VACUUM refuses to run inside a transaction, and each query here runs on its own.
      await client.query(`VACUUM FULL public.${table}`);
      console.log(`vacuumed ${table} in ${Math.round(performance.now() - started).toLocaleString("en-US")} ms`);
    }
    const after = await databaseBytes(client);
    console.log(`database size after: ${megabytes(after)} (${megabytes(Math.max(0, before - after))} given back)`);
  } finally {
    await client.end();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`vacuum failed (${err instanceof Error ? err.name : "error"} ${sqlstate(err)})`);
    process.exit(1);
  },
);
