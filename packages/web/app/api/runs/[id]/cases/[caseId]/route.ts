import { isPlausibleKey, runCase, type CaseResult, type RunConfig, type Workload } from "@urai/engine";
import { type Reservation, reserveDemoCall, settleDemoCall } from "../../../../../../lib/budget";
import { type CaseKey, claimCase, finishClaim, readFinished, releaseClaim, unfinishedResult } from "../../../../../../lib/claim";
import { toJsonb } from "../../../../../../lib/db";
import { operatorServKey } from "../../../../../../lib/env";
import { HttpError, handle, json, requireOwnedRun, type RunRecord, teamKeyHeader } from "../../../../../../lib/http";
import { ipHash } from "../../../../../../lib/ip";
import { checkOperatorSpend, isOperatorProbeCall } from "../../../../../../lib/operator-balance";
import { settledCostUsd } from "../../../../../../lib/prices";
import { assertUnderRateLimit, enforceRateLimit } from "../../../../../../lib/rate";
import { loadWorkload } from "../../../../../../lib/report";

const ROUTE = "POST /api/runs/[id]/cases/[caseId]";

// One canonical spelling per index: "01", "1.0", "+1" and " 1" are refused, not read as 1.
const CONFIG_INDEX = /^(0|[1-9][0-9]{0,2})$/;

type Payer = { payer: "team"; teamKey: string } | { payer: "demo" };

function configIndex(values: string[], count: number): number {
  const raw = values.length === 1 ? values[0]! : "";
  const idx = CONFIG_INDEX.test(raw) ? Number(raw) : -1;
  if (idx < 0 || idx >= count) throw new HttpError(400, "invalid_config");
  return idx;
}

/*
 * The payer comes from the run row alone (C3). The header only has to agree with it: a team run
 * needs a plausible key, a demo run needs none. A demo run is re-checked against the workload's
 * sample flag before the operator key can be touched (C4); creation already enforced it.
 */
function payerFor(req: Request, run: RunRecord): Payer {
  const key = teamKeyHeader(req);
  if (run.payer === "team" && isPlausibleKey(key)) return { payer: "team", teamKey: key };
  if (run.payer === "demo" && key === null) {
    if (!run.isSample) {
      console.warn(`[urai] ${ROUTE}: demo run on a workload that is not a sample`);
      throw new HttpError(403, "demo_not_allowed");
    }
    return { payer: "demo" };
  }
  console.warn(`[urai] ${ROUTE}: payer_mismatch on a ${run.payer} run`);
  throw new HttpError(400, "payer_mismatch");
}

