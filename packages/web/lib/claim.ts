import type { RunConfig } from "@urai/engine";
import { CONFIG } from "./config";
import { db, toJsonb } from "./db";
import { HttpError } from "./http";

export interface CaseKey {
  runId: string;
  caseId: string;
  configIdx: number;
}

/**
 * claimed: this request holds the claim and may spend. mark identifies this exact claim, so a
 * request whose claim was taken over can never overwrite the new holder's result.
 * stored: the call already finished; its stored result is returned and nothing is spent.
 * in_progress: another request holds a live claim.
 * A run that is already at its cap is not an outcome: claimCase throws 429 run_busy (see busy()).
 */
export type ClaimOutcome = { kind: "claimed"; mark: string } | { kind: "stored"; result: unknown } | { kind: "in_progress" };

const PENDING = "pending";
const IN_PROGRESS: ClaimOutcome = { kind: "in_progress" };

/*
 * Thrown, not returned, so every caller stops before any budget or key logic without having to
 * remember a fourth outcome; handle() in lib/http.ts turns it into 429 { error: "run_busy" }.
 */
function busy(): never {
  console.warn(`[urai] case claim refused: run already has ${CONFIG.concurrentCaseCallsPerRun} calls in flight`);
  throw new HttpError(429, "run_busy");
}

// extract(epoch) as text keeps the microseconds that a JavaScript Date would drop.
const MARK = /^\d{1,12}(\.\d{1,6})?$/;

function claimed(mark: unknown): ClaimOutcome {
  if (typeof mark !== "string" || !MARK.test(mark)) throw new Error("claim mark has an unexpected shape");
  return { kind: "claimed", mark };
}

function stored(result: unknown): ClaimOutcome {
  if (typeof result !== "object" || result === null) throw new Error("finished case has no stored result");
  return { kind: "stored", result };
}

/**
 * The record stored for a call that never produced a result: the request died holding the claim
 * (error "lost") or the engine threw (error "internal"). Unknown numbers stay null, never 0 (C25).
 */
export function unfinishedResult(caseId: string, config: RunConfig, error: "lost" | "internal"): Record<string, unknown> {
  return {
    caseId,
    config,
    status: "upstream_error",
    answer: null,
    answerText: null,
    fieldScores: [],
    correct: false,
    usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
    latencyMs: null,
    finishReason: null,
    servRequestId: null,
    httpStatus: null,
    error,
  };
}

function liveCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("live claim count is not a number");
  return n;
}

/**
 * Claims one (run, case, config) before any money is spent (C5). The first caller wins through
 * one INSERT ... ON CONFLICT DO NOTHING; every other caller gets the stored result or in_progress.
 * A new claim is only made while the run holds fewer than CONFIG.concurrentCaseCallsPerRun live
 * claims (unfinished and younger than CONFIG.claimStaleSeconds); otherwise it throws 429 run_busy
 * with nothing claimed or spent (C26). A repeat of a finished call still gets its stored result,
 * since it spends nothing.
 * A pending claim older than CONFIG.claimStaleSeconds belongs to a request that died. On a team
 * run it may be taken over by one atomic UPDATE under the same cap, because the team pays and
 * may retry (named non-goal C27). On a demo run it is finished as upstream_error "lost" and never
 * spent again, because the dead request may already have been billed to the operator.
 * Throws on any database error; the caller has spent nothing at that point.
 */
