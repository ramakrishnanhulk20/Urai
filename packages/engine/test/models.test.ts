// Not covered here: the live catalogue (scripts/reproduce.ts does not call it; the shape was read live on 23 Sep 2026),
// caching the list and its maximum age, and the lint that consumes it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, listModels } from "../src/index.js";

const KEY = "sk-canary-CANARY0123456789abcdef";

// Two items copied from the live /v1/models body, extra fields included.
const LIVE_ITEMS = [
  {
    modelId: "claude-fable-5",
    displayName: "Claude Fable 5",
    provider: "anthropic",
    pricing: { input: 1300, output: 6500, cachedInput: 130 },
    specs: { contextWindow: "1M", maxOutput: "128K", reasoning: false },
    modality: ["text"],
  },
  { modelId: "gpt-6-luna", displayName: "GPT 6 Luna", provider: "openai", pricing: { input: 13, output: 65, cachedInput: 1.3 } },
];

type Call = { url: string; init: RequestInit };

function fixture(make: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return make();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const list = (items: unknown, status = 200) => new Response(JSON.stringify({ items }), { status });
const item = (i: number) => ({ modelId: `m-${i}`, pricing: { input: 1, output: 2 } });

afterEach(() => vi.restoreAllMocks());

describe("listModels", () => {
  it("converts US cents per million to USD per million and drops extra fields", async () => {
    const f = fixture(() => list(LIVE_ITEMS));
    expect(await listModels(KEY, { fetchImpl: f.fetchImpl })).toStrictEqual({
      ok: true,
      models: [
        { id: "claude-fable-5", inputUsdPerM: 13, outputUsdPerM: 65 },
        { id: "gpt-6-luna", inputUsdPerM: 0.13, outputUsdPerM: 0.65 },
      ],
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://inference-api.openserv.ai/v1/models");
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: `Bearer ${KEY}` } });
  });

  it(`accepts ${LIMITS.modelsMax} models and refuses ${LIMITS.modelsMax + 1}`, async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => item(i));
    const ok = await listModels(KEY, { fetchImpl: fixture(() => list(many(LIMITS.modelsMax))).fetchImpl });
    expect(ok.ok && ok.models.length).toBe(LIMITS.modelsMax);
    expect(await listModels(KEY, { fetchImpl: fixture(() => list(many(LIMITS.modelsMax + 1))).fetchImpl })).toStrictEqual({ ok: false });
  });

  it.each([
    ["a 401", () => list(LIVE_ITEMS, 401)],
    ["a 500", () => list(LIVE_ITEMS, 500)],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["a body with no items", () => new Response(JSON.stringify({ data: LIVE_ITEMS }), { status: 200 })],
    ["an empty list", () => list([])],
    ["items that are not an array", () => list({ a: 1 })],
    ["a missing price", () => list([{ modelId: "m", pricing: { input: 1 } }])],
    ["a negative price", () => list([{ modelId: "m", pricing: { input: -1, output: 2 } }])],
    ["a string price", () => list([{ modelId: "m", pricing: { input: "1", output: 2 } }])],
    ["a model id with markup", () => list([{ modelId: "<img src=x onerror=alert(1)>", pricing: { input: 1, output: 2 } }])],
    ["a model id over the cap", () => list([{ modelId: "m".repeat(LIMITS.modelIdMaxChars + 1), pricing: { input: 1, output: 2 } }])],
    ["an empty model id", () => list([{ modelId: "", pricing: { input: 1, output: 2 } }])],
    ["a body over the cap", () => new Response(JSON.stringify({ items: LIVE_ITEMS, pad: "p".repeat(LIMITS.modelsResponseMaxBytes) }), { status: 200 })],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))],
  ] as [string, () => Response | Promise<Response>][])("returns ok:false for %s (C18)", async (_label, make) => {
    expect(await listModels(KEY, { fetchImpl: fixture(make).fetchImpl })).toStrictEqual({ ok: false });
  });

  it("returns ok:false with LIMITS.modelsTimeoutMs when SERV never answers", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as unknown as typeof fetch;
    expect(await listModels(KEY, { fetchImpl })).toStrictEqual({ ok: false });
    expect(spy).toHaveBeenCalledWith(LIMITS.modelsTimeoutMs);
  });

  it("makes no network call for a key that is not plausible", async () => {
    const f = fixture(() => list(LIVE_ITEMS));
    expect(await listModels("short", { fetchImpl: f.fetchImpl })).toStrictEqual({ ok: false });
    expect(f.calls).toHaveLength(0);
  });
});
