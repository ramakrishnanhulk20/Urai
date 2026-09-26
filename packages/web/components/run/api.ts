import type { Report } from "../../lib/report";

// Copied from lib/config.ts and lib/http.ts rather than imported: those files pull the engine and the database into the browser.
const OWNER_HEADER = "x-urai-owner";
const KEY_HEADER = "x-serv-key";

// The server answers 202 or run_busy while another request holds the call, so the page waits this long and asks again.
const RETRY_AFTER_MS = 2_000;
// A claim goes stale on the server after 150 s; asking a little past that ends a stuck call as failed, not as a hang.
const MAX_WAITS = 90;
const NETWORK_RETRIES = 2;

const STATUSES = ["scored", "failed", "refused", "filtered", "upstream_error", "timeout"] as const;
export type CaseStatus = (typeof STATUSES)[number];

/** What the page keeps of one answer, whether it came back live or was read from the report. */
export interface Answer {
  status: CaseStatus;
  correct: boolean;
  answer: Record<string, unknown> | null;
  latencyMs: number | null;
}

export type Fail = { kind: "network" } | { kind: "http"; status: number; code: string } | { kind: "bad_response" };

export type Loaded<T> = { ok: true; value: T } | { ok: false; fail: Fail };

export interface RunStatus {
  payer: "team" | "demo";
  totalCalls: number;
}

export type CaseOutcome =
  | { kind: "answer"; answer: Answer; httpStatus: number | null }
  /** 400 payer_mismatch: the key is missing or not shaped like a SERV key. */
  | { kind: "bad_key" }
  /** 401 serv_rejected_key: SERV refused the key. Nothing was stored, so the call can run again with another key. */
  | { kind: "key_refused" }
  /** 402 serv_insufficient_credits: SERV said the key is out of credit for the call. Nothing was stored, so it runs again after a top-up. */
  | { kind: "no_credit" }
  /** 429 rate_limited: this network has spent its hourly budget of refused keys (C33). Nothing was sent to SERV or stored. */
  | { kind: "refusal_budget" }
  /** 404: the run is gone or this tab's token no longer matches. Nothing else in the run will work. */
  | { kind: "gone" }
  | { kind: "failed"; code: string }
  | { kind: "stopped" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error.slice(0, 40) : "unknown";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = window.setTimeout(done, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      done();
    });
  });
}

function toAnswer(v: unknown): Answer | null {
  if (!isRecord(v)) return null;
  const status = STATUSES.find((s) => s === v.status);
  if (status === undefined || typeof v.correct !== "boolean") return null;
  const latency = typeof v.latencyMs === "number" && Number.isFinite(v.latencyMs) ? v.latencyMs : null;
  return { status, correct: v.correct, answer: isRecord(v.answer) ? v.answer : null, latencyMs: latency };
}

/*
 * The report is checked for the fields this page and the report components walk, so a body of
 * the wrong shape shows as a refusal instead of crashing halfway through a render.
 */
function isReport(v: unknown): v is Report {
  if (!isRecord(v) || typeof v.name !== "string") return false;
  const { configs, totals, cases, disagreements, lint } = v;
  if (!Array.isArray(configs) || configs.length === 0) return false;
  if (!configs.every((c) => isRecord(c) && typeof c.model === "string" && typeof c.mode === "string")) return false;
  if (!Array.isArray(totals) || !Array.isArray(disagreements) || !Array.isArray(lint) || !Array.isArray(cases)) return false;
  return cases.every(
    (c) =>
      isRecord(c) &&
      typeof c.id === "string" &&
      typeof c.input === "string" &&
      isRecord(c.expected) &&
      Array.isArray(c.results) &&
      c.results.length === configs.length &&
      c.results.every((r) => r === null || toAnswer(r) !== null),
  );
}

async function call(method: "GET" | "POST", path: string, headers: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(path, { method, headers, cache: "no-store" });
    return { status: res.status, body: await readBody(res) };
  } catch {
    return null;
  }
}

function runPath(runId: string, rest = ""): string {
  return `/api/runs/${encodeURIComponent(runId)}${rest}`;
}

/** GET /api/runs/:id. Only the payer and the call count are kept; the report carries everything else. */
export async function getStatus(runId: string, token: string): Promise<Loaded<RunStatus>> {
  const r = await call("GET", runPath(runId), { [OWNER_HEADER]: token });
  if (r === null) return { ok: false, fail: { kind: "network" } };
  if (r.status !== 200) return { ok: false, fail: { kind: "http", status: r.status, code: errorCode(r.body) } };
  const b = r.body;
  if (!isRecord(b) || (b.payer !== "team" && b.payer !== "demo") || typeof b.totalCalls !== "number") {
    return { ok: false, fail: { kind: "bad_response" } };
  }
  return { ok: true, value: { payer: b.payer, totalCalls: b.totalCalls } };
}

