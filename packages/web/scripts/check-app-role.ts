import { parseArgs } from "node:util";
import { Client } from "@neondatabase/serverless";
import { loadRootEnv } from "../lib/root-env";

const ROLE = "urai_app";
const APP_URL_VAR = "DATABASE_URL_APP";
// Postgres's code for "permission denied" and "must be owner".
const DENIED = "42501";
// Fixed ids no real row can have; every statement runs in a transaction that is rolled back anyway.
const PROBE = "check-app-role-probe";
const PROBE_DAY = "2099-12-31";

const HELP = `npm run check-app-role

Connects with ${APP_URL_VAR} from the root .env and proves the app's login can do what the app
does and nothing more. Every statement runs inside a transaction that is rolled back, so nothing
is kept. Prints PASS or FAIL per line and exits 1 on any FAIL, 2 when ${APP_URL_VAR} is missing.

Must work: reads on every app table and the database size, each table's writes in the form the
app sends them, the daily clean-up through urai_cleanup() and the reads that gate it, and
releaseClaim through urai_release_claim(), which must delete an unfinished claim holding its mark
and must leave a finished answer, or a claim under another mark, in place.
Must fail with SQLSTATE ${DENIED}: CREATE TABLE, DROP TABLE runs, SELECT from schema_migrations,
INSERT into app_flags, INSERT into kept_reports, UPDATE workloads SET owner_hash, UPDATE runs SET
payer, DELETE FROM case_results, DELETE FROM demo_budget, DELETE FROM rate_limits, DELETE FROM
workloads, DELETE FROM runs, CREATE ROLE.`;

const PROBE_WORKLOAD = `INSERT INTO workloads (id, owner_hash, data, expires_at, size_bytes) VALUES ('${PROBE}', 'x', '{}'::json, now(), 2)`;
const PROBE_RUN = `INSERT INTO runs (id, workload_id, report_id, owner_hash, payer, configs, case_ids) VALUES ('${PROBE}', '${PROBE}', '${PROBE}', 'x', 'team', '[]'::jsonb, '[]'::jsonb)`;

