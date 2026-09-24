/*
 * The model list cache (lib/models.ts), GET /api/models and the lint's model id check, against the
 * real Neon database with the engine's listModels replaced by a fixture, so SERV is never called.
 * The one model_cache row is saved before and put back after. Not covered here: the real SERV
 * list endpoint and its response parsing (the engine's own models.test.ts), two instances
 * refreshing the cache at the same moment (both write the same row; the last one wins), and a
 * database outage (the fail-closed branches are read in review, not executed).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postLint } from "../app/api/lint/route";
import { GET as getModels } from "../app/api/models/route";
import { CONFIG } from "../lib/config";
import { db } from "../lib/db";
import { operatorServKey } from "../lib/env";
import { ipHash } from "../lib/ip";
import { getModelList } from "../lib/models";

const engine = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, listModels: engine.listModels };
});

const BASE = "http://localhost:3000";
const LIST = [
  { id: "gpt-6-luna", inputUsdPerM: 0.13, outputUsdPerM: 0.65 },
  { id: "claude-fable-5", inputUsdPerM: 13, outputUsdPerM: 65 },
];
const buckets: string[] = [];
let saved: Record<string, unknown> | undefined;

const clearCache = () => db()`DELETE FROM model_cache`;
const ageCache = () => db()`UPDATE model_cache SET fetched_at = now() - make_interval(secs => ${CONFIG.modelCacheMaxAgeSeconds + 60})`;

function expectOnlyOperatorKeySent(): void {
  for (const call of engine.listModels.mock.calls) {
    expect(call).toHaveLength(1);
    // Compared as a boolean so a failure never prints the key.
    expect(call[0] === operatorServKey()).toBe(true);
  }
}

function lint(body: unknown) {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  buckets.push(`lint:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`);
  const req = new Request(`${BASE}/api/lint`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  });
  return postLint(req).then(async (res) => ({ status: res.status, body: (await res.json()) as { findings: { id: string }[] } }));
}

beforeAll(async () => {
  saved = (await db()`SELECT models, fetched_at FROM model_cache WHERE id = 1`)[0];
});

beforeEach(async () => {
  engine.listModels.mockReset();
  await clearCache();
});

afterAll(async () => {
  await clearCache();
  if (saved !== undefined) {
    await db()`INSERT INTO model_cache (id, models, fetched_at) VALUES (1, ${JSON.stringify(saved.models)}::jsonb, ${saved.fetched_at as Date})`;
  }
  await db()`DELETE FROM rate_limits WHERE bucket = ANY(${buckets})`;
});

describe("getModelList", () => {
  it("fetches with the operator key alone when there is no cache, stores it, then serves the cache (C4)", async () => {
    engine.listModels.mockResolvedValue({ ok: true, models: LIST });
    const first = await getModelList();
    expect(first).toMatchObject({ models: LIST, verified: true });
    expect(Number.isNaN(Date.parse(String(first.fetchedAt)))).toBe(false);
    expect(engine.listModels).toHaveBeenCalledTimes(1);
    expectOnlyOperatorKeySent();

    const second = await getModelList();
    expect(second).toEqual(first);
    expect(engine.listModels).toHaveBeenCalledTimes(1);
  });

  it("serves a stale cache as unverified when SERV cannot be read, never as current (C18)", async () => {
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    const fresh = await getModelList();
    await ageCache();
    engine.listModels.mockResolvedValueOnce({ ok: false });
    const stale = await getModelList();
    expect(stale.verified).toBe(false);
    expect(stale.models).toEqual(LIST);
    expect(Date.parse(String(stale.fetchedAt))).toBeLessThan(Date.parse(String(fresh.fetchedAt)));
    expect(engine.listModels).toHaveBeenCalledTimes(2);
  });

  it("refreshes a stale cache when SERV answers", async () => {
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    await getModelList();
    await ageCache();
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST.slice(0, 1) });
    expect(await getModelList()).toMatchObject({ models: LIST.slice(0, 1), verified: true });
  });

  it("returns an empty unverified list with no cache and SERV down or throwing (C18)", async () => {
    const empty = { models: [], fetchedAt: null, verified: false };
    engine.listModels.mockResolvedValueOnce({ ok: false });
    expect(await getModelList()).toEqual(empty);
    engine.listModels.mockRejectedValueOnce(new Error("boom"));
    expect(await getModelList()).toEqual(empty);
    expect(await db()`SELECT 1 FROM model_cache`).toHaveLength(0);
  });

  it("ignores a cache row that fails validation, and never stores a list that fails it", async () => {
    await db()`INSERT INTO model_cache (id, models, fetched_at) VALUES (1, '[{"id": 1}]'::jsonb, now())`;
    engine.listModels.mockResolvedValueOnce({ ok: true, models: [{ id: "x", inputUsdPerM: -1, outputUsdPerM: 1 }] });
    expect(await getModelList()).toEqual({ models: [], fetchedAt: null, verified: false });
    expect(engine.listModels).toHaveBeenCalledTimes(1);
    const rows = await db()`SELECT models FROM model_cache`;
    expect(rows[0]!.models).toEqual([{ id: 1 }]);
  });
});

describe("GET /api/models", () => {
  it("returns the list with its fetch time and verified flag, uncached by browsers", async () => {
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    const res = await getModels();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["fetchedAt", "models", "verified"]);
    expect(body).toMatchObject({ models: LIST, verified: true });
  });
});

describe("the lint's model id check", () => {
  const good = JSON.parse(readFileSync(fileURLToPath(new URL("../../engine/workloads/invoices-good.json", import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >;
  const canary = `canary-${randomBytes(8).toString("hex")}`;
  const workload = { ...good, systemPrompt: `${String(good.systemPrompt)}\n${canary}` };

  it("flags a model SERV does not list, and passes one it does", async () => {
    engine.listModels.mockResolvedValue({ ok: true, models: LIST });
    const unknown = await lint({ workload, configs: [{ model: "gpt-9-nope", mode: "plain" }] });
    expect(unknown.status).toBe(200);
    expect(unknown.body.findings.map((f) => f.id)).toContain("model-unknown");
    const known = await lint({ workload, configs: [{ model: " GPT-6-Luna ", mode: "plain" }] });
    expect(known.body.findings.map((f) => f.id)).not.toContain("model-unknown");
    expect(known.body.findings.map((f) => f.id)).not.toContain("model-unverified");
    expectOnlyOperatorKeySent();
  });

  it("says could not verify, never unknown, when the list is unverified (C18)", async () => {
    engine.listModels.mockResolvedValue({ ok: false });
    const r = await lint({ workload, configs: [{ model: "gpt-9-nope", mode: "plain" }] });
    const ids = r.body.findings.map((f) => f.id);
    expect(ids).toContain("model-unverified");
    expect(ids).not.toContain("model-unknown");
    expectOnlyOperatorKeySent();
  });

  it("does not touch the cache or SERV when no settings are sent", async () => {
    const r = await lint({ workload });
    expect(r.status).toBe(200);
    expect(engine.listModels).not.toHaveBeenCalled();
  });
});
