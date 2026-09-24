// Not covered here: real SERV behaviour and real undici error shapes (scripts/reproduce.ts runs live), the web server's
// payer and budget rules, and log output of callers. Fixtures below are hand-built from shapes seen in bench results.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlausibleKey, LIMITS, parseWorkload, runCase, SERV_CHAT_URL, type RunConfig, type Workload } from "../src/index.js";

const KEY = "sk-canary-CANARY0123456789abcdef";

const w: Workload = {
  name: "t",
  systemPrompt: "Decide pay, hold or reject.",
  context: "book",
  answerSchema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pay", "hold", "reject"] }, reason: { type: "string" } },
    required: ["verdict", "reason"],
    additionalProperties: false,
  },
  shadowHint: null,
  scoring: [{ field: "verdict", rule: "exact" }],
  cases: [{ id: "c1", input: "invoice", expected: { verdict: "pay" } }],
};
const cfg: RunConfig = { model: "gpt-6-luna", mode: "plain" };

type Call = { url: string; init: RequestInit };
type Handler = (call: Call) => Response | Promise<Response>;

function fixture(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handlers[Math.min(calls.length - 1, handlers.length - 1)]!(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function completion(message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ index: 0, message: { role: "assistant", refusal: null, ...message }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
    ...extra,
  };
}

const answer = (verdict: string, reason = "ok") => completion({ content: JSON.stringify({ verdict, reason }) });

function connectError(code: string, message = "fetch failed"): TypeError {
  return new TypeError(message, { cause: Object.assign(new Error("connect failed"), { code }) });
}

// Waits for the request's signal, then fails the way undici does when the signal aborts.
const hang: Handler = ({ init }) =>
  new Promise((_, reject) => {
    if (init.signal!.aborted) return reject(init.signal!.reason);
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });

const realTimeout = AbortSignal.timeout.bind(AbortSignal);
function fastTimeout(ms = 30) {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(ms));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCase classification", () => {
  it("scores a schema-valid answer and reports usage, finish reason and request id", async () => {
    const f = fixture(() => json(200, answer("pay"), { "x-openserv-request-id": "0b1b72b2-dc78-4a13-b174-206a2929071b" }));
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({
      caseId: "c1",
      status: "scored",
      answer: { verdict: "pay", reason: "ok" },
      answerText: '{"verdict":"pay","reason":"ok"}',
      correct: true,
      usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 100 },
      finishReason: "stop",
      servRequestId: "0b1b72b2-dc78-4a13-b174-206a2929071b",
      httpStatus: 200,
      error: null,
    });
    expect(r.fieldScores).toStrictEqual([{ field: "verdict", expected: "pay", got: "pay", match: true }]);
  });

  it("scores a wrong verdict as scored but not correct", async () => {
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, answer("hold"))).fetchImpl });
    expect(r.status).toBe("scored");
    expect(r.correct).toBe(false);
  });

  it("sends the key only to SERV_CHAT_URL over https, with redirects refused", async () => {
    const f = fixture(() => json(200, answer("pay")));
    await runCase(w, "c1", { model: "gpt-6-luna", mode: "raw" }, KEY, { fetchImpl: f.fetchImpl });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(SERV_CHAT_URL);
    expect(url.startsWith("https://inference-api.openserv.ai/")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-openserv-disable-braid": "true" });
    expect(String(init.body)).not.toContain(KEY);
  });

  it("classifies a PromptGuard refusal as refused, even when finish_reason is content_filter", async () => {
    const body = { choices: [{ message: { content: null, refusal: "I can't share that." }, finish_reason: "content_filter" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r).toMatchObject({ status: "refused", answerText: "I can't share that.", answer: null, correct: false, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: null } });
  });

  it("classifies an output-filter cut as filtered and keeps the text", async () => {
    const body = { choices: [{ message: { content: "I can't share that.", refusal: null }, finish_reason: "content_filter" }] };
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r).toMatchObject({ status: "filtered", answerText: "I can't share that.", answer: null, finishReason: "content_filter" });
  });

  it.each([
    ["empty content", completion({ content: "  " }), "empty_answer", "  "],
    ["null content", completion({ content: null }), "empty_answer", null],
    ["non-JSON content", completion({ content: "pay it" }), "answer_not_json", "pay it"],
    ["off-schema content", completion({ content: '{"verdict":"maybe","reason":"x"}' }), "answer_off_schema", '{"verdict":"maybe","reason":"x"}'],
    ["a JSON array", completion({ content: '["pay"]' }), "answer_off_schema", '["pay"]'],
  ])("classifies %s as failed with answer null (C16)", async (_label, body, error, text) => {
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r).toMatchObject({ status: "failed", answer: null, error, correct: false, fieldScores: [] });
    expect(r.answerText).toBe(text === "  " ? null : text);
  });

  it(`fails an answer over ${LIMITS.answerMaxChars} characters and keeps only the capped text`, async () => {
    const big = JSON.stringify({ verdict: "pay", reason: "r".repeat(LIMITS.answerMaxChars) });
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, completion({ content: big }))).fetchImpl });
    expect(r).toMatchObject({ status: "failed", answer: null, error: "answer_too_large" });
    expect(r.answerText).toHaveLength(LIMITS.answerMaxChars);
  });

  it("reports a 402 billing error as insufficient_credits and other statuses with a short message", async () => {
    const billing = { error: { message: "Insufficient credits for this request: estimated maximum cost is $0.29 but your balance is $0.26.", type: "billing_error" } };
    const r402 = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(402, billing)).fetchImpl });
    expect(r402).toMatchObject({ status: "upstream_error", httpStatus: 402, error: "insufficient_credits", answer: null });
    const r500 = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(500, { error: { message: "x".repeat(5000) } })).fetchImpl });
    expect(r500).toMatchObject({ status: "upstream_error", httpStatus: 500 });
    expect(r500.error!.startsWith("http_500: xxx")).toBe(true);
    expect(r500.error!.length).toBeLessThanOrEqual(LIMITS.errorMaxChars);
    const r404 = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => new Response(null, { status: 404 })).fetchImpl });
    expect(r404.error).toBe("http_404");
    const huge = json(503, "x", { "content-length": String(LIMITS.responseMaxBytes + 1) });
    const r503 = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => huge).fetchImpl });
    expect(r503).toMatchObject({ status: "upstream_error", httpStatus: 503, error: "http_503" });
  });

  it("returns upstream_error with no network call for a key that is not plausible", async () => {
    for (const bad of ["short", `${KEY} `, `${KEY}\r\nx-evil: 1`, "k".repeat(LIMITS.keyMaxChars + 1), "", 42 as unknown as string]) {
      const f = fixture(() => json(200, answer("pay")));
      const r = await runCase(w, "c1", cfg, bad, { fetchImpl: f.fetchImpl });
      expect(r).toMatchObject({ status: "upstream_error", error: "invalid_key_format" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("throws before any network call for an unknown case id or a bad config, without the key in the message", async () => {
    const f = fixture(() => json(200, answer("pay")));
    await expect(runCase(w, "nope", cfg, KEY, { fetchImpl: f.fetchImpl })).rejects.toThrow("case id");
    const err = await runCase(w, "c1", { model: "m", mode: KEY as never }, KEY, { fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("[key]");
    expect((err as Error).message).not.toContain(KEY);
    expect(f.calls).toHaveLength(0);
  });
});

describe("runCase response validation (C17)", () => {
  it("keeps missing token counts as null, never 0", async () => {
    const body = { choices: [{ message: { content: '{"verdict":"pay","reason":"ok"}' }, finish_reason: null }] };
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r).toMatchObject({ status: "scored", usage: { inputTokens: null, outputTokens: null, cachedTokens: null }, finishReason: null });
  });

  it.each([
    ["a negative token count", completion({ content: "{}" }, { usage: { prompt_tokens: -1, completion_tokens: 1 } })],
    ["a fractional token count", completion({ content: "{}" }, { usage: { prompt_tokens: 1.5 } })],
    ["a string token count", completion({ content: "{}" }, { usage: { completion_tokens: "30" } })],
    ["a string cached count", completion({ content: "{}" }, { usage: { prompt_tokens_details: { cached_tokens: "9" } } })],
    ["a finish reason over the cap", { choices: [{ message: { content: "{}" }, finish_reason: "f".repeat(LIMITS.finishReasonMaxChars + 1) }] }],
    ["no choices", { choices: [] }],
    ["a numeric content", { choices: [{ message: { content: 5 }, finish_reason: "stop" }] }],
    ["a non-JSON body", "<html>ok</html>"],
  ])("treats a 200 with %s as upstream_error, not scored", async (_label, body) => {
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r).toMatchObject({ status: "upstream_error", httpStatus: 200, answer: null, correct: false });
  });

  it(`accepts a ${LIMITS.finishReasonMaxChars}-character finish reason`, async () => {
    const f = "f".repeat(LIMITS.finishReasonMaxChars);
    const body = { choices: [{ message: { content: '{"verdict":"pay","reason":"ok"}' }, finish_reason: f }] };
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, body)).fetchImpl });
    expect(r.finishReason).toBe(f);
  });

  it.each([
    ["other characters", "abc$def", null],
    ["over the cap", "a".repeat(LIMITS.requestIdMaxChars + 1), null],
    ["at the cap", "a".repeat(LIMITS.requestIdMaxChars), "a".repeat(LIMITS.requestIdMaxChars)],
  ])("reads a request id with %s as %s", async (_label, id, want) => {
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, answer("pay"), { "x-openserv-request-id": id })).fetchImpl });
    expect(r.servRequestId).toBe(want);
  });
});