// Each list runs as one transaction; the later statements lean on rows the earlier ones made.
const ALLOWED: { label: string; statements: string[] }[] = [
  {
    label: "read every app table",
    statements: [
      ...["workloads", "runs", "case_results", "demo_budget", "rate_limits", "model_cache", "app_flags", "kept_reports"].map((t) => `SELECT * FROM ${t} LIMIT 1`),
      // lib/storage.ts reads this before every new claim and workload save.
      "SELECT pg_database_size(current_database())",
    ],
  },
  {
    label: "workloads, runs and case_results: the writes a run makes",
    statements: [
      PROBE_WORKLOAD,
      PROBE_RUN,
      `UPDATE runs SET shared = true WHERE id = '${PROBE}'`,
      `INSERT INTO case_results (run_id, case_id, config_idx, status) VALUES ('${PROBE}', 'c0', 0, 'pending') ON CONFLICT (run_id, case_id, config_idx) DO NOTHING RETURNING claimed_at`,
      `UPDATE case_results SET claimed_at = now(), status = 'scored', result = '{}'::jsonb, est_cost_usd = 0, finished_at = now() WHERE run_id = '${PROBE}'`,
    ],
  },
  {
    label: "demo_budget: open a day, reserve and settle",
    statements: [
      `INSERT INTO demo_budget (day, cap_usd) VALUES ('${PROBE_DAY}'::date, 1) ON CONFLICT (day) DO UPDATE SET cap_usd = LEAST(demo_budget.cap_usd, EXCLUDED.cap_usd)`,
      `UPDATE demo_budget SET reserved_usd = reserved_usd + 0.01 WHERE day = '${PROBE_DAY}'::date AND stopped = false AND spent_usd + reserved_usd + 0.01 <= cap_usd AND NOT EXISTS (SELECT 1 FROM app_flags WHERE name = 'demo_off') RETURNING day`,
      `UPDATE demo_budget SET reserved_usd = reserved_usd - 0.01, spent_usd = spent_usd + 0.001, calls = calls + 1 WHERE day = '${PROBE_DAY}'::date RETURNING calls`,
    ],
  },
  {
    label: "rate_limits: count an attempt under its limit, refund it",
    statements: [
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ('${PROBE}', now(), 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 WHERE rate_limits.count < 60 RETURNING count`,
      `UPDATE rate_limits SET count = greatest(count - 1, 0) WHERE bucket = '${PROBE}'`,
    ],
  },
  {
    label: "the daily clean-up: read its gate, then run urai_cleanup()",
    statements: ["SELECT urai_retention()", "SELECT report_id FROM kept_reports", "SELECT urai_cleanup()"],
  },
  {
    label: "model_cache: take the refresh lease, write a list",
    statements: [
      "UPDATE model_cache SET refresh_lease_until = now() WHERE id = 1 AND (refresh_lease_until IS NULL OR refresh_lease_until <= now())",
      `INSERT INTO model_cache (id, models, fetched_at) VALUES (1, '[]'::jsonb, now()) ON CONFLICT (id) DO UPDATE SET models = EXCLUDED.models, fetched_at = EXCLUDED.fetched_at, refresh_lease_until = NULL RETURNING fetched_at`,
    ],
  },
];

const REFUSED: { label: string; statement: string }[] = [
  { label: "CREATE TABLE", statement: "CREATE TABLE check_app_role_probe (id int)" },
  { label: "DROP TABLE runs", statement: "DROP TABLE runs" },
  { label: "SELECT from schema_migrations", statement: "SELECT * FROM schema_migrations LIMIT 1" },
  { label: "INSERT into app_flags", statement: `INSERT INTO app_flags (name) VALUES ('${PROBE}')` },
  { label: "INSERT into kept_reports", statement: `INSERT INTO kept_reports (report_id) VALUES ('${PROBE}')` },
  { label: "DELETE FROM case_results", statement: `DELETE FROM case_results WHERE run_id = '${PROBE}'` },
  { label: "DELETE FROM demo_budget", statement: `DELETE FROM demo_budget WHERE day = '${PROBE_DAY}'::date` },
  { label: "DELETE FROM rate_limits", statement: `DELETE FROM rate_limits WHERE bucket = '${PROBE}'` },
  { label: "DELETE FROM workloads", statement: `DELETE FROM workloads WHERE id = '${PROBE}'` },
  { label: "DELETE FROM runs", statement: `DELETE FROM runs WHERE id = '${PROBE}'` },
  { label: "UPDATE workloads SET owner_hash", statement: `UPDATE workloads SET owner_hash = owner_hash WHERE id = '${PROBE}'` },
  { label: "UPDATE runs SET payer", statement: `UPDATE runs SET payer = payer WHERE id = '${PROBE}'` },
  { label: "CREATE ROLE", statement: "CREATE ROLE check_app_role_probe" },
];

function sqlstate(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code).slice(0, 8) : "no code";
}

async function inRolledBack(client: Client, statements: string[]): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const s of statements) await client.query(s);
  } finally {
    await client.query("ROLLBACK");
  }
}

interface ReleaseProof {
  wrongMark: unknown;
  released: unknown;
  claimLeft: number;
  finishedReleased: unknown;
  finishedLeft: number;
}

/*
 * urai_release_claim() is the app's only way to delete a case_results row (C35), so its outcome is
 * checked, not only that it runs: an unfinished claim goes under its own mark and stays under any
 * other, and a finished answer stays under its own mark. Rolled back like everything else here.
 */
async function releaseProof(client: Client): Promise<ReleaseProof> {
  const release = "SELECT urai_release_claim($1, $2, 0, $3::numeric) AS released";
  const claim = `INSERT INTO case_results (run_id, case_id, config_idx, status) VALUES ($1, $2, 0, 'pending') RETURNING extract(epoch FROM claimed_at)::text AS mark`;
  const left = "SELECT count(*)::int AS n FROM case_results WHERE run_id = $1 AND case_id = $2";
  await client.query("BEGIN");
  try {
    await client.query(PROBE_WORKLOAD);
    await client.query(PROBE_RUN);
    const mark = String((await client.query<{ mark: string }>(claim, [PROBE, "c0"])).rows[0]?.mark);
    const wrongMark = (await client.query("SELECT urai_release_claim($1, $2, 0, $3::numeric - 1) AS released", [PROBE, "c0", mark])).rows[0]?.released;
    const released = (await client.query(release, [PROBE, "c0", mark])).rows[0]?.released;
    const claimLeft = Number((await client.query<{ n: number }>(left, [PROBE, "c0"])).rows[0]?.n);
    const doneMark = String((await client.query<{ mark: string }>(claim, [PROBE, "c1"])).rows[0]?.mark);
    await client.query(`UPDATE case_results SET status = 'scored', result = '{}'::jsonb, finished_at = now() WHERE run_id = $1 AND case_id = 'c1'`, [PROBE]);
    const finishedReleased = (await client.query(release, [PROBE, "c1", doneMark])).rows[0]?.released;
    const finishedLeft = Number((await client.query<{ n: number }>(left, [PROBE, "c1"])).rows[0]?.n);
    return { wrongMark, released, claimLeft, finishedReleased, finishedLeft };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { help: { type: "boolean", default: false } } });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  loadRootEnv();
  const url = process.env[APP_URL_VAR];
  if (url === undefined || url.trim() === "") {
    console.error(`${APP_URL_VAR} is missing from the root .env; run npm run create-app-role first`);
    return 2;
  }
  if (!/^postgres(ql)?:\/\/\S+$/.test(url)) {
    console.error(`${APP_URL_VAR} is not a postgres URL`);
    return 2;
  }

  let failed = 0;
  const line = (ok: boolean, label: string, detail: string) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
  };

  const client = new Client(url);
  try {
    await client.connect();
  } catch (err) {
    // The driver's message can name the host; the code is enough to act on.
    console.error(`could not connect with ${APP_URL_VAR} (SQLSTATE ${sqlstate(err)})`);
    return 1;
  }
  try {
    const who = String((await client.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u);
    line(who === ROLE, "connected as the app's login", who === ROLE ? ROLE : "a different role, so the checks below prove nothing");
    if (who !== ROLE) return 1;

    for (const a of ALLOWED) {
      try {
        await inRolledBack(client, a.statements);
        line(true, a.label, `${a.statements.length} statement(s) ran, rolled back`);
      } catch (err) {
        line(false, a.label, `refused with SQLSTATE ${sqlstate(err)}`);
      }
    }
    try {
      const p = await releaseProof(client);
      const freed = p.wrongMark === false && p.released === true && p.claimLeft === 0;
      line(freed, "releaseClaim: urai_release_claim() frees an unfinished claim under its own mark only", `other mark ${String(p.wrongMark)}, own mark ${String(p.released)}, rows left ${p.claimLeft}; rolled back`);
      const kept = p.finishedReleased === false && p.finishedLeft === 1;
      line(kept, "releaseClaim: urai_release_claim() leaves a stored answer alone", `returned ${String(p.finishedReleased)}, rows left ${p.finishedLeft}; rolled back`);
    } catch (err) {
      line(false, "releaseClaim: urai_release_claim()", `refused with SQLSTATE ${sqlstate(err)}`);
    }
    for (const r of REFUSED) {
      try {
        await inRolledBack(client, [r.statement]);
        line(false, r.label, "it ran; the login has a right it should not");
      } catch (err) {
        const code = sqlstate(err);
        line(code === DENIED, r.label, code === DENIED ? `refused, SQLSTATE ${DENIED}` : `failed with SQLSTATE ${code}, not ${DENIED}`);
      }
    }
  } finally {
    await client.end();
  }
  console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`check-app-role failed (${err instanceof Error ? err.name : "error"} ${sqlstate(err)})`);
    process.exit(1);
  },
);
