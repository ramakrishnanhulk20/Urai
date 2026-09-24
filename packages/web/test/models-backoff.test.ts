/*
 * The failure back-off in lib/models.ts getModelList. The engine's listModels is a fixture, so SERV
 * is never called, and the one model_cache row is an in-memory stand-in for the database, because
 * models.test.ts clears and rewrites the real row from a parallel worker. The clock is faked for
 * Date only. Not covered here: the real SQL for the cache (models.test.ts runs it against Neon),
 * two server instances backing off separately (each keeps its own timestamp in memory; read in
 * review), and a database outage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../lib/config";
import { getModelList } from "../lib/models";

const engine = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, listModels: engine.listModels };
});

const cache = vi.hoisted(() => ({ row: null as null | { models: unknown; fetchedAt: Date } }));
vi.mock("../lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/db")>();
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").trim();
    if (text.startsWith("SELECT models, fetched_at")) {
      if (cache.row === null) return [];
      const maxAgeMs = Number(values[0]) * 1000;
      return [{ models: cache.row.models, fetched_at: cache.row.fetchedAt, fresh: Date.now() - cache.row.fetchedAt.getTime() < maxAgeMs }];
    }
    if (text.startsWith("INSERT INTO model_cache")) {
      cache.row = { models: JSON.parse(String(values[0])), fetchedAt: new Date() };
      return [{ fetched_at: cache.row.fetchedAt }];
    }
    throw new Error("unexpected query in the model cache stand-in");
  };
  return { ...real, db: () => sql };
});

const LIST = [{ id: "gpt-6-luna", inputUsdPerM: 0.13, outputUsdPerM: 0.65 }];
const BACKOFF_MS = CONFIG.modelFailureBackoffSeconds * 1000;
let now = Date.UTC(2026, 8, 23, 12);

function advance(ms: number): void {
  now += ms;
  vi.setSystemTime(now);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // A fresh hour per test, so no test sees another's back-off window.
  advance(3_600_000);
  engine.listModels.mockReset();
  cache.row = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getModelList failure back-off", () => {
  it("does not ask SERV again inside the window after a failure, and stays unverified (C18)", async () => {
    engine.listModels.mockResolvedValue({ ok: false });
    const empty = { models: [], fetchedAt: null, verified: false };
    expect(await getModelList()).toEqual(empty);
    expect(engine.listModels).toHaveBeenCalledTimes(1);

    advance(BACKOFF_MS - 1_000);
    expect(await getModelList()).toEqual(empty);
    expect(await getModelList()).toEqual(empty);
    expect(engine.listModels).toHaveBeenCalledTimes(1);
  });

  it("asks SERV again once the window has passed, and a success is verified", async () => {
    engine.listModels.mockRejectedValueOnce(new Error("boom"));
    expect((await getModelList()).verified).toBe(false);
    advance(BACKOFF_MS + 1_000);
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    expect(await getModelList()).toMatchObject({ models: LIST, verified: true });
    expect(engine.listModels).toHaveBeenCalledTimes(2);
  });

  it("serves a stale cached list as unverified through the window, never as verified (C18)", async () => {
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    const fresh = await getModelList();
    advance(CONFIG.modelCacheMaxAgeSeconds * 1000 + 1_000);

    engine.listModels.mockResolvedValue({ ok: false });
    for (let i = 0; i < 3; i++) {
      expect(await getModelList()).toEqual({ models: LIST, fetchedAt: fresh.fetchedAt, verified: false });
      advance(1_000);
    }
    expect(engine.listModels).toHaveBeenCalledTimes(2);
  });

  it("ends the back-off early when the cache row changes, and a success clears it", async () => {
    engine.listModels.mockResolvedValueOnce({ ok: false });
    await getModelList();
    // Another instance refreshed the row while this one was backing off.
    cache.row = { models: LIST, fetchedAt: new Date(now - CONFIG.modelCacheMaxAgeSeconds * 2000) };
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    expect((await getModelList()).verified).toBe(true);
    expect(engine.listModels).toHaveBeenCalledTimes(2);

    advance(CONFIG.modelCacheMaxAgeSeconds * 1000 + 1_000);
    engine.listModels.mockResolvedValueOnce({ ok: true, models: LIST });
    expect((await getModelList()).verified).toBe(true);
    expect(engine.listModels).toHaveBeenCalledTimes(3);
  });
});