describe("runCase caps and timeouts (C14)", () => {
  it(`reads a body of exactly ${LIMITS.responseMaxBytes} bytes and refuses one byte more`, async () => {
    const base = JSON.stringify(answer("pay"));
    const exact = base + " ".repeat(LIMITS.responseMaxBytes - base.length);
    const ok = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => json(200, exact)).fetchImpl });
    expect(ok.status).toBe("scored");

    let cancelled = false;
    const chunk = new Uint8Array(100_000).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const over = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => new Response(stream, { status: 200 })).fetchImpl });
    expect(over).toMatchObject({ status: "upstream_error", error: "response_too_large", httpStatus: 200 });
    expect(cancelled).toBe(true);
  });

  it("refuses a body whose declared length is over the cap without reading it", async () => {
    const res = json(200, answer("pay"), { "content-length": String(LIMITS.responseMaxBytes + 1) });
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(() => res).fetchImpl });
    expect(r.error).toBe("response_too_large");
  });

  it("uses LIMITS.upstreamTimeoutMs and reports timeout when it fires before a response", async () => {
    const spy = fastTimeout();
    const f = fixture(hang);
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    expect(spy).toHaveBeenCalledWith(LIMITS.upstreamTimeoutMs);
    expect(r).toMatchObject({ status: "timeout", error: "timeout", httpStatus: null });
    expect(f.calls).toHaveLength(1);
  });

  it("reports timeout when it fires while the body is still arriving", async () => {
    fastTimeout();
    const f = fixture(({ init }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"choices":'));
          init.signal!.addEventListener("abort", () => ctrl.error(init.signal!.reason), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    });
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({ status: "timeout", httpStatus: 200 });
    expect(f.calls).toHaveLength(1);
  });

  it("reports a caller abort as upstream_error, not timeout", async () => {
    const ctrl = new AbortController();
    const f = fixture((call) => {
      ctrl.abort();
      return hang(call);
    });
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl, signal: ctrl.signal });
    expect(r).toMatchObject({ status: "upstream_error", error: "aborted" });
  });
});

