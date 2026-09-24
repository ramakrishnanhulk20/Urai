import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isPlausibleKey, type CaseResult, type LintFinding, type RunConfig, type Workload } from "@urai/engine";
import { z } from "zod";
import { OWNER_HEADER } from "../../lib/config";
import { SERV_KEY_HEADER } from "../../lib/http";
import type { ModelListView } from "../../lib/models";
import type { Report } from "../../lib/report";

const ROOT_ENV = fileURLToPath(new URL("../../../../.env", import.meta.url));

// A case call may wait out the engine's 120 s upstream timeout plus the connect retries.
const REQUEST_TIMEOUT_MS = 200_000;
const ERROR_CODE = /^[a-z_]{1,40}$/;

/**
 * A refused or failed call. The message is the status and the server's error code and nothing
 * else, so no header, body or key can reach a log line through it (C1).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status} ${code}`);
    this.name = "ApiError";
  }
}

/**
 * The operator's SERV key, read once from the repo root .env with process.loadEnvFile. The caller
 * holds it in memory and passes it only as the x-serv-key header; it is never printed, logged or
 * written (C1). Throws, naming the variable and never its value, when it is missing or implausible.
 */
export function loadOperatorKey(): string {
  process.loadEnvFile(ROOT_ENV);
  const key = process.env.SERV_API_KEY;
  if (!isPlausibleKey(key)) throw new Error("SERV_API_KEY in the root .env is missing or not a plausible key");
  return key;
}

/**
 * The --base argument, default http://localhost:3101. The key rides on these calls, so the base
 * must be https or a loopback address: a plain http host elsewhere would carry it in the clear.
 */
export function baseFromArgs(): string {
  const { values } = parseArgs({ options: { base: { type: "string", default: "http://localhost:3101" } } });
  const url = new URL(values.base);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--base must be https, or http on localhost");
  }
  return url.origin;
}

function errorCode(body: unknown): string {
  const code = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
}

async function request(
  base: string,
  method: "GET" | "POST",
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(new URL(path, base), { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // The error object is dropped unread: an undici cause can describe the request it came from.
    throw new ApiError(0, err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status > 299) throw new ApiError(res.status, errorCode(parsed));
  return { status: res.status, body: parsed };
}

// The server's answers are checked like input before a script acts on them.
function shaped<S extends z.ZodType>(schema: S, status: number, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(status, "bad_response");
  return parsed.data;
}

const runConfig = z.object({ model: z.string(), mode: z.enum(["raw", "plain", "guard", "multipath", "full"]), keepContentFilter: z.boolean().optional() });

const totals = z.object({
  calls: z.number(),
  correct: z.number(),
  accuracy: z.number().nullable(),
  estCostUsd: z.number().nullable(),
});

// Only the parts of a Report the scripts read are checked; the rest passes through untouched.
const reportShape = z.looseObject({
  name: z.string(),
  configs: z.array(runConfig),
  totals: z.array(totals),
  balance: z.object({ before: z.number().nullable(), after: z.number().nullable() }).nullable(),
  cases: z.array(z.looseObject({ id: z.string() })),
});

const caseResultShape = z.looseObject({
  caseId: z.string(),
  status: z.string(),
  correct: z.boolean(),
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }).loose(),
});

export interface WorkloadCreated {
  workloadId: string;
  ownerToken: string;
}

/** POST /api/workloads. Returns the workload id and its owner token. */
export async function createWorkload(base: string, workload: unknown): Promise<WorkloadCreated> {
  const res = await request(base, "POST", "/api/workloads", { body: { workload } });
  return shaped(z.object({ workloadId: z.string(), ownerToken: z.string() }), res.status, res.body);
}

export interface RunCreated {
  runId: string;
  reportId: string;
  ownerToken: string;
  cases: string[];
  configs: RunConfig[];
}

/** POST /api/runs. A team run needs the workload's owner token; a demo run takes none. */
export async function createRun(
  base: string,
  body: { workloadId: string; configs: RunConfig[]; payer: "team" | "demo" },
  workloadOwnerToken?: string,
): Promise<RunCreated> {
  const headers = workloadOwnerToken === undefined ? undefined : { [OWNER_HEADER]: workloadOwnerToken };
  const res = await request(base, "POST", "/api/runs", { headers, body });
  return shaped(
    z.object({ runId: z.string(), reportId: z.string(), ownerToken: z.string(), cases: z.array(z.string()), configs: z.array(runConfig) }),
    res.status,
    res.body,
  );
}

/** The headers a case, balance or report call needs: the run's owner token, and the team key on team runs. */
export function runHeaders(runOwnerToken: string, servKey?: string): Record<string, string> {
  return servKey === undefined ? { [OWNER_HEADER]: runOwnerToken } : { [OWNER_HEADER]: runOwnerToken, [SERV_KEY_HEADER]: servKey };
}

export type CaseOutcome = { status: 200; result: CaseResult } | { status: 202 };

/** POST /api/runs/:id/cases/:caseId?config=n. 200 with the result, or 202 while another call holds it. */
export async function runCase(base: string, runId: string, caseId: string, configIdx: number, headers: Record<string, string>): Promise<CaseOutcome> {
  const path = `/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}?config=${configIdx}`;
  const res = await request(base, "POST", path, { headers });
  if (res.status === 202) return { status: 202 };
  shaped(caseResultShape, res.status, res.body);
  return { status: 200, result: res.body as CaseResult };
}