export async function claimCase(key: CaseKey, payer: "team" | "demo", config: RunConfig): Promise<ClaimOutcome> {
  const sql = db();
  const { runId, caseId, configIdx } = key;
  /*
   * The cap is a hard one because of the lock. A single INSERT ... WHERE (SELECT count(*)) < cap
   * is not enough: under READ COMMITTED each statement counts from its own snapshot, taken when
   * it starts, and cannot see claims that other requests have not committed yet. Measured on
   * Neon, ten simultaneous single-statement claims on one run all got in, every time. Here the
   * transaction first takes an advisory lock on the run, held until commit, so a run's claims
   * queue behind each other; the INSERT then starts after the lock, takes a fresh snapshot and
   * counts every claim committed before it. The same ten calls got exactly four in, every time.
   * A hashtext collision only makes two runs queue together, never lets a claim through.
   */
  const [, insertRows] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${runId}))`,
    sql`
      WITH live AS (
        SELECT count(*)::int AS n FROM case_results
        WHERE run_id = ${runId} AND finished_at IS NULL
          AND claimed_at > now() - make_interval(secs => ${CONFIG.claimStaleSeconds})),
      ins AS (
        INSERT INTO case_results (run_id, case_id, config_idx, status)
        SELECT ${runId}, ${caseId}, ${configIdx}, ${PENDING}
        WHERE (SELECT n FROM live) < ${CONFIG.concurrentCaseCallsPerRun}
        ON CONFLICT (run_id, case_id, config_idx) DO NOTHING
        RETURNING extract(epoch FROM claimed_at)::text AS mark)
      SELECT (SELECT mark FROM ins) AS mark, (SELECT n FROM live) AS live`,
  ]);
  const insert = insertRows?.[0];
  if (insert === undefined) throw new Error("claim statement returned no row");
  if (insert.mark !== null) return claimed(insert.mark);
  const runBusy = liveCount(insert.live) >= CONFIG.concurrentCaseCallsPerRun;

  const rows = await sql`
    SELECT result, finished_at IS NOT NULL AS finished,
           claimed_at < now() - make_interval(secs => ${CONFIG.claimStaleSeconds}) AS stale
    FROM case_results
    WHERE run_id = ${runId} AND case_id = ${caseId} AND config_idx = ${configIdx}`;
  const row = rows[0];
  // No row: the insert was refused by the cap, or a claim was released between the two statements.
  if (row === undefined) return runBusy ? busy() : IN_PROGRESS;
  if (row.finished === true) return stored(row.result);
  if (row.stale !== true) return IN_PROGRESS;

  if (payer === "team") {
    // A takeover makes a claim live again, so it goes through the same lock and cap as an insert.
    const [, takenRows] = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext(${runId}))`,
      sql`
        WITH live AS (
          SELECT count(*)::int AS n FROM case_results
          WHERE run_id = ${runId} AND finished_at IS NULL
            AND claimed_at > now() - make_interval(secs => ${CONFIG.claimStaleSeconds})),
        taken AS (
          UPDATE case_results SET claimed_at = now()
          WHERE run_id = ${runId} AND case_id = ${caseId} AND config_idx = ${configIdx}
            AND finished_at IS NULL AND claimed_at < now() - make_interval(secs => ${CONFIG.claimStaleSeconds})
            AND (SELECT n FROM live) < ${CONFIG.concurrentCaseCallsPerRun}
          RETURNING extract(epoch FROM claimed_at)::text AS mark)
        SELECT (SELECT mark FROM taken) AS mark, (SELECT n FROM live) AS live`,
    ]);
    const taken = takenRows?.[0];
    if (taken === undefined) throw new Error("takeover statement returned no row");
    if (taken.mark !== null) return claimed(taken.mark);
    return liveCount(taken.live) >= CONFIG.concurrentCaseCallsPerRun ? busy() : IN_PROGRESS;
  }

  const lost = toJsonb(unfinishedResult(caseId, config, "lost"));
  if (lost === null) throw new Error("lost result is not storable");
  const finished = await sql`
    UPDATE case_results SET status = 'upstream_error', result = ${lost}::jsonb, finished_at = now()
    WHERE run_id = ${runId} AND case_id = ${caseId} AND config_idx = ${configIdx}
      AND finished_at IS NULL AND claimed_at < now() - make_interval(secs => ${CONFIG.claimStaleSeconds})
    RETURNING result`;
  if (finished[0] !== undefined) {
    console.warn(`[urai] demo case claim went stale and was finished as lost (config ${configIdx})`);
    return stored(finished[0].result);
  }
  return readFinished(key);
}

/** The stored result when the call has finished, else in_progress. */
export async function readFinished(key: CaseKey): Promise<ClaimOutcome> {
  const rows = await db()`
    SELECT result FROM case_results
    WHERE run_id = ${key.runId} AND case_id = ${key.caseId} AND config_idx = ${key.configIdx}
      AND finished_at IS NOT NULL`;
  return rows[0] === undefined ? IN_PROGRESS : stored(rows[0].result);
}

/**
 * Stores a finished result, only while this request still holds the claim identified by mark.
 * resultJson comes from toJsonb. Returns false when the claim was taken over or finished by
 * another request, in which case nothing is written.
 */
export async function finishClaim(key: CaseKey, mark: string, status: string, resultJson: string, estCostUsd: number | null): Promise<boolean> {
  const rows = await db()`
    UPDATE case_results
    SET status = ${status}, result = ${resultJson}::jsonb, est_cost_usd = ${estCostUsd}::numeric, finished_at = now()
    WHERE run_id = ${key.runId} AND case_id = ${key.caseId} AND config_idx = ${key.configIdx}
      AND finished_at IS NULL AND extract(epoch FROM claimed_at) = ${mark}::numeric
    RETURNING 1 AS ok`;
  return rows[0] !== undefined;
}

/**
 * Drops this request's pending claim, so the case can be called again. Only ever used before any
 * spend. Runs through urai_release_claim() (migration 008), which deletes only an unfinished claim
 * still holding this mark, so the app's login needs no DELETE on case_results and can never remove
 * a stored answer (C35). Returns true when the claim was deleted, false when it had already been
 * finished or taken over. Throws on any database error.
 */
export async function releaseClaim(key: CaseKey, mark: string): Promise<boolean> {
  const rows = await db()`
    SELECT urai_release_claim(${key.runId}, ${key.caseId}, ${key.configIdx}::int, ${mark}::numeric) AS released`;
  return rows[0]?.released === true;
}
