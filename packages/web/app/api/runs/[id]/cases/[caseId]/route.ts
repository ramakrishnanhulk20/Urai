import { isPlausibleKey, runCase, servUnavailable, type CaseResult, type RunConfig, type Workload } from "@urai/engine";
import { releaseDemoCall, type Reservation, reserveDemoCall, settleDemoCall } from "../../../../../../lib/budget";
import { type CaseKey, claimCase, finishClaim, readFinished, releaseClaim, unfinishedResult } from "../../../../../../lib/claim";
import { CONFIG } from "../../../../../../lib/config";
import { db, toJsonb, wellFormed } from "../../../../../../lib/db";
import { operatorServKey } from "../../../../../../lib/env";
import { HttpError, handle, json, requireOwnedRun, type RunRecord, teamKeyHeader } from "../../../../../../lib/http";
import { ipHash } from "../../../../../../lib/ip";
import { callCostUsd, demoReservationUsd, readLivePrices, settledCostUsd } from "../../../../../../lib/prices";
import { assertUnderRateLimit, enforceRateLimit, type RateKind, refundRateLimit } from "../../../../../../lib/rate";
import { loadWorkload } from "../../../../../../lib/report";
import { canonicalConfigs, configKey } from "../../../../../../lib/run-config";
import { databaseFull, logStorageFull } from "../../../../../../lib/storage";

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

/*
 * jsonb cannot hold NUL or a lone surrogate (half an emoji), and a model can emit either. Each
 * becomes U+FFFD, in strings and in object keys, so a paid call is stored, not lost to a retry
 * that pays again.
 */
function storable(text: string): string {
  return wellFormed(text).replaceAll("\0", "�");
}

function withoutNul(v: unknown): unknown {
  if (typeof v === "string") return storable(v);
  if (Array.isArray(v)) return v.map(withoutNul);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, storable(k), { value: withoutNul(x), enumerable: true, writable: true, configurable: true });
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
  let finished: boolean;
  try {
    finished = await finishClaim(key, mark, result.status, resultJson, costUsd);
  } catch (err) {
    /*
     * The answer is paid for, so one failed save must not lose it. finishClaim only writes while
     * this mark's claim is unfinished, so if the first try did commit, the retry writes nothing,
     * returns false, and the stored row is read back below.
     */
    console.error(`[urai] ${ROUTE}: storing a paid result failed, trying once more (${err instanceof Error ? err.name : "error"})`);
    finished = await finishClaim(key, mark, result.status, resultJson, costUsd);
  }
  if (finished) return json(200, clean);
  const other = await readFinished(key);
  return other.kind === "stored" ? json(200, other.result) : json(202, { status: "in_progress" });
}

/*
 * The two SERV refusals that are decided before any model runs, so no account was billed (C5).
 * 401 is SERV's documented answer to a missing or invalid key; 402 with the engine's
 * insufficient_credits classification is an account with no credit, which SERV decides before any
 * model runs. Any other refusal, 403 included, is undocumented and is stored.
 */
function servRefusal(result: CaseResult): HttpError | null {
  if (result.status !== "upstream_error") return null;
  if (result.httpStatus === 401) return new HttpError(401, "serv_rejected_key");
  if (result.httpStatus === 402 && result.error === "insufficient_credits") return new HttpError(402, "serv_insufficient_credits");
  return null;
}

/*
 * True for a SERV answer in the 4xx range other than 429: SERV looked at the key or the request
 * and turned it down, so the call counts against the address's refusal budget (C33). 401 and 402
 * are released before this is asked; 429 is SERV being busy (servUnavailable), not a refusal.
 */
function servRefused(result: CaseResult): boolean {
  const status = result.httpStatus;
  return result.status === "upstream_error" && status !== null && status >= 400 && status < 500 && status !== 429;
}

// A failed refund leaves one charge too many counted, which only makes the budget stricter.
async function refund(kind: RateKind, callerHash: string, window: number): Promise<void> {
  try {
    await refundRateLimit(kind, callerHash, window);
  } catch (err) {
    console.error(`[urai] ${ROUTE}: ${kind} charge was not refunded (${err instanceof Error ? err.name : "error"})`);
  }
}

/*
 * A call SERV never ran costs no one money, so it is not held against the key or demo budgets,
 * but it still held a function open, so the address's serv_unavailable bucket counts it. Checked
 * before anything is sent: once the bucket is spent the route answers 503 serv_unavailable, which
 * the browser already pauses on, and nothing leaves for SERV.
 */
async function assertServTriesLeft(callerHash: string): Promise<void> {
  try {
    await assertUnderRateLimit("serv_unavailable", callerHash);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) throw new HttpError(503, "serv_unavailable");
    throw err;
  }
}