// jsonb cannot hold NUL, and a model can emit one. It becomes U+FFFD so the call is stored, not lost.
function withoutNul(v: unknown): unknown {
  if (typeof v === "string") return v.replaceAll("\0", "�");
  if (Array.isArray(v)) return v.map(withoutNul);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, k.replaceAll("\0", "�"), { value: withoutNul(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

// Any 16-character piece of the key counts, the same bar the engine's scrub and the security suite use.
const KEY_PIECE_CHARS = 16;

function containsKey(result: CaseResult, spendKey: string): boolean {
  const text = JSON.stringify(result);
  for (const form of [spendKey, JSON.stringify(spendKey).slice(1, -1)]) {
    if (form.length < KEY_PIECE_CHARS) {
      if (text.includes(form)) return true;
      continue;
    }
    for (let i = 0; i + KEY_PIECE_CHARS <= form.length; i++) {
      if (text.includes(form.slice(i, i + KEY_PIECE_CHARS))) return true;
    }
  }
  return false;
}

/*
 * Stores the result under this request's claim and returns it. Behind the engine's own scrubbing,
 * a result that holds the key in any form is refused whole: 500, nothing stored, nothing
 * returned (C1). If another request finished the case first, its stored result wins.
 */
async function store(key: CaseKey, mark: string, result: CaseResult, spendKey: string, costUsd: number | null): Promise<Response> {
  if (containsKey(result, spendKey)) {
    console.error(`[urai] ${ROUTE}: a result held the SERV key and was discarded`);
    throw new HttpError(500, "internal");
  }
  const clean = withoutNul(result);
  const resultJson = toJsonb(clean);
  if (resultJson === null) throw new Error("case result is not storable");
  if (await finishClaim(key, mark, result.status, resultJson, costUsd)) return json(200, clean);
  const other = await readFinished(key);
  return other.kind === "stored" ? json(200, other.result) : json(202, { status: "in_progress" });
}

/*
 * The two SERV refusals that are decided before any model runs, so no account was billed (C5).
 * 401 is SERV's documented answer to a missing or invalid key; 402 with the engine's
 * insufficient_credits classification is an account with no credit, the same pre-model check the
 * balance probe relies on (C7). Any other refusal, 403 included, is undocumented and is stored.
 */
function servRefusal(result: CaseResult): HttpError | null {
  if (result.status !== "upstream_error") return null;
  if (result.httpStatus === 401) return new HttpError(401, "serv_rejected_key");
  if (result.httpStatus === 402 && result.error === "insufficient_credits") return new HttpError(402, "serv_insufficient_credits");
  return null;
}

/*
 * Charges one refusal to the caller's address (C33). The refusal has already happened, so the
 * caller still gets SERV's answer: a 429 here only means the budget just ran out, and the next
 * call is refused up front. A database error is logged by name and does not change the answer.
 */
async function countRefusal(callerHash: string): Promise<void> {
  try {
    await enforceRateLimit("key_refusals", callerHash);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return;
    console.error(`[urai] ${ROUTE}: key refusal was not counted (${err instanceof Error ? err.name : "error"})`);
  }
}

async function runTeamCase(w: Workload, key: CaseKey, mark: string, config: RunConfig, teamKey: string, callerHash: string): Promise<Response> {
  let result: CaseResult;
  try {
    result = await runCase(w, key.caseId, config, teamKey);
  } catch {
    // The engine throws only before sending, so nothing was billed and the team may call again.
    // The error is dropped unread: its message or code could carry the key into a log line (C1).
    await releaseClaim(key, mark);
    throw new Error("runCase threw");
  }
  // Storing a refusal would lock the case out for good, so it is released and the team can run it
  // again with a corrected key or after a top-up. Counted first, so a failed release still costs budget.
  const refusal = servRefusal(result);
  if (refusal !== null) {
    await countRefusal(callerHash);
    await releaseClaim(key, mark);
    throw refusal;
  }
  return store(key, mark, result, teamKey, await settledCostUsd(config, result.usage));
}

/*
 * After a settled demo call: the day's first call and every CONFIG.demoOperatorProbeEvery after it
 * read the operator balance (C28). The call is already stored and settled, so a failure here is
 * logged and the result still goes back; the next reservation reads the same database and fails
 * closed on its own if the database is the problem.
 */
async function afterDemoSettle(day: string, calls: number): Promise<void> {
  if (!isOperatorProbeCall(calls)) return;
  try {
    await checkOperatorSpend(day);
  } catch (err) {
    console.error(`[urai] ${ROUTE}: operator balance check failed (${err instanceof Error ? err.name : "error"})`);
  }
}

async function runDemoCase(w: Workload, key: CaseKey, mark: string, config: RunConfig): Promise<Response> {
  let reservation: Reservation | null;
  try {
    reservation = await reserveDemoCall();
  } catch (err) {
    await releaseClaim(key, mark);
    throw err;
  }
  if (reservation === null) {
    await releaseClaim(key, mark);
    throw new HttpError(429, "budget_exhausted");
  }

  const operatorKey = operatorServKey();
  let result: CaseResult;
  try {
    result = await runCase(w, key.caseId, config, operatorKey);
  } catch {
    // Finished rather than released: a demo call is never tried twice on the operator's money (C5),
    // and the full estimate stays counted as spent.
    const failed = toJsonb(unfinishedResult(key.caseId, config, "internal"));
    if (failed !== null) await finishClaim(key, mark, "upstream_error", failed, null);
    await settleDemoCall(reservation, null);
    throw new Error("runCase threw");
  }
  const costUsd = await settledCostUsd(config, result.usage);
  // A throw from store leaves the estimate reserved, which only makes the day's budget stricter.
  const response = await store(key, mark, result, operatorKey, costUsd);
  const calls = await settleDemoCall(reservation, costUsd);
  await afterDemoSettle(reservation.day, calls);
  return response;
}

// A SERV call may take up to the engine's 120 s timeout plus the claim bookkeeping; the default
// function limit could cut it off mid-call and leave a paid claim unfinished.
export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * Runs one case of a run under one of its settings, at most once (C5).
 * Path: run id and case id. Query: config=<index into the run's settings>. Headers: x-urai-owner
 * (the run's owner token), and x-serv-key (the team's SERV key) on team runs only. No body is read.
 * Checks, in order, before any claim, budget or key logic (C10): the run exists and the owner
 * token matches, else 404 not_found; the case is in the run's case list, else 404 not_found; the
 * config index is one canonical integer inside the run's settings, else 400 invalid_config.
 * Then the header must agree with the run's payer, else 400 payer_mismatch (C3), and a demo run
 * must still be on a sample, else 403 demo_not_allowed (C4). A team call from an address that has
 * spent its key refusal budget this window is refused 429 rate_limited before any claim or SERV
 * call (C33).
 * Returns 200 with the CaseResult, or the stored one on a repeat call; 202 { status: "in_progress" }
 * while another request holds the claim; on a team run, 401 serv_rejected_key when SERV refused
 * the key with 401 and 402 serv_insufficient_credits when SERV refused it for lack of credit, each
 * with the claim released, nothing stored and one refusal counted against the caller's address
 * (C5, C33); a demo call SERV refuses is stored like any other answer. 429 budget_exhausted when
 * the day's demo budget cannot cover one more call (C6), the day was stopped by the real-spend
 * check (C28), or the global probe_ran stop is set (C7); 503 unavailable when the budget or the
 * refusal budget cannot be read or written; 500 internal when the engine throws or a result holds
 * the key (C1).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; caseId: string }> }): Promise<Response> {
  return handle(ROUTE, async () => {
    const { id, caseId } = await params;
    const run = await requireOwnedRun(req, id, ROUTE);
    if (!run.workloadLive || run.caseIds === null || !run.caseIds.includes(caseId)) throw new HttpError(404, "not_found");
    const configIdx = configIndex(new URL(req.url).searchParams.getAll("config"), run.configs.length);
    const config = run.configs[configIdx]!;
    const payer = payerFor(req, run);
    const callerHash = ipHash(req);
    if (payer.payer === "team") await assertUnderRateLimit("key_refusals", callerHash);

    const key: CaseKey = { runId: run.id, caseId, configIdx };
    const claim = await claimCase(key, payer.payer, config);
    if (claim.kind === "stored") return json(200, claim.result);
    if (claim.kind === "in_progress") return json(202, { status: "in_progress" });

    let workload: Workload;
    try {
      workload = await loadWorkload(run.workloadId);
    } catch (err) {
      await releaseClaim(key, claim.mark);
      throw err;
    }
    return payer.payer === "team"
      ? runTeamCase(workload, key, claim.mark, config, payer.teamKey, callerHash)
      : runDemoCase(workload, key, claim.mark, config);
  });
}