describe("runCase connect-only retry (C5)", () => {
  it("retries a connect timeout up to 3 times, 1, 2 and 4 seconds apart, then succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fail = () => Promise.reject(connectError("UND_ERR_CONNECT_TIMEOUT"));
    const f = fixture(fail, fail, fail, () => json(200, answer("pay")));
    const pending = runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    await vi.advanceTimersByTimeAsync(999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).status).toBe("scored");
    expect(f.calls).toHaveLength(4);
  });

  it("gives up after 3 retries with upstream_error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(() => Promise.reject(connectError("UND_ERR_CONNECT_TIMEOUT", `fetch failed for ${KEY}`)));
    const pending = runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(r).toMatchObject({ status: "upstream_error", error: "network_error: UND_ERR_CONNECT_TIMEOUT" });
    expect(f.calls).toHaveLength(1 + LIMITS.connectRetriesMax);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("retries ECONNREFUSED found inside an AggregateError", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agg = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })]) });
    const f = fixture(() => Promise.reject(agg), () => json(200, answer("pay")));
    const pending = runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe("scored");
    expect(f.calls).toHaveLength(2);
  });

  it.each([
    ["a 500", () => json(500, { error: { message: "boom" } })],
    ["a 429", () => json(429, { error: { message: "slow down" } })],
    ["a 502", () => json(502, "bad gateway")],
    ["a reset after sending", () => Promise.reject(connectError("ECONNRESET"))],
    ["an undici socket error", () => Promise.reject(connectError("UND_ERR_SOCKET"))],
    ["a plain error", () => Promise.reject(new Error("weird"))],
  ] as [string, Handler][])("never retries %s", async (_label, handler) => {
    const f = fixture(handler, () => json(200, answer("pay")));
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    expect(r.status).toBe("upstream_error");
    expect(f.calls).toHaveLength(1);
  });

  it("never retries a timeout after connecting", async () => {
    fastTimeout();
    const f = fixture(hang, () => json(200, answer("pay")));
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: f.fetchImpl });
    expect(r.status).toBe("timeout");
    expect(f.calls).toHaveLength(1);
  });
});

