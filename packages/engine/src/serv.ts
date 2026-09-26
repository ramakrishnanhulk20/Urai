import { z } from "zod";
import { LIMITS } from "./limits.js";
import { buildRequest } from "./request.js";
import { compileAnswerSchema } from "./schema.js";
import { scoreAnswer } from "./score.js";
import { cutPairSafe, isPlausibleKey, scrubDeep, shortMessage } from "./scrub.js";
import type { CaseResult, RunConfig, Workload } from "./types.js";

/** The only URL a key is ever posted to for inference (C2). Not configurable on purpose. */
export const SERV_CHAT_URL = "https://inference-api.openserv.ai/v1/chat/completions" as const;

/*
 * The two failures where the TCP connection never completed, so not one byte of the request
 * left this machine and a retry cannot bill twice (C5). Everything else, including a reset
 * after sending and any HTTP status, is final.
 */
const CONNECT_FAILURE_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

/** Error codes on err, its cause chain and any AggregateError members (Node's dual-stack connect reports one per address). */
function errorCodes(err: unknown, depth = 0): string[] {
  if (depth > 4 || typeof err !== "object" || err === null) return [];
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes = typeof e.code === "string" && ERROR_CODE.test(e.code) ? [e.code] : [];
  codes.push(...errorCodes(e.cause, depth + 1));
  if (Array.isArray(e.errors)) for (const inner of e.errors.slice(0, 8)) codes.push(...errorCodes(inner, depth + 1));
  return codes;
}

export function isConnectFailure(err: unknown): boolean {
  return errorCodes(err).some((c) => CONNECT_FAILURE_CODES.has(c));
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * reason "connect": every attempt failed before the connection completed, so no byte of the
 * request reached SERV. "network": any other failure without a response, which may have come
 * after the request was sent.
 */
export type Sent = { ok: true; res: Response } | { ok: false; reason: "timeout" | "aborted" | "network" | "connect"; code: string | null };

/**
 * One request with the connect-only retry (C5): up to LIMITS.connectRetriesMax retries,
 * LIMITS.connectRetryBaseMs doubling each time, all inside the caller's signal. redirect
 * "error" means a key can never follow a redirect to another host (C2).
 */
export async function sendWithConnectRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<Sent> {
  const stopped = (): Sent => ({ ok: false, reason: timeoutSignal.aborted ? "timeout" : "aborted", code: null });
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, res: await fetchImpl(url, { ...init, redirect: "error", signal }) };
    } catch (err) {
      if (signal.aborted) return stopped();
      const connect = isConnectFailure(err);
      if (!connect || attempt >= LIMITS.connectRetriesMax) {
        return { ok: false, reason: connect ? "connect" : "network", code: errorCodes(err)[0] ?? null };
      }
      if (!(await sleep(LIMITS.connectRetryBaseMs * 2 ** attempt, signal))) return stopped();
    }
  }
}

export type BodyRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "read_failed" };

