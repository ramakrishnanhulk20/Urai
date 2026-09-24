// Not covered here: whether SERV still refuses the probe (scripts/reproduce.ts reads the live balance), the web server's
// probe rate limits and the fault flag it must raise on probe_ran, and the connect retry (serv.test.ts covers it).
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, readBalance, SERV_CHAT_URL } from "../src/index.js";

const KEY = "sk-canary-CANARY0123456789abcdef";
const GOOD = "Insufficient credits for this request: estimated maximum cost is $60000.02 but your balance is $3.77. Reduce max_tokens or serv_shadow_agent max_iterations, or purchase more credits.";

type Call = { url: string; init: RequestInit };

function fixture(make: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return make();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const billing = (message: unknown, type: unknown = "billing_error") => new Response(JSON.stringify({ error: { message, type } }), { status: 402 });

afterEach(() => vi.restoreAllMocks());

describe("readBalance", () => {
  it("reads the balance from the one known 402 shape", async () => {
    const f = fixture(() => billing(GOOD));
    expect(await readBalance(KEY, { fetchImpl: f.fetchImpl })).toStrictEqual({ ok: true, usd: 3.77 });
  });

  it("sends a probe SERV must refuse: gpt-6-astra, a 1,000,000,000 token cap, to SERV_CHAT_URL only", async () => {
    const f = fixture(() => billing(GOOD));
    await readBalance(KEY, { fetchImpl: f.fetchImpl });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(SERV_CHAT_URL);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toStrictEqual({
      model: "gpt-6-astra",
      max_completion_tokens: 1_000_000_000,
      messages: [
        { role: "system", content: "Reply ok." },
        { role: "user", content: "ok" },
      ],
    });
  });

  it("reads whole-dollar and zero balances", async () => {
    const whole = GOOD.replace("$3.77.", "$4.");
    expect(await readBalance(KEY, { fetchImpl: fixture(() => billing(whole)).fetchImpl })).toStrictEqual({ ok: true, usd: 4 });
    const zero = GOOD.replace("$3.77.", "$0.00.");
    expect(await readBalance(KEY, { fetchImpl: fixture(() => billing(zero)).fetchImpl })).toStrictEqual({ ok: true, usd: 0 });
  });

  it("treats a 200 as probe_ran, never as a balance (C7)", async () => {
    const ok = new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
    expect(await readBalance(KEY, { fetchImpl: fixture(() => ok).fetchImpl })).toStrictEqual({ ok: false, reason: "probe_ran" });
  });

  it.each([
    ["another error type", () => billing(GOOD, "rate_limit_error")],
    ["a missing type", () => new Response(JSON.stringify({ error: { message: GOOD } }), { status: 402 })],
    ["a message that is not a string", () => billing(377)],
    ["text before the known sentence", () => billing(`Note: ${GOOD}`)],
    ["a reworded sentence", () => billing(GOOD.replace("Insufficient credits", "Not enough credits"))],
    ["a balance with a thousands comma", () => billing(GOOD.replace("$3.77.", "$1,003.77."))],
    ["a negative balance", () => billing(GOOD.replace("$3.77.", "$-3.77."))],
    ["no full stop after the balance", () => billing(GOOD.replace("$3.77.", "$3.77"))],
    ["a balance in another currency", () => billing(GOOD.replace("$3.77.", "EUR3.77."))],
    ["a top-level message", () => new Response(JSON.stringify({ message: GOOD, type: "billing_error" }), { status: 402 })],
    ["a non-JSON body", () => new Response(GOOD, { status: 402 })],
    ["an empty body", () => new Response(null, { status: 402 })],
    ["the right body under status 400", () => new Response(JSON.stringify({ error: { message: GOOD, type: "billing_error" } }), { status: 400 })],
    ["a 401", () => new Response("{}", { status: 401 })],
    ["a 500", () => new Response("{}", { status: 500 })],
    ["a body over the cap", () => billing(GOOD + " ".repeat(LIMITS.probeResponseMaxBytes))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))],
  ] as [string, () => Response | Promise<Response>][])("returns unavailable for %s (C19)", async (_label, make) => {
    expect(await readBalance(KEY, { fetchImpl: fixture(make).fetchImpl })).toStrictEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable with LIMITS.probeTimeoutMs when SERV never answers", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as unknown as typeof fetch;
    expect(await readBalance(KEY, { fetchImpl })).toStrictEqual({ ok: false, reason: "unavailable" });
    expect(spy).toHaveBeenCalledWith(LIMITS.probeTimeoutMs);
  });

  it("makes no network call for a key that is not plausible", async () => {
    const f = fixture(() => billing(GOOD));
    for (const bad of ["short", `${KEY}\n`, ""]) {
      expect(await readBalance(bad, { fetchImpl: f.fetchImpl })).toStrictEqual({ ok: false, reason: "unavailable" });
    }
    expect(f.calls).toHaveLength(0);
  });
});