describe("the key never leaves in a result (C1)", () => {
  const echo = `Bearer ${KEY}`;
  const paths: [string, Handler, string][] = [
    ["success whose answer quotes the key", () => json(200, completion({ content: JSON.stringify({ verdict: "pay", reason: echo }) })), "scored"],
    ["402 whose message quotes the key", () => json(402, { error: { type: "billing_error", message: echo } }), "upstream_error"],
    ["500 whose JSON message quotes the key", () => json(500, { error: { message: `bad auth header ${echo}` } }), "upstream_error"],
    ["500 whose text body quotes the key", () => new Response(`upstream said ${echo}`, { status: 500 }), "upstream_error"],
    ["refusal that quotes the key", () => json(200, { choices: [{ message: { content: null, refusal: echo }, finish_reason: "stop" }] }), "refused"],
    ["filter cut that quotes the key", () => json(200, { choices: [{ message: { content: echo }, finish_reason: "content_filter" }] }), "filtered"],
    ["non-JSON answer that quotes the key", () => json(200, completion({ content: echo })), "failed"],
    ["off-schema answer with the key as a property name", () => json(200, completion({ content: JSON.stringify({ [KEY]: 1 }) })), "failed"],
    ["request id header that is the key", () => json(200, answer("pay"), { "x-openserv-request-id": KEY }), "scored"],
    ["fetch that throws with the key in its message", () => Promise.reject(new Error(`request to ${echo} failed`)), "upstream_error"],
    ["fetch that throws with the key in its cause", () => Promise.reject(new TypeError("fetch failed", { cause: { code: KEY } })), "upstream_error"],
  ];

  it.each(paths)("%s", async (_label, handler, status) => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(handler).fetchImpl });
    expect(r.status).toBe(status);
    expect(JSON.stringify(r)).not.toContain(KEY);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("on timeout", async () => {
    fastTimeout();
    const r = await runCase(w, "c1", cfg, KEY, { fetchImpl: fixture(hang).fetchImpl });
    expect(r.status).toBe("timeout");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("when the key holds characters JSON escapes and the body quotes it escaped", async () => {
    const odd = 'sk-"quote\\slash-0123456789';
    expect(isPlausibleKey(odd)).toBe(true);
    const r = await runCase(w, "c1", cfg, odd, { fetchImpl: fixture(() => new Response(`raw ${JSON.stringify(odd)}`, { status: 500 })).fetchImpl });
    expect(r.error).toContain("[key]");
    expect(JSON.stringify(r)).not.toContain(JSON.stringify(odd).slice(1, -1));
  });
});

describe("isPlausibleKey", () => {
  it.each([
    ["a", false],
    ["k".repeat(LIMITS.keyMinChars - 1), false],
    ["k".repeat(LIMITS.keyMinChars), true],
    ["k".repeat(LIMITS.keyMaxChars), true],
    ["k".repeat(LIMITS.keyMaxChars + 1), false],
    [`${KEY} x`, false],
    [`${KEY}\n`, false],
    [`${KEY}\t`, false],
    [`${KEY}é`, false],
    [`${KEY}\u0000`, false],
    [KEY, true],
  ])("%j is %s", (k, want) => {
    expect(isPlausibleKey(k)).toBe(want);
  });

  it("refuses non-strings", () => {
    for (const k of [null, undefined, 12345678901234567890, {}, [KEY]]) expect(isPlausibleKey(k)).toBe(false);
  });
});

describe("workload caps that runCase relies on (C14)", () => {
  const valid = () => ({ ...structuredClone(w), scoring: [{ field: "verdict", rule: "oneOf" }], cases: [{ id: "c1", input: "x", expected: { verdict: ["pay"] } }] });

  it(`caps shadowHint at ${LIMITS.shadowHintMaxChars} characters`, () => {
    expect(parseWorkload({ ...valid(), shadowHint: "h".repeat(LIMITS.shadowHintMaxChars) }).ok).toBe(true);
    const r = parseWorkload({ ...valid(), shadowHint: "h".repeat(LIMITS.shadowHintMaxChars + 1) });
    expect(r.ok ? "" : r.errors.join("; ")).toContain("shadowHint");
  });

  it(`caps each expected string at ${LIMITS.expectedStringMaxChars} characters, in lists too`, () => {
    const at = (s: string, list: boolean) => ({ ...valid(), ...(list ? {} : { scoring: [{ field: "verdict", rule: "exact" }] }), cases: [{ id: "c1", input: "x", expected: { verdict: list ? ["pay", s] : s } }] });
    const max = "e".repeat(LIMITS.expectedStringMaxChars);
    expect(parseWorkload(at(max, false)).ok).toBe(true);
    expect(parseWorkload(at(max, true)).ok).toBe(true);
    for (const list of [false, true]) {
      const r = parseWorkload(at(max + "e", list));
      expect(r.ok ? "" : r.errors.join("; ")).toContain("character limit");
    }
  });

  it(`caps oneOf options at ${LIMITS.oneOfOptionsMax}`, () => {
    const options = (n: number) => ({ ...valid(), cases: [{ id: "c1", input: "x", expected: { verdict: Array.from({ length: n }, (_, i) => `o${i}`) } }] });
    expect(parseWorkload(options(LIMITS.oneOfOptionsMax)).ok).toBe(true);
    const r = parseWorkload(options(LIMITS.oneOfOptionsMax + 1));
    expect(r.ok ? "" : r.errors.join("; ")).toContain(`limit is ${LIMITS.oneOfOptionsMax}`);
  });
});
