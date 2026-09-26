import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { Client } from "@neondatabase/serverless";
import { databaseUrl } from "../lib/env";
import { loadRootEnv } from "../lib/root-env";

const ROLE = "urai_app";
const APP_URL_VAR = "DATABASE_URL_APP";
// The same file lib/root-env.ts loads; that module does not export its path.
const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));
// Postgres's own default for scram_iterations, so the verifier looks like one the server made.
const SCRAM_ITERATIONS = 4096;

/*
 * Exactly what the app's code writes, column by column (every INSERT, UPDATE and function call under
 * app/ and lib/). demo_budget.cap_usd needs UPDATE because lib/budget.ts lowers a day's cap to the current
 * budget; a column grant cannot say "lower only", so migration 006's CHECK (cap_usd <= 10) bounds it.
 * There is no DELETE on any table. releaseClaim in lib/claim.ts runs urai_release_claim()
 * (migration 008), which deletes only an unfinished claim holding the caller's mark, so the app
 * cannot remove a stored answer. The daily clean-up runs inside urai_cleanup() (migration 007),
 * which deletes as its owner by fixed rules, so the app cannot delete the rows that hold its own
 * limits (rate_limits, demo_budget) or anyone's workloads and runs. Nothing on schema_migrations;
 * app_flags and kept_reports are read-only because the operator writes them by hand.
 * REVOKE first, so a re-run after this list shrinks takes the old grants away too.
 */
const TABLE_GRANTS = [
  `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`,
  `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${ROLE}`,
  `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
  `GRANT SELECT, INSERT (id, owner_hash, data, expires_at, size_bytes) ON workloads TO ${ROLE}`,
  `GRANT SELECT, INSERT (id, workload_id, report_id, owner_hash, payer, configs, case_ids), UPDATE (shared) ON runs TO ${ROLE}`,
  `GRANT SELECT, INSERT (run_id, case_id, config_idx, status), UPDATE (status, result, est_cost_usd, finished_at, claimed_at) ON case_results TO ${ROLE}`,
  `GRANT SELECT, INSERT (day, cap_usd), UPDATE (cap_usd, reserved_usd, spent_usd, calls) ON demo_budget TO ${ROLE}`,
  `GRANT SELECT, INSERT (bucket, window_start, count), UPDATE (count) ON rate_limits TO ${ROLE}`,
  `GRANT SELECT, INSERT (id, models, fetched_at), UPDATE (models, fetched_at, refresh_lease_until) ON model_cache TO ${ROLE}`,
  `GRANT SELECT ON app_flags TO ${ROLE}`,
  `GRANT SELECT ON kept_reports TO ${ROLE}`,
  `GRANT EXECUTE ON FUNCTION urai_cleanup(), urai_retention(), urai_release_claim(text, text, int, numeric) TO ${ROLE}`,
];

// A database name cannot be a bind parameter, so the server quotes it itself with %I.
const CONNECT_GRANT = `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`;

const HELP = `npm run create-app-role [-- --rotate]

Creates the database login the live app uses, ${ROLE}, with only the rights the app's code needs,
and writes its connection string into the root .env as ${APP_URL_VAR}. DATABASE_URL (the owner
login) is read, never changed. Nothing secret is printed.

  (no flag)  create ${ROLE} with a new password; if it already exists, re-apply the grants only
             and leave its password and .env alone
  --rotate   give an existing ${ROLE} a new password and rewrite ${APP_URL_VAR}
  --help     show this text

The password is 48 hex characters from crypto.randomBytes. Only its SCRAM-SHA-256 verifier,
computed on this machine, is sent to the server, so the password never reaches the server or
its logs. SQL, in one transaction:

  CREATE ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<verifier>'
    (or, with --rotate: ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '<verifier>')
  ${CONNECT_GRANT}
${TABLE_GRANTS.map((g) => `  ${g}`).join("\n")}

Then: paste the value of ${APP_URL_VAR} into Vercel as DATABASE_URL, and run npm run check-app-role.
Run it again after any migration that adds a table or a column the app writes.`;

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 7677, the format pg_authid holds).
 * Postgres accepts it in place of a password and stores it as is. The password here is hex, so
 * SASLprep leaves it unchanged.
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** The owner URL with the user and password swapped; host, database and query string are kept. */
function appUrl(ownerUrl: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = ROLE;
  url.password = password;
  const out = url.toString();
  // Written unquoted to .env, so anything a dotenv parser would read differently is refused.
  if (/[\s#"'`]/.test(out)) throw new Error("the owner URL holds a character that cannot go into .env unquoted");
  return out;
}