// The answer is 503 serv_unavailable either way, so a full bucket or a failed count only goes to the log.
async function chargeUnavailable(callerHash: string): Promise<void> {
  try {
    await enforceRateLimit("serv_unavailable", callerHash);
  } catch (err) {
    console.warn(`[urai] ${ROUTE}: serv_unavailable not counted (${err instanceof HttpError ? err.code : "error"})`);
  }
}

async function runTeamCase(w: Workload, key: CaseKey, mark: string, config: RunConfig, teamKey: string, callerHash: string): Promise<Response> {
  /*
   * C33: the refusal is charged before the key leaves, in one atomic count, so concurrent calls
   * from one address can never together send more keys than the budget holds. It is handed back
   * unless SERV answers with a 4xx other than 429.
   */
  let window: number;
  try {
    await assertServTriesLeft(callerHash);
    window = await enforceRateLimit("key_refusals", callerHash);
  } catch (err) {
    await releaseClaim(key, mark);
    throw err;
  }
  let result: CaseResult;
  try {
    result = await runCase(w, key.caseId, config, teamKey);
  } catch {
    // The engine throws only before sending, so nothing was billed, SERV never judged the key, and
    // the team may call again with its refusal charge handed back. The error is dropped unread:
    // its message or code could carry the key into a log line (C1).
    await releaseClaim(key, mark);
    await refund("key_refusals", callerHash, window);
    throw new Error("runCase threw");
  }
  // Nothing reached a model, so nothing is stored and the team may call again. SERV never judged
  // the key, so the refusal charge goes back and the serv_unavailable bucket counts the call.
  if (servUnavailable(result)) {
    await releaseClaim(key, mark);
    await refund("key_refusals", callerHash, window);
    await chargeUnavailable(callerHash);
    throw new HttpError(503, "serv_unavailable");
  }
  // Storing a refusal would lock the case out for good, so it is released and the team can run it
  // again with a corrected key or after a top-up. Its charge stays counted.
  const refusal = servRefusal(result);
  if (refusal !== null) {
    await releaseClaim(key, mark);
    throw refusal;
  }
  // Any other 4xx is stored and keeps its charge; a 2xx, a 5xx or no answer at all is refunded.
  if (!servRefused(result)) await refund("key_refusals", callerHash, window);
  return store(key, mark, result, teamKey, await settledCostUsd(config, result.usage));
}

/*
 * C4 at call time: the run's setting must still be on its sample's allowlist, read now and
 * compared through the same canonicalConfigs and configKey as run creation (C24), so an operator
 * who narrows the allowlist stops older runs too. A missing or malformed allowlist denies.
 */
async function assertStillAllowed(workloadId: string, config: RunConfig): Promise<void> {
  const rows = await db()`SELECT sample_configs FROM workloads WHERE id = ${workloadId} AND is_sample`;
  const allowed = rows[0] === undefined ? null : canonicalConfigs(rows[0].sample_configs);
  if (allowed === null || !allowed.some((c) => configKey(c) === configKey(config))) {
    console.warn(`[urai] ${ROUTE}: demo setting is no longer on the sample's allowlist`);
    throw new HttpError(403, "config_not_allowed");
  }
}

/*
 * C28: SERV holds a system prompt's reasoning graph for 30 days, and the samples were warmed so
 * no demo call pays the one-off graph build, which token counts cannot see. Once that hold may
 * have lapsed, only raw calls (SERV off, so no graph) still run on the operator's money.
 */
function assertPromptsWarm(config: RunConfig): void {
  if (config.mode !== "raw" && Date.now() >= CONFIG.samplePromptsWarmUntilMs) {
    console.warn(`[urai] ${ROUTE}: demo ${config.mode} call refused, the sample prompts may no longer be warm`);
    throw new HttpError(429, "budget_exhausted");
  }
}

// A failed release leaves the estimate reserved, which only makes the day's budget stricter.
async function releaseReservation(reservation: Reservation): Promise<void> {
  try {
    await releaseDemoCall(reservation);
  } catch (err) {
    console.error(`[urai] ${ROUTE}: demo reservation was not released (${err instanceof Error ? err.name : "error"})`);
  }
}

