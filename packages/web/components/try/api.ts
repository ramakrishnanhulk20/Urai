import type { DemoConfig, DemoMode } from "./types";

// Must match OWNER_HEADER in lib/config.ts. Copied, not imported, because that file pulls the engine into the browser.
const OWNER_HEADER = "x-urai-owner";

// The server answers 202 or run_busy while a call is still going, so the page waits this long and asks again.
export const RETRY_AFTER_MS = 2_000;
// A demo claim goes stale after 150 s on the server; asking a little past that means a stuck call ends as lost, not as a hang here.
const MAX_WAITS = 90;
const NETWORK_RETRIES = 2;

const STATUSES = ["scored", "failed", "refused", "filtered", "upstream_error", "timeout"] as const;
export type CaseStatus = (typeof STATUSES)[number];

/** The parts of a case result the live grid shows. Everything else in the response is ignored. */
export interface CaseView {
  status: CaseStatus;
  correct: boolean;
  /** The model's verdict field when it is a short string, else null. Shown as plain text only. */
  verdict: string | null;
  latencyMs: number | null;
}

export interface DemoRun {
  runId: string;
  reportId: string;
  ownerToken: string;
  cases: string[];
  configs: DemoConfig[];
}

export type CreateOutcome =
  | { kind: "created"; run: DemoRun }
  | { kind: "rate_limited" }
  | { kind: "refused"; status: number; code: string }
  | { kind: "network" };

export type CaseOutcome =
  | { kind: "result"; view: CaseView }
  | { kind: "budget" }
  /** The run itself is gone or refuses this page: nothing else in it will work either. */
  | { kind: "fatal"; status: number; code: string }
  /** This one call failed; the rest of the run can go on. */
  | { kind: "failed"; code: string };

export type ShareOutcome = { kind: "shared"; reportId: string } | { kind: "failed"; code: string };

const MODES: readonly string[] = ["raw", "plain", "guard", "multipath", "full"] satisfies DemoMode[];

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

function toConfig(v: unknown): DemoConfig | null {
  if (!isRecord(v) || typeof v.model !== "string" || typeof v.mode !== "string" || !MODES.includes(v.mode)) return null;
  return { model: v.model, mode: v.mode as DemoMode, keepContentFilter: v.keepContentFilter === true };
}

/*
 * Every field is checked before the page trusts it: a body that does not have the promised shape
 * is treated as a refusal rather than half-rendered.
 */
function toRun(body: unknown): DemoRun | null {
  if (!isRecord(body)) return null;
  const { runId, reportId, ownerToken, cases, configs } = body;
  if (typeof runId !== "string" || typeof reportId !== "string" || typeof ownerToken !== "string") return null;
  if (!Array.isArray(cases) || !cases.every((c) => typeof c === "string") || cases.length === 0) return null;
  if (!Array.isArray(configs)) return null;
  const parsed = configs.map(toConfig);
  if (parsed.length === 0 || parsed.some((c) => c === null)) return null;
  return { runId, reportId, ownerToken, cases, configs: parsed as DemoConfig[] };
}

function toView(body: unknown): CaseView | null {
  if (!isRecord(body)) return null;
  const status = STATUSES.find((s) => s === body.status);
  if (status === undefined || typeof body.correct !== "boolean") return null;
  const latency = typeof body.latencyMs === "number" && Number.isFinite(body.latencyMs) ? body.latencyMs : null;
  const verdict = isRecord(body.answer) && typeof body.answer.verdict === "string" ? body.answer.verdict.slice(0, 24) : null;
  return { status, correct: body.correct, verdict, latencyMs: latency };
}

/**
 * Starts a demo run on a sample. No SERV key is sent: the operator pays, inside a daily cap.
 * The owner token that comes back is the only way to drive the run, so the caller keeps it for
 * this tab alone (sessionStorage, never localStorage).
 */
export async function createDemoRun(workloadId: string, configs: DemoConfig[]): Promise<CreateOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloadId, configs, payer: "demo" }),
    });
  } catch {
    return { kind: "network" };
  }
  const body = await readBody(res);
  if (res.status === 201) {
    const run = toRun(body);
    return run === null ? { kind: "refused", status: 500, code: "bad_response" } : { kind: "created", run };
  }
  if (res.status === 429) return { kind: "rate_limited" };
  return { kind: "refused", status: res.status, code: errorCode(body) };
}

/**
 * Runs one case under one setting and waits for its answer. 202 in_progress and 429 run_busy are
 * asked again every RETRY_AFTER_MS, which is safe because the server runs each call at most once
 * and hands back the stored answer on a repeat. A dropped connection is asked again for the same
 * reason. 429 budget_exhausted stops the caller.
 */
export async function runDemoCase(run: DemoRun, caseId: string, configIdx: number, signal: AbortSignal): Promise<CaseOutcome> {
  const url = `/api/runs/${encodeURIComponent(run.runId)}/cases/${encodeURIComponent(caseId)}?config=${configIdx}`;
  let waits = 0;
  let networkFails = 0;
  for (;;) {
    if (signal.aborted) return { kind: "failed", code: "stopped" };
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { [OWNER_HEADER]: run.ownerToken }, signal });
    } catch {
      if (signal.aborted) return { kind: "failed", code: "stopped" };
      networkFails += 1;
      if (networkFails > NETWORK_RETRIES) return { kind: "failed", code: "network" };
      await wait(RETRY_AFTER_MS, signal);
      continue;
    }
    const body = await readBody(res);

    if (res.status === 200) {
      const view = toView(body);
      return view === null ? { kind: "failed", code: "bad_response" } : { kind: "result", view };
    }
    const code = errorCode(body);
    if (res.status === 202 || (res.status === 429 && code === "run_busy")) {
      waits += 1;
      if (waits > MAX_WAITS) return { kind: "failed", code: "still_running" };
      await wait(RETRY_AFTER_MS, signal);
      continue;
    }
    if (res.status === 429 && code === "budget_exhausted") return { kind: "budget" };
    if (res.status >= 400 && res.status < 500) return { kind: "fatal", status: res.status, code };
    return { kind: "failed", code };
  }
}

/** Makes the run's report public so /r/<reportId> opens for anyone with the link. Sharing twice is harmless. */
export async function shareRun(run: DemoRun): Promise<ShareOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/share`, {
      method: "POST",
      headers: { [OWNER_HEADER]: run.ownerToken },
    });
  } catch {
    return { kind: "failed", code: "network" };
  }
  const body = await readBody(res);
  if (res.status === 200 && isRecord(body) && typeof body.reportId === "string") return { kind: "shared", reportId: body.reportId };
  return { kind: "failed", code: errorCode(body) };
}

const TOKEN_PREFIX = "urai.demo.owner.";

/*
 * sessionStorage dies with the tab, which is as long as a demo run needs its token (C22). Storage
 * can be switched off or full; the run still works from memory, so a failure here is ignored.
 */
export function rememberOwnerToken(run: DemoRun): void {
  try {
    window.sessionStorage.setItem(TOKEN_PREFIX + run.runId, run.ownerToken);
  } catch {
    /* storage unavailable */
  }
}