/** POST /api/runs/:id/balance with the team key. { usd } or { unavailable: true }. */
export async function balance(base: string, runId: string, runOwnerToken: string, servKey: string): Promise<{ usd: number } | { unavailable: true }> {
  const res = await request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/balance`, { headers: runHeaders(runOwnerToken, servKey) });
  return shaped(z.union([z.object({ usd: z.number().finite() }), z.object({ unavailable: z.literal(true) })]), res.status, res.body);
}

/** POST /api/runs/:id/share. Returns the report id the run is now public at. */
export async function share(base: string, runId: string, runOwnerToken: string): Promise<{ reportId: string }> {
  const res = await request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/share`, { headers: runHeaders(runOwnerToken) });
  return shaped(z.object({ reportId: z.string() }), res.status, res.body);
}

/** GET /api/runs/:id/report for the run's owner. */
export async function report(base: string, runId: string, runOwnerToken: string): Promise<Report> {
  const res = await request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/report`, { headers: runHeaders(runOwnerToken) });
  return shaped(reportShape, res.status, res.body) as unknown as Report;
}

/** GET /api/reports/:reportId, with no header at all, as a stranger with the link would. */
export async function publicReport(base: string, reportId: string): Promise<Report> {
  const res = await request(base, "GET", `/api/reports/${encodeURIComponent(reportId)}`);
  return shaped(reportShape, res.status, res.body) as unknown as Report;
}

export interface LintResult {
  findings: LintFinding[];
  fix: { workload: Workload; moved: { heading: string | null; kind: string; chars: number }[] } | null;
}

/** POST /api/lint. Findings, and the one-click rewrite when a finding is fixable. */
export async function lint(base: string, workload: unknown, configs?: RunConfig[]): Promise<LintResult> {
  const res = await request(base, "POST", "/api/lint", { body: configs === undefined ? { workload } : { workload, configs } });
  const body = shaped(
    z.object({ findings: z.array(z.looseObject({ id: z.string() })), fix: z.looseObject({ workload: z.looseObject({}) }).nullable() }),
    res.status,
    res.body,
  );
  return body as unknown as LintResult;
}

/** GET /api/models. */
export async function models(base: string): Promise<ModelListView> {
  const res = await request(base, "GET", "/api/models");
  return shaped(
    z.object({
      models: z.array(z.object({ id: z.string(), inputUsdPerM: z.number(), outputUsdPerM: z.number() })),
      fetchedAt: z.string().nullable(),
      verified: z.boolean(),
    }),
    res.status,
    res.body,
  );
}

export interface DriveResult {
  caseId: string;
  configIdx: number;
  result: CaseResult;
}

export interface DriveOptions {
  /** Checked before every new call; true stops the drive with stopped "stopped". */
  shouldStop?: () => boolean;
  onResult?: (r: DriveResult) => void;
  waitMs?: number;
  /** Tries per (case, config) before the drive gives up on it. */
  maxAttempts?: number;
}

export interface DriveSummary {
  results: DriveResult[];
  stopped: "budget_exhausted" | "stopped" | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls every (case, config) pair of a run, concurrency at a time. A 202, a 429 run_busy and a lost
 * connection are retried after waitMs: the server's claim makes a repeat return the stored result
 * instead of spending again (C5). A 429 budget_exhausted, or shouldStop, stops new calls and the
 * summary says why. Any other refusal stops the drive and is thrown once every call in flight is done.
 */
export async function driveRun(
  base: string,
  run: { runId: string; cases: string[]; configs: RunConfig[] },
  headers: Record<string, string>,
  concurrency = 3,
  opts: DriveOptions = {},
): Promise<DriveSummary> {
  const waitMs = opts.waitMs ?? 1_500;
  const maxAttempts = opts.maxAttempts ?? 200;
  const pairs = run.cases.flatMap((caseId) => run.configs.map((_, configIdx) => ({ caseId, configIdx })));
  const results: DriveResult[] = [];
  let next = 0;
  let stopped: DriveSummary["stopped"] = null;
  let failure: unknown = null;

  const one = async (caseId: string, configIdx: number): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const out = await runCase(base, run.runId, caseId, configIdx, headers);
        if (out.status === 200) {
          const r = { caseId, configIdx, result: out.result };
          results.push(r);
          opts.onResult?.(r);
          return;
        }
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 429 && err.code === "budget_exhausted") {
          stopped = "budget_exhausted";
          return;
        }
        const retryable = (err.status === 429 && err.code === "run_busy") || err.status === 0;
        if (!retryable) throw err;
      }
      await sleep(waitMs);
    }
    throw new ApiError(202, "gave_up");
  };

  const worker = async (): Promise<void> => {
    while (stopped === null && failure === null) {
      if (opts.shouldStop?.() === true) {
        stopped = "stopped";
        return;
      }
      const pair = pairs[next++];
      if (pair === undefined) return;
      try {
        await one(pair.caseId, pair.configIdx);
      } catch (err) {
        failure = err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (failure !== null) throw failure;
  return { results, stopped };
}