async function runDemoCase(w: Workload, key: CaseKey, mark: string, config: RunConfig, workloadId: string, callerHash: string): Promise<Response> {
  let reservation: Reservation | null;
  // Read once, so the reservation and the settle price the call alike (C28).
  let live: Awaited<ReturnType<typeof readLivePrices>>;
  try {
    await assertStillAllowed(workloadId, config);
    await assertServTriesLeft(callerHash);
    assertPromptsWarm(config);
    // A read-only look first, so a caller already over its hourly demo calls never touches the day's budget row.
    await assertUnderRateLimit("demo_calls", callerHash);
    live = await readLivePrices();
    reservation = await reserveDemoCall(demoReservationUsd(config, live));
  } catch (err) {
    await releaseClaim(key, mark);
    throw err;
  }
  if (reservation === null) {
    await releaseClaim(key, mark);
    throw new HttpError(429, "budget_exhausted");
  }
  /*
   * The address's demo call is charged last, so a call the warm check or the day's budget turns
   * away never uses up one of its hourly calls. A refused charge hands back the reservation and
   * the claim, since nothing was sent.
   */
  let window: number;
  try {
    window = await enforceRateLimit("demo_calls", callerHash);
  } catch (err) {
    await releaseReservation(reservation);
    await releaseClaim(key, mark);
    throw err;
  }

  const operatorKey = operatorServKey();
  let result: CaseResult;
  try {
    result = await runCase(w, key.caseId, config, operatorKey, { maxCompletionTokens: CONFIG.demoMaxCompletionTokens });
  } catch {
    // Finished rather than released: a demo call is never tried twice on the operator's money (C5),
    // and the full estimate stays counted as spent.
    const failed = toJsonb(unfinishedResult(key.caseId, config, "internal"));
    if (failed !== null) await finishClaim(key, mark, "upstream_error", failed, null);
    await settleDemoCall(reservation, null);
    throw new Error("runCase threw");
  }
  // SERV never ran this call, so the operator paid nothing: the claim, the reservation and the
  // demo call charge all go back, and the serv_unavailable bucket counts the call instead.
  if (servUnavailable(result)) {
    await releaseClaim(key, mark);
    await releaseReservation(reservation);
    await refund("demo_calls", callerHash, window);
    await chargeUnavailable(callerHash);
    throw new HttpError(503, "serv_unavailable");
  }
  const costUsd = callCostUsd(config, result.usage, live);
  // A throw from store leaves the estimate reserved, which only makes the day's budget stricter.
  const response = await store(key, mark, result, operatorKey, costUsd);
  // The answer is stored and paid for; failing the request now would only make the caller retry a call that is done.
  try {
    await settleDemoCall(reservation, costUsd);
  } catch (err) {
    console.error(`[urai] ${ROUTE}: demo call stored but not settled, its estimate stays reserved (${err instanceof Error ? err.name : "error"})`);
  }
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
 * spent its key refusal budget this window is refused 429 rate_limited before any claim (C33).
 * A repeat of a finished call returns the stored result and spends nothing, even while the
 * database is full; 202 { status: "in_progress" } while another request holds the claim.
 * 503 storage_full, with nothing claimed, when the database is over CONFIG.dbSizeStopBytes (C26).
 * Only a new claim goes on, for either payer first to 503 serv_unavailable, with nothing sent,
 * once this address has had CONFIG.servUnavailablePerIpPerWindow calls this window that never
 * reached SERV or got SERV's 429.
 * Team call: one refusal is charged to the caller's address before the key is sent (429
 * rate_limited when the budget is already spent, nothing sent or counted) and kept only when SERV
 * answers with a 4xx other than 429; a 2xx, a 5xx or a timeout hands it back (C33). 401
 * serv_rejected_key and 402 serv_insufficient_credits: SERV refused the key or the account has no
 * credit; the claim is released, nothing is stored, the charge stays (C5). Any other 4xx is
 * stored and keeps its charge. An engine that throws before sending hands the charge back too.
 * Demo call, in this order and before the operator key is read, each refusal handing the claim
 * back: 403 config_not_allowed when the run's setting is no longer on the sample's allowlist (C4);
 * 503 serv_unavailable when the serv_unavailable budget above is spent; 429 budget_exhausted for a
 * setting other than raw once CONFIG.samplePromptsWarmUntilMs has passed (C28); 429 rate_limited
 * from a read-only look at the demo_calls count, when this address has already made
 * CONFIG.demoCallsPerIpPerWindow demo calls this window, before the day's budget row is read or
 * written; 429 budget_exhausted when the day's settled demo spend cannot cover one more
 * reservation (C6, C28), the operator stopped the day, or demo_off is set; then the address is
 * charged one demo call, and a 429 rate_limited there, when a parallel call took the last one,
 * hands the reservation back too. The call is capped at CONFIG.demoMaxCompletionTokens output
 * tokens. A demo call SERV refuses is stored like any other answer.
 * Either payer: 503 serv_unavailable when the call never reached SERV or SERV answered 429;
 * nothing is stored, the claim is released, a demo reservation goes back unspent, the key refusal
 * or demo call charge is handed back, and the serv_unavailable bucket counts the call. Any other
 * SERV status or a timeout after sending is stored, since SERV may have billed it (C5).
 * A paid result whose save throws is saved once more before the request fails.
 * 503 unavailable when a budget or rate count or the database size cannot be read or written;
 * 500 internal when the engine throws or a result holds the key (C1).
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
    // A full database takes no new claim (C26), but a finished call is still handed back, since that writes nothing.
    if (await databaseFull()) {
      const done = await readFinished(key);
      if (done.kind === "stored") return json(200, done.result);
      logStorageFull("a new case claim");
      throw new HttpError(503, "storage_full");
    }
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
      : runDemoCase(workload, key, claim.mark, config, run.workloadId, callerHash);
  });
}