/** GET /api/runs/:id/report. Works before any call has finished: unfinished answers are null. */
export async function getReport(runId: string, token: string): Promise<Loaded<Report>> {
  const r = await call("GET", runPath(runId, "/report"), { [OWNER_HEADER]: token });
  if (r === null) return { ok: false, fail: { kind: "network" } };
  if (r.status !== 200) return { ok: false, fail: { kind: "http", status: r.status, code: errorCode(r.body) } };
  return isReport(r.body) ? { ok: true, value: r.body } : { ok: false, fail: { kind: "bad_response" } };
}

/**
 * Runs one case under one setting and waits for its answer. The key rides only in the
 * x-serv-key header. A 200 is final and never asked again. 202 in_progress and 429 run_busy are
 * asked again every RETRY_AFTER_MS, and a dropped connection a couple of times, which is safe
 * because the server runs each call at most once and hands back the stored answer on a repeat.
 */
export async function runCase(
  runId: string,
  token: string,
  key: string,
  caseId: string,
  configIdx: number,
  signal: AbortSignal,
): Promise<CaseOutcome> {
  const path = runPath(runId, `/cases/${encodeURIComponent(caseId)}?config=${configIdx}`);
  let waits = 0;
  let networkFails = 0;
  for (;;) {
    if (signal.aborted) return { kind: "stopped" };
    let res: Response;
    try {
      res = await fetch(path, { method: "POST", headers: { [OWNER_HEADER]: token, [KEY_HEADER]: key }, signal, cache: "no-store" });
    } catch {
      if (signal.aborted) return { kind: "stopped" };
      networkFails += 1;
      if (networkFails > NETWORK_RETRIES) return { kind: "failed", code: "network" };
      await wait(RETRY_AFTER_MS, signal);
      continue;
    }
    const body = await readBody(res);

    if (res.status === 200) {
      const answer = toAnswer(body);
      if (answer === null) return { kind: "failed", code: "bad_response" };
      const httpStatus = isRecord(body) && typeof body.httpStatus === "number" ? body.httpStatus : null;
      return { kind: "answer", answer, httpStatus };
    }
    const code = errorCode(body);
    if (res.status === 202 || (res.status === 429 && code === "run_busy")) {
      waits += 1;
      if (waits > MAX_WAITS) return { kind: "failed", code: "still_running" };
      await wait(RETRY_AFTER_MS, signal);
      continue;
    }
    if (res.status === 400 && code === "payer_mismatch") return { kind: "bad_key" };
    if (res.status === 401 && code === "serv_rejected_key") return { kind: "key_refused" };
    if (res.status === 402 && code === "serv_insufficient_credits") return { kind: "no_credit" };
    if (res.status === 429 && code === "rate_limited") return { kind: "refusal_budget" };
    if (res.status === 404) return { kind: "gone" };
    return { kind: "failed", code };
  }
}

export type ShareOutcome = { kind: "shared"; reportId: string } | { kind: "private" } | { kind: "failed"; code: string };

/** POST /api/runs/:id/share. Sharing twice is harmless and returns the same report id. */
export async function shareRun(runId: string, token: string): Promise<ShareOutcome> {
  const r = await call("POST", runPath(runId, "/share"), { [OWNER_HEADER]: token });
  if (r === null) return { kind: "failed", code: "network" };
  if (r.status === 200 && isRecord(r.body) && typeof r.body.reportId === "string") return { kind: "shared", reportId: r.body.reportId };
  return { kind: "failed", code: errorCode(r.body) };
}

/** POST /api/runs/:id/unshare. The public link answers not found from then on. */
export async function unshareRun(runId: string, token: string): Promise<ShareOutcome> {
  const r = await call("POST", runPath(runId, "/unshare"), { [OWNER_HEADER]: token });
  if (r === null) return { kind: "failed", code: "network" };
  if (r.status === 200 && isRecord(r.body) && r.body.shared === false) return { kind: "private" };
  return { kind: "failed", code: errorCode(r.body) };
}

/** A report answer in the shape the live grid uses. */
export function fromReport(result: Report["cases"][number]["results"][number]): Answer | null {
  return result === null ? null : { status: result.status, correct: result.correct, answer: result.answer, latencyMs: result.latencyMs };
}