/** Reads at most maxBytes of the body. Over the cap, the stream is cancelled and nothing is returned (C14). */
export async function readCapped(res: Response, maxBytes: number): Promise<BodyRead> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  if (res.body === null) return { ok: true, text: "" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

// A count SERV leaves out stays null; a negative, fractional or string count fails the whole body (C17).
const tokenCount = z.number().int().nonnegative().nullable().optional();

const completionShape = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().max(LIMITS.finishReasonMaxChars).nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: tokenCount,
      completion_tokens: tokenCount,
      prompt_tokens_details: z.object({ cached_tokens: tokenCount }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const requestId = z.string().regex(new RegExp(`^[A-Za-z0-9-]{1,${LIMITS.requestIdMaxChars}}$`));

const upstreamErrorShape = z.object({ error: z.object({ message: z.string().optional(), type: z.string().optional() }) });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Our own words plus a scrubbed, capped piece of SERV's error text. Never the raw body. */
function httpErrorMessage(status: number, text: string, key: string): string {
  let upstream: z.infer<typeof upstreamErrorShape> | null = null;
  try {
    const parsed = upstreamErrorShape.safeParse(JSON.parse(text));
    if (parsed.success) upstream = parsed.data;
  } catch {
    upstream = null;
  }
  if (status === 402 && upstream?.error.type === "billing_error") return "insufficient_credits";
  const detail = upstream?.error.message ?? text.trim();
  return shortMessage(detail === "" ? `http_${status}` : `http_${status}: ${detail}`, key);
}

function capAnswer(text: string): string {
  return cutPairSafe(text, LIMITS.answerMaxChars);
}

/** The error code of a call whose every attempt failed before the connection completed. */
export const CONNECT_FAILED = "connect_failed";

/**
 * True when the call never reached SERV or SERV turned it away with 429 before running it, so
 * nothing was billed and the caller may release it instead of storing it: the connection never
 * completed (error CONNECT_FAILED, no HTTP status), or SERV answered 429. A reset or timeout
 * after sending is not included, because SERV may already have billed that call (C5).
 */
export function servUnavailable(r: CaseResult): boolean {
  if (r.status !== "upstream_error") return false;
  return r.httpStatus === 429 || (r.httpStatus === null && r.error === CONNECT_FAILED);
}

/**
 * Runs one case of a workload against SERV under one configuration and classifies the reply.
 * Preconditions: w came from parseWorkload and caseId is one of its cases.
 * Throws, before any network call, when caseId is not in the workload, the answer schema does
 * not compile, cfg has a blank model or an unknown mode, or opts.maxCompletionTokens is given
 * and is not a positive integer. Thrown messages never hold the key.
 * opts.maxCompletionTokens, when given, is sent as max_completion_tokens to cap the answer's cost.
 * Every other outcome, including a key that fails isPlausibleKey, is a returned CaseResult.
 * Classification order: no response (timeout, or upstream_error with error CONNECT_FAILED when
 * the connection never completed, see servUnavailable), non-200 (upstream_error),
 * a body that fails validation (upstream_error), refusal (refused), content_filter (filtered),
 * empty content, oversized, non-JSON or off-schema content (failed), else scored.
 * The key goes only to SERV_CHAT_URL and never appears anywhere in the result (C1, C2).
 */
export async function runCase(
  w: Workload,
  caseId: string,
  cfg: RunConfig,
  apiKey: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; maxCompletionTokens?: number } = {},
): Promise<CaseResult> {
  const started = performance.now();
  // A malformed key is still scrubbed; a string shorter than any key is not, so it cannot mangle our own words.
  const secret = typeof apiKey === "string" && apiKey.length >= LIMITS.keyMinChars ? apiKey : "";
  const done = (patch: Partial<CaseResult>): CaseResult =>
    scrubDeep(
      {
        caseId,
        config: cfg,
        status: "upstream_error",
        answer: null,
        answerText: null,
        fieldScores: [],
        correct: false,
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
        latencyMs: Math.round(performance.now() - started),
        finishReason: null,
        servRequestId: null,
        httpStatus: null,
        error: null,
        ...patch,
      },
      secret,
    );

  if (!isPlausibleKey(apiKey)) return done({ error: "invalid_key_format" });

  const c = w.cases.find((x) => x.id === caseId);
  if (c === undefined) throw new Error("runCase: the case id is not in this workload.");
  const compiled = compileAnswerSchema(w.answerSchema);
  if (!compiled.ok) throw new Error("runCase: the answer schema does not compile. Parse the workload with parseWorkload first.");
  let built: ReturnType<typeof buildRequest>;
  try {
    built = buildRequest(w, c, cfg, { maxCompletionTokens: opts.maxCompletionTokens });
  } catch (err) {
    throw new Error(shortMessage(`runCase: ${err instanceof Error ? err.message : "invalid config"}`, secret));
  }

  const timeoutSignal = AbortSignal.timeout(LIMITS.upstreamTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const stopped = () => (timeoutSignal.aborted ? { status: "timeout" as const, error: "timeout" } : { status: "upstream_error" as const, error: "aborted" });

  const sent = await sendWithConnectRetry(
    opts.fetchImpl ?? fetch,
    SERV_CHAT_URL,
    {
      method: "POST",
      // Authorization last, so nothing in the built headers can replace it.
      headers: { ...built.headers, "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(built.body),
    },
    signal,
    timeoutSignal,
  );
  if (!sent.ok) {
    if (sent.reason === "connect") return done({ error: CONNECT_FAILED });
    if (sent.reason !== "network") return done(stopped());
    return done({ error: sent.code === null ? "network_error" : `network_error: ${sent.code}` });
  }

  const res = sent.res;
  const httpStatus = res.status;
  const rid = requestId.safeParse(res.headers.get("x-openserv-request-id"));
  const servRequestId = rid.success ? rid.data : null;
  const body = await readCapped(res, LIMITS.responseMaxBytes);
  if (httpStatus !== 200) return done({ httpStatus, servRequestId, error: httpErrorMessage(httpStatus, body.ok ? body.text : "", apiKey) });
  if (!body.ok) {
    if (signal.aborted) return done({ httpStatus, servRequestId, ...stopped() });
    return done({ httpStatus, servRequestId, error: body.reason === "too_large" ? "response_too_large" : "response_read_failed" });
  }

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return done({ httpStatus, servRequestId, error: "response_not_json" });
  }
  const parsed = completionShape.safeParse(json);
  if (!parsed.success) return done({ httpStatus, servRequestId, error: "response_failed_validation" });

  const choice = parsed.data.choices[0]!;
  const u = parsed.data.usage;
  const finishReason = choice.finish_reason ?? null;
  const common: Partial<CaseResult> = {
    httpStatus,
    servRequestId,
    finishReason,
    usage: {
      inputTokens: u?.prompt_tokens ?? null,
      outputTokens: u?.completion_tokens ?? null,
      cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? null,
    },
  };

  const refusal = choice.message.refusal;
  if (typeof refusal === "string" && refusal.trim() !== "") {
    return done({ ...common, status: "refused", answerText: capAnswer(refusal) });
  }
  const content = choice.message.content ?? "";
  if (finishReason === "content_filter") {
    return done({ ...common, status: "filtered", answerText: content === "" ? null : capAnswer(content) });
  }
  if (content.trim() === "") return done({ ...common, status: "failed", error: "empty_answer" });
  if (content.length > LIMITS.answerMaxChars) {
    return done({ ...common, status: "failed", answerText: capAnswer(content), error: "answer_too_large" });
  }

  // The answer is data only (C16): parsed as JSON, checked against the schema, never run or rendered here.
  let answer: unknown;
  try {
    answer = scrubDeep(JSON.parse(content) as unknown, apiKey);
  } catch {
    return done({ ...common, status: "failed", answerText: content, error: "answer_not_json" });
  }
  if (!isPlainObject(answer) || !compiled.validate(answer)) {
    return done({ ...common, status: "failed", answerText: content, error: "answer_off_schema" });
  }
  const { fieldScores, correct } = scoreAnswer(w, c, answer);
  return done({ ...common, status: "scored", answer, answerText: content, fieldScores, correct });
}