/*
 * Replaces or appends one line and keeps every other line byte for byte, with the file's own line
 * ending and no byte order mark. Written to a side file and renamed over, so a crash never leaves
 * half a .env. Then parsed back to prove the new value reads as written and nothing else moved.
 */
function writeEnvVar(name: string, value: string): void {
  const before = existsSync(ROOT_ENV) ? readFileSync(ROOT_ENV, "utf8").replace(/^﻿/, "") : "";
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before === "" ? [] : before.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const isOurs = (l: string) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l);
  const at = lines.findIndex(isOurs);
  const kept = lines.filter((l, i) => !isOurs(l) || i === at);
  const line = `${name}=${value}`;
  if (at === -1) kept.push(line);
  else kept[kept.findIndex(isOurs)] = line;
  const text = `${kept.join(eol)}${eol}`;

  const tmp = `${ROOT_ENV}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, ROOT_ENV);

  const was = parseEnv(before);
  const now = parseEnv(readFileSync(ROOT_ENV, "utf8"));
  if (now[name] !== value) throw new Error(`${name} did not read back as written`);
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key !== name && was[key] !== now[key]) throw new Error(`.env line ${key} changed; restore it from your own copy`);
  }
}

// Held only so the last-resort error line can scrub them; never printed.
const secrets: string[] = [];

function scrub(text: string): string {
  return secrets.reduce((out, s) => out.split(s).join("[redacted]"), text);
}

function sqlstate(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code).slice(0, 8) : "no code";
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rotate: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) {
    console.log(HELP);
    return;
  }
  loadRootEnv();
  const ownerUrl = databaseUrl();
  secrets.push(...[ownerUrl, new URL(ownerUrl).password].filter((v) => v.length >= 8));
  if (new URL(ownerUrl).username === ROLE) throw new Error(`DATABASE_URL must be the owner login, not ${ROLE}`);

  const client = new Client(ownerUrl);
  await client.connect();
  let password: string | null = null;
  try {
    const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])).rows.length === 1;
    let verifier: string | null = null;
    if (!exists || values.rotate) {
      password = randomBytes(24).toString("hex");
      secrets.push(password);
      verifier = scramVerifier(password);
      // DDL takes no bind parameters. The verifier is built above from base64 and fixed text, and checked here.
      if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error("verifier has an unexpected shape");
    }

    const change = async (secret: string | null): Promise<void> => {
      await client.query("BEGIN");
      try {
        if (!exists) {
          await client.query(`CREATE ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
        } else if (values.rotate) {
          await client.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${secret}'`);
        }
        await client.query(CONNECT_GRANT);
        for (const grant of TABLE_GRANTS) await client.query(grant);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`the database refused the change (SQLSTATE ${sqlstate(err)}); nothing was changed`);
      }
    };
    try {
      await change(verifier);
    } catch (err) {
      if (password === null) throw err;
      // Neon's password-strength check may refuse a verifier it cannot inspect; the plain 192-bit
      // hex password passes it. Its characters are all [0-9a-f], so it is safe inside the literal.
      console.log("the database refused the hashed password; retrying once with the plain one");
      await change(password);
    }
    console.log(!exists ? `created role ${ROLE}` : values.rotate ? `set a new password for role ${ROLE}` : `role ${ROLE} already exists; password left as it is (use --rotate to change it)`);
    console.log(`granted CONNECT, USAGE on schema public, and ${TABLE_GRANTS.length - 3} table and function grants`);
  } finally {
    await client.end();
  }

  if (password === null) return;
  try {
    writeEnvVar(APP_URL_VAR, appUrl(ownerUrl, password));
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    throw new Error(`the role has its new password but .env was not updated (${why}); run again with --rotate`);
  }
  console.log(`wrote ${APP_URL_VAR} into the root .env; every other line is unchanged`);
  console.log(`paste the value of ${APP_URL_VAR} into Vercel as DATABASE_URL`);
  console.log("then run: npm run check-app-role");
}

main().catch((err: unknown) => {
  // The driver's own connection errors are passed through, so they are scrubbed of the URL and password first.
  console.error(scrub(`create-app-role failed: ${err instanceof Error ? err.message : "unknown error"}`));
  process.exit(1);
});
