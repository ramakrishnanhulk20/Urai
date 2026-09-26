/*
 * Calls the case handler directly against the real Neon database, with the engine's runCase
 * replaced by a fixture, so no request reaches SERV and no money moves.
 * Demo tests run on a made-up day far in the future, so today's real budget row is never touched.
 * Not covered here: the real engine (live-demo.test.ts runs one real demo case), the Next.js
 * server and Vercel's function time limit, a database outage (the fail-closed branches are read
 * in review, not executed), a request that really dies mid-call (simulated by ageing a claim), a
 * call that spans UTC midnight, a refusal budget test that spans the top of the hour (its count
 * would split across two windows), the function log store itself (console output is captured), a
 * real connection failure or 429 from SERV (the engine's own tests cover how those are classified),
 * a Neon query that hangs past its timeout, a database really past its size stop (the stop is
 * lowered below the real size instead), and a save that really fails (the save is made to throw).
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { CONNECT_FAILED, type CaseResult, type RunConfig } from "@urai/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postCase } from "../app/api/runs/[id]/cases/[caseId]/route";
import { POST as postRun } from "../app/api/runs/route";
import { POST as postWorkload } from "../app/api/workloads/route";
import { budgetDay } from "../lib/budget";
import { claimCase, releaseClaim } from "../lib/claim";
import { enforceRateLimit, refundRateLimit } from "../lib/rate";
import { CONFIG, OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { HttpError, SERV_KEY_HEADER } from "../lib/http";
import { hashToken, newId, newOwnerToken } from "../lib/ids";
import { ipHash } from "../lib/ip";

const engine = vi.hoisted(() => ({ runCase: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, runCase: engine.runCase };
});

// The demo_off stop is server-wide; setting the real row would stop every demo call, the live app's included.
const flags = vi.hoisted(() => new Set<string>());
vi.mock("../lib/flags", () => ({
  isSet: async (name: string) => flags.has(name),
}));

// The database size stop, lowered by the storage tests so a new claim meets a full database.
const stop = vi.hoisted(() => ({ bytes: Number.MAX_SAFE_INTEGER }));
vi.mock("../lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/config")>();
  return {
    ...real,
    CONFIG: {
      ...real.CONFIG,
      get dbSizeStopBytes() {
        return stop.bytes;
      },
    },
  };
});

/*
 * saves.fail makes the next finishClaim calls throw; saves.commitFirst makes the first of them
 * store the row before it throws, as when the database commits but its answer never arrives.
 */
const saves = vi.hoisted(() => ({ fail: 0, commitFirst: false, calls: 0 }));
vi.mock("../lib/claim", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/claim")>();
  return {
    ...real,
    finishClaim: async (...args: Parameters<typeof real.finishClaim>) => {
      saves.calls++;
      if (saves.fail > 0) {
        saves.fail--;
        if (saves.commitFirst) {
          saves.commitFirst = false;
          await real.finishClaim(...args);
        }
        throw Object.assign(new Error("save failed"), { name: "NeonDbError" });
      }
      return real.finishClaim(...args);
    },
  };
});

// Counts the price list reads, and lets a test hand back a price of its own.
const prices = vi.hoisted(() => ({ reads: 0, next: [] as unknown[] }));
vi.mock("../lib/models", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/models")>();
  return {
    ...real,
    readCachedModels: async () => {
      prices.reads++;
      return prices.next.length > 0 ? prices.next.shift() : real.readCachedModels();
    },
  };
});

const operator = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/env")>();
  return {
    ...real,
    operatorServKey: () => {
      operator.reads++;
      return real.operatorServKey();
    },
  };
});

const BASE = "http://localhost:3000";
const SAMPLE = "sample-invoices-good";
const LUNA_RAW = { model: "gpt-6-luna", mode: "raw" };
const LUNA_PLAIN = { model: "gpt-6-luna", mode: "plain" };
const CANARY = `sk-canary-${randomBytes(16).toString("hex")}`;

const created = { workloads: [] as string[], runs: [] as string[], buckets: [] as string[], days: [] as string[] };
const responses: { res: Response; text: string }[] = [];
const logs: string[] = [];

function futureDay(): Date {
  const r = randomBytes(3);
  return new Date(Date.UTC(2090 + (r[0]! % 10), r[1]! % 12, 1 + (r[2]! % 28), 12));
}
const MAIN_DAY = futureDay();
const TIGHT_DAY = new Date(MAIN_DAY.getTime() + 86_400_000);
// A day whose row the engine fixture deletes mid-call, so settling fails after the answer is stored.
const SETTLE_DAY = new Date(MAIN_DAY.getTime() + 2 * 86_400_000);

function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
  created.buckets.push(`workloads:${hash}`, `runs:${hash}`, refusalBucket(ip), demoBucket(ip), unavailableBucket(ip));
  return ip;
}

function unavailableBucket(ip: string): string {
  return `serv_unavailable:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`;
}

function demoBucket(ip: string): string {
  return `demo_calls:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`;
}

function refusalBucket(ip: string): string {
  return `key_refusals:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`;
}

// Every case call comes from an address, and the route charges SERV refusals to it (C33).
let CASE_IP = "";

async function record(p: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await p;
  const text = await res.clone().text();
  responses.push({ res, text });
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

function post(path: string, body: unknown, ip: string, owner?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip };
  if (owner !== undefined) headers[OWNER_HEADER] = owner;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function workload(cases: number): Record<string, unknown> {
  return {
    name: "Case route test",
    systemPrompt: "Decide pay or hold.",
    context: null,
    answerSchema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
    shadowHint: null,
    scoring: [{ field: "verdict", rule: "exact" }],
    cases: Array.from({ length: cases }, (_, i) => ({ id: `c${i}`, input: `invoice ${i}`, expected: { verdict: "pay" } })),
  };
}

async function teamRun(cases = 4, configs: unknown[] = [LUNA_RAW, LUNA_PLAIN]) {
  const ip = freshIp();
  const w = await record(postWorkload(post("/api/workloads", { workload: workload(cases) }, ip)));
  const workloadId = String(w.body.workloadId);
  created.workloads.push(workloadId);
  const r = await record(postRun(post("/api/runs", { workloadId, configs, payer: "team" }, ip, String(w.body.ownerToken))));
  expect(r.status).toBe(201);
  created.runs.push(String(r.body.runId));
  return { runId: String(r.body.runId), owner: String(r.body.ownerToken), workloadId, cases: r.body.cases as string[] };
}

async function demoRun(configs: unknown[] = [LUNA_RAW]) {
  const r = await record(postRun(post("/api/runs", { workloadId: SAMPLE, configs, payer: "demo" }, freshIp())));
  expect(r.status).toBe(201);
  created.runs.push(String(r.body.runId));
  return { runId: String(r.body.runId), owner: String(r.body.ownerToken), cases: r.body.cases as string[] };
}

function callCase(
  runId: string,
  caseId: string,
  opts: { config?: string[]; owner?: string; key?: string; body?: string; ip?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const qs = new URLSearchParams();
  for (const c of opts.config ?? ["0"]) qs.append("config", c);
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? CASE_IP };
  if (opts.owner !== undefined) headers[OWNER_HEADER] = opts.owner;
  if (opts.key !== undefined) headers[SERV_KEY_HEADER] = opts.key;
  const url = `${BASE}/api/runs/${runId}/cases/${encodeURIComponent(caseId)}?${qs.toString()}`;
  const req = new Request(url, { method: "POST", headers, body: opts.body });
  return record(postCase(req, { params: Promise.resolve({ id: runId, caseId }) }));
}

function fixture(caseId: string, config: RunConfig, patch: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId,
    config,
    status: "scored",
    answer: { verdict: "pay" },
    answerText: '{"verdict":"pay"}',
    fieldScores: [],
    correct: true,
    usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: null },
    latencyMs: 40,
    finishReason: "stop",
    servRequestId: `req-${randomBytes(8).toString("hex")}`,
    httpStatus: 200,
    error: null,
    ...patch,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function caseRows(runId: string) {
  return db()`SELECT case_id, config_idx, status, result, finished_at, est_cost_usd FROM case_results WHERE run_id = ${runId} ORDER BY case_id, config_idx`;
}

async function budgetRow(day: Date) {
  const rows = await db()`SELECT reserved_usd::text AS reserved, spent_usd::text AS spent FROM demo_budget WHERE day = ${budgetDay(day)}::date`;
  return rows[0];
}

async function budgetCalls(day: Date): Promise<number> {
  const rows = await db()`SELECT calls FROM demo_budget WHERE day = ${budgetDay(day)}::date`;
  return Number(rows[0]?.calls);
}

async function bucketCount(bucket: string): Promise<number> {
  const rows = await db()`SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits WHERE bucket = ${bucket}`;
  return Number(rows[0]?.n);
}

async function setBucket(bucket: string, count: number): Promise<void> {
  await db()`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds}), ${count})
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${count}`;
}

const NO_USAGE = { inputTokens: null, outputTokens: null, cachedTokens: null };
const NEVER_SENT: Partial<CaseResult> = { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: null, servRequestId: null, error: CONNECT_FAILED };
const SERV_429: Partial<CaseResult> = { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: 429, error: "http_429: slow down" };

beforeAll(async () => {
  CASE_IP = freshIp();
  vi.useFakeTimers({ toFake: ["Date"], now: MAIN_DAY });
  for (const [day, cap] of [
    [MAIN_DAY, 1],
    [TIGHT_DAY, 3 * CONFIG.demoCallEstimateUsd],
  ] as const) {
    created.days.push(budgetDay(day));
    await db()`INSERT INTO demo_budget (day, cap_usd) VALUES (${budgetDay(day)}::date, ${cap}::numeric)`;
  }
  for (const level of ["log", "info", "warn", "error"] as const) {
    const real = console[level];
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
      real(...args);
    });
  }
});

beforeEach(() => {
  engine.runCase.mockReset();
  flags.clear();
  engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => {
    await sleep(50);
    return fixture(caseId, cfg);
  });
  operator.reads = 0;
  stop.bytes = Number.MAX_SAFE_INTEGER;
  Object.assign(saves, { fail: 0, commitFirst: false, calls: 0 });
  Object.assign(prices, { reads: 0, next: [] });
});

afterEach(() => {
  vi.setSystemTime(MAIN_DAY);
});

afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${created.workloads}) AND NOT is_sample`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
  await sql`DELETE FROM demo_budget WHERE day = ANY(${created.days}::date[])`;
});

describe("C10: access checks come before any claim, budget or key logic", () => {
  it("answers 404 to an unknown run, a missing or borrowed token, and a case outside the run", async () => {
    const a = await teamRun(2);
    const b = await teamRun(2);
    const demo = await demoRun();

    expect(await callCase(newId(), "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await callCase(a.runId, "c0", { key: CANARY })).status).toBe(404);
    expect((await callCase(a.runId, "c0", { owner: b.owner, key: CANARY })).status).toBe(404);
    expect((await callCase(a.runId, "c9", { owner: a.owner, key: CANARY })).status).toBe(404);
    // INV-13 is in the sample but past the demo cap, so it is not in this run's list.
    expect((await callCase(demo.runId, "INV-13", { owner: demo.owner })).status).toBe(404);
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(await caseRows(a.runId)).toHaveLength(0);
  });

  it("answers 400 to a config index outside the run or not written as one plain integer", async () => {
    const a = await teamRun(2);
    for (const config of [["2"], ["-1"], ["1.5"], ["01"], ["+1"], [" 1"], ["abc"], [""], [], ["0", "1"]]) {
      expect(await callCase(a.runId, "c0", { config, owner: a.owner, key: CANARY })).toMatchObject({
        status: 400,
        body: { error: "invalid_config" },
      });
    }
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(await caseRows(a.runId)).toHaveLength(0);
  });
});

describe("C3: the payer comes from the run, and the header must agree", () => {
  it("refuses a team run call with no key, a blank key or an implausible key", async () => {
    const a = await teamRun(1);
    for (const key of [undefined, "", "   ", "short"]) {
      expect(await callCase(a.runId, "c0", { owner: a.owner, key })).toMatchObject({ status: 400, body: { error: "payer_mismatch" } });
    }
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
  });

  it("refuses a demo run call that carries a key, and treats a blank header as no key", async () => {
    const demo = await demoRun();
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, key: CANARY })).toMatchObject({
      status: 400,
      body: { error: "payer_mismatch" },
    });
    expect(engine.runCase).not.toHaveBeenCalled();

    const r = await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, key: "   " });
    expect(r.status).toBe(200);
    expect(engine.runCase).toHaveBeenCalledTimes(1);
    expect(engine.runCase.mock.calls[0]![3]).not.toBe(CANARY);
    expect(operator.reads).toBe(1);
  });
});

describe("C4: the operator key is read only for a demo run on a sample", () => {
  it("refuses a demo run whose workload is not a sample without reading the operator key", async () => {
    const a = await teamRun(1);
    const runId = newId();
    const owner = newOwnerToken();
    created.runs.push(runId);
    await db()`
      INSERT INTO runs (id, workload_id, report_id, owner_hash, payer, configs, case_ids)
      VALUES (${runId}, ${a.workloadId}, ${newId()}, ${hashToken(owner)}, 'demo',
              ${JSON.stringify([{ ...LUNA_RAW, keepContentFilter: false }])}::jsonb, '["c0"]'::jsonb)`;
    expect(await callCase(runId, "c0", { owner })).toMatchObject({ status: 403, body: { error: "demo_not_allowed" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
    expect(await caseRows(runId)).toHaveLength(0);
  });
});

describe("C1: a team key never reaches the database, a log line or a response", () => {
  it("keeps the canary key out of every stored row, response and log line on every path", async () => {
    const a = await teamRun(4);
    const logStart = logs.length;

    const ok = await callCase(a.runId, "c0", { owner: a.owner, key: CANARY });
    expect(ok).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase.mock.calls[0]![3]).toBe(CANARY);

    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, httpStatus: 403, error: "http_403: forbidden [key]" }),
    );
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "upstream_error" } });

    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, httpStatus: 401, error: `http_401: invalid key ${CANARY}` }),
    );
    expect(await callCase(a.runId, "c3", { owner: a.owner, key: CANARY })).toEqual({ status: 401, body: { error: "serv_rejected_key" } });

    // An engine that failed to scrub: the belt-and-braces check must refuse the whole result.
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", error: `http_401: bad key ${CANARY}` }),
    );
    expect(await callCase(a.runId, "c2", { owner: a.owner, key: CANARY })).toMatchObject({ status: 500, body: { error: "internal" } });

    engine.runCase.mockImplementationOnce(async () => {
      throw Object.assign(new Error(`boom ${CANARY}`), { code: CANARY });
    });
    expect(await callCase(a.runId, "c3", { owner: a.owner, key: CANARY })).toMatchObject({ status: 500, body: { error: "internal" } });

    const rows = await caseRows(a.runId);
    expect(rows.map((r) => [r.case_id, r.status])).toEqual([
      ["c0", "scored"],
      ["c1", "upstream_error"],
      ["c2", "pending"],
    ]);
    expect(rows[2]!.result).toBeNull();

    const dump = await db()`
      SELECT (SELECT coalesce(string_agg(row_to_json(c)::text, ''), '') FROM case_results c WHERE run_id = ${a.runId})
          || (SELECT row_to_json(r)::text FROM runs r WHERE id = ${a.runId}) AS text`;
    expect(String(dump[0]!.text)).not.toContain(CANARY);
    for (const r of responses) expect(r.text).not.toContain(CANARY);
    expect(logs.length).toBeGreaterThan(logStart);
    for (const line of logs) expect(line).not.toContain(CANARY);
  });
});

describe("C1: the store-time check refuses any 16-character piece of the key", () => {
  it("answers 500 and stores nothing when an answer carries part of the key", async () => {
    const a = await teamRun(1);
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { answerText: `echo ${CANARY.slice(5, 25)} echo` }),
    );
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 500, body: { error: "internal" } });
    const rows = await caseRows(a.runId);
    expect(rows.every((r) => r.result === null)).toBe(true);
    for (const r of responses) expect(r.text).not.toContain(CANARY.slice(5, 25));
  });
});

describe("a key SERV refuses with 401 frees the call for a corrected key", () => {
  it("releases the claim, stores nothing, and runs the same call again with the next key", async () => {
    const a = await teamRun(1);
    const wrongKey = `sk-wrong-${randomBytes(16).toString("hex")}`;
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, usage: { inputTokens: null, outputTokens: null, cachedTokens: null }, httpStatus: 401, error: "http_401: invalid key [key]" }),
    );
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: wrongKey })).toEqual({ status: 401, body: { error: "serv_rejected_key" } });
    expect(await caseRows(a.runId)).toHaveLength(0);

    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);
    expect(engine.runCase.mock.calls[1]![3]).toBe(CANARY);
    const rows = await caseRows(a.runId);
    expect(rows.map((r) => [r.case_id, r.status])).toEqual([["c0", "scored"]]);

    expect(await callCase(a.runId, "c0", { owner: a.owner, key: wrongKey })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);
  });

  it("keeps a 403 stored, because SERV does not document it as a key that was never charged", async () => {
    const a = await teamRun(1);
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, httpStatus: 403, error: "http_403: forbidden" }),
    );
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "upstream_error", httpStatus: 403 } });
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "upstream_error" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });
});

describe("C33: team calls SERV refuses are budgeted per address", () => {
  const NO_USAGE = { inputTokens: null, outputTokens: null, cachedTokens: null };
  const refused401: Partial<CaseResult> = { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: 401, error: "http_401: invalid key [key]" };
  const refused402: Partial<CaseResult> = { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: 402, error: "insufficient_credits" };

  function answerWith(patch: Partial<CaseResult>) {
    return async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, patch);
  }

  async function refusals(ip: string): Promise<number> {
    const rows = await db()`SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits WHERE bucket = ${refusalBucket(ip)}`;
    return Number(rows[0]?.n);
  }

  async function fillBudget(ip: string): Promise<void> {
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${refusalBucket(ip)},
              to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds}),
              ${CONFIG.keyRefusalsPerIpPerWindow})
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${CONFIG.keyRefusalsPerIpPerWindow}`;
  }

  it("releases a 401 and counts one refusal for the caller's address", async () => {
    const a = await teamRun(1);
    const ip = freshIp();
    engine.runCase.mockImplementationOnce(answerWith(refused401));
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 401, body: { error: "serv_rejected_key" } });
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(await refusals(ip)).toBe(1);
  });

  it("refuses the 31st team call from an address with 429 before any claim or SERV call, and leaves other addresses alone", async () => {
    const limit = CONFIG.keyRefusalsPerIpPerWindow;
    const a = await teamRun(CONFIG.concurrentCaseCallsPerRun);
    const ip = freshIp();
    engine.runCase.mockImplementation(answerWith(refused401));
    // Four at a time on four cases, the most one run allows in flight, so the loop stays quick.
    for (let done = 0; done < limit; done += a.cases.length) {
      const batch = a.cases.slice(0, Math.min(a.cases.length, limit - done));
      const all = await Promise.all(batch.map((c) => callCase(a.runId, c, { owner: a.owner, key: CANARY, ip })));
      for (const r of all) expect(r).toEqual({ status: 401, body: { error: "serv_rejected_key" } });
    }
    expect(engine.runCase).toHaveBeenCalledTimes(limit);
    expect(await refusals(ip)).toBe(limit);

    engine.runCase.mockImplementation(answerWith({}));
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(engine.runCase).toHaveBeenCalledTimes(limit);
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(await refusals(ip)).toBe(limit);

    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip: freshIp() })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(limit + 1);
  });

  it("releases a 402 insufficient_credits on a team run, so the same call runs and stores after a top-up", async () => {
    const a = await teamRun(2);
    const ip = freshIp();
    engine.runCase.mockImplementationOnce(answerWith(refused402));
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 402, body: { error: "serv_insufficient_credits" } });
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(await refusals(ip)).toBe(1);

    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);

    // Any other 402 is not the pre-model credit refusal, so it is stored like every other answer.
    engine.runCase.mockImplementationOnce(answerWith({ ...refused402, error: "http_402: payment required" }));
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "upstream_error", httpStatus: 402 } });
    const rows = await caseRows(a.runId);
    expect(rows.map((r) => [r.case_id, r.status])).toEqual([
      ["c0", "scored"],
      ["c1", "upstream_error"],
    ]);
    // Stored, and as a 4xx other than 429 it keeps its refusal charge too.
    expect(await refusals(ip)).toBe(2);
  });

  it("stores a 402 insufficient_credits on a demo run exactly as before, and charges no refusal", async () => {
    const demo = await demoRun();
    const ip = freshIp();
    const caseId = demo.cases[0]!;
    engine.runCase.mockImplementationOnce(answerWith(refused402));
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toMatchObject({
      status: 200,
      body: { status: "upstream_error", httpStatus: 402, error: "insufficient_credits" },
    });
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toMatchObject({ status: 200, body: { httpStatus: 402 } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
    const rows = await caseRows(demo.runId);
    expect(rows.map((r) => [r.case_id, r.status])).toEqual([[caseId, "upstream_error"]]);
    expect(rows[0]!.finished_at).not.toBeNull();
    expect(await refusals(ip)).toBe(0);
  });

  it("keeps the canary key out of stored rows, responses and log lines on the 401, 402 and 429 paths", async () => {
    const a = await teamRun(2);
    const ip = freshIp();
    const logStart = logs.length;
    const responseStart = responses.length;

    // An engine that failed to scrub: a refusal is released before store(), so its text goes nowhere.
    engine.runCase.mockImplementationOnce(answerWith({ ...refused401, error: `http_401: invalid key ${CANARY}` }));
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 401, body: { error: "serv_rejected_key" } });
    engine.runCase.mockImplementationOnce(answerWith(refused402));
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 402, body: { error: "serv_insufficient_credits" } });
    await fillBudget(ip);
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);

    const dump = await db()`
      SELECT (SELECT coalesce(string_agg(row_to_json(c)::text, ''), '') FROM case_results c WHERE run_id = ${a.runId})
          || (SELECT row_to_json(r)::text FROM runs r WHERE id = ${a.runId})
          || (SELECT coalesce(string_agg(row_to_json(l)::text, ''), '') FROM rate_limits l WHERE bucket = ${refusalBucket(ip)}) AS text`;
    expect(String(dump[0]!.text)).not.toContain(CANARY);
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(responses.length).toBe(responseStart + 3);
    for (const r of responses.slice(responseStart)) expect(r.text).not.toContain(CANARY);
    expect(logs.length).toBeGreaterThan(logStart);
    for (const line of logs.slice(logStart)) expect(line).not.toContain(CANARY);
  });
});

describe("C5: each (run, case, config) is spent at most once", () => {
  it("makes exactly one engine call for ten concurrent identical calls, and replays the stored result", async () => {
    const a = await teamRun(1);
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => {
      await sleep(400);
      return fixture(caseId, cfg, { servRequestId: "req-once" });
    });
    const all = await Promise.all(Array.from({ length: 10 }, () => callCase(a.runId, "c0", { owner: a.owner, key: CANARY })));
    expect(engine.runCase).toHaveBeenCalledTimes(1);
    for (const r of all) expect([200, 202]).toContain(r.status);
    expect(all.filter((r) => r.status === 200).every((r) => r.body.servRequestId === "req-once")).toBe(true);
    expect(all.some((r) => r.status === 202 && r.body.status === "in_progress")).toBe(true);

    const again = await callCase(a.runId, "c0", { owner: a.owner, key: CANARY });
    expect(again).toMatchObject({ status: 200, body: { servRequestId: "req-once" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });

  it("lets a team run take over a claim older than the stale window, and not a fresh one", async () => {
    const a = await teamRun(2);
    await db()`
      INSERT INTO case_results (run_id, case_id, config_idx, status, claimed_at) VALUES
        (${a.runId}, 'c0', 0, 'pending', now() - make_interval(secs => ${CONFIG.claimStaleSeconds + 30})),
        (${a.runId}, 'c1', 0, 'pending', now())`;
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY })).toMatchObject({ status: 202, body: { status: "in_progress" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });

  it("finishes a stale demo claim as lost and never spends on it again", async () => {
    const demo = await demoRun();
    const caseId = demo.cases[0]!;
    await db()`
      INSERT INTO case_results (run_id, case_id, config_idx, status, claimed_at)
      VALUES (${demo.runId}, ${caseId}, 0, 'pending', now() - make_interval(secs => ${CONFIG.claimStaleSeconds + 30}))`;
    for (let i = 0; i < 2; i++) {
      const r = await callCase(demo.runId, caseId, { owner: demo.owner });
      expect(r).toMatchObject({ status: 200, body: { status: "upstream_error", error: "lost", latencyMs: null } });
    }
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
  });
});

describe("C6: the daily demo budget holds under concurrency", () => {
  it("lets exactly three of ten concurrent demo calls through when the cap is three estimates", async () => {
    vi.setSystemTime(TIGHT_DAY);
    // One call on each of ten runs, so the per-run call cap never fires and only the budget refuses.
    const runs = await Promise.all(Array.from({ length: 10 }, () => demoRun()));
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => {
      await sleep(300);
      // No usage, so each call settles at the full estimate and the day ends exactly at the cap.
      return fixture(caseId, cfg, { usage: { inputTokens: null, outputTokens: null, cachedTokens: null } });
    });
    const all = await Promise.all(runs.map((d) => callCase(d.runId, d.cases[0]!, { owner: d.owner })));

    expect(engine.runCase).toHaveBeenCalledTimes(3);
    expect(all.filter((r) => r.status === 200)).toHaveLength(3);
    const refused = all.filter((r) => r.status === 429);
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(r.body).toEqual({ error: "budget_exhausted" });
    // Refused calls hand their claim back, so only the three that ran hold a row.
    const rows = await Promise.all(runs.map((d) => caseRows(d.runId)));
    expect(rows.flat()).toHaveLength(3);
    expect(await budgetRow(TIGHT_DAY)).toEqual({ reserved: "0.0000", spent: "0.0300" });
  });

  it("settles a demo call at its real cost from the price table, rounded up", async () => {
    const demo = await demoRun();
    const before = await budgetRow(MAIN_DAY);
    const r = await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner });
    expect(r).toMatchObject({ status: 200, body: { usage: { inputTokens: 1000, outputTokens: 200 } } });
    const rows = await caseRows(demo.runId);
    // 1,000 x 0.13 + 200 x 0.65, per million tokens.
    expect(Number(rows[0]!.est_cost_usd)).toBeCloseTo(0.00026, 10);
    const after = await budgetRow(MAIN_DAY);
    expect(Number(after!.spent) - Number(before!.spent)).toBeCloseTo(0.0003, 10);
    expect(after!.reserved).toBe(before!.reserved);
    expect(operator.reads).toBe(1);
  });
});

describe("C26: at most four case calls in flight per run", () => {
  const TEAM_CFG: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };

  it("claims at most four of ten simultaneous distinct cases on one run, three times over", async () => {
    for (let trial = 0; trial < 3; trial++) {
      const a = await teamRun(10);
      const outcomes = await Promise.allSettled(
        a.cases.map((caseId) => claimCase({ runId: a.runId, caseId, configIdx: 0 }, "team", TEAM_CFG)),
      );
      const claimedCount = outcomes.filter((o) => o.status === "fulfilled" && o.value.kind === "claimed").length;
      const busy = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof HttpError && o.reason.code === "run_busy");
      expect(claimedCount).toBe(CONFIG.concurrentCaseCallsPerRun);
      expect(busy).toHaveLength(10 - CONFIG.concurrentCaseCallsPerRun);
      expect(await caseRows(a.runId)).toHaveLength(CONFIG.concurrentCaseCallsPerRun);
    }
  });

  it("runs at most four of six concurrent calls at once and answers the rest 429 run_busy, spending nothing on them", async () => {
    const a = await teamRun(6);
    let inFlight = 0;
    let maxInFlight = 0;
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(3_000);
      inFlight--;
      return fixture(caseId, cfg);
    });
    const all = await Promise.all(a.cases.map((c) => callCase(a.runId, c, { owner: a.owner, key: CANARY })));

    expect(maxInFlight).toBeLessThanOrEqual(CONFIG.concurrentCaseCallsPerRun);
    const ok = all.filter((r) => r.status === 200);
    const busy = all.filter((r) => r.status !== 200);
    expect(engine.runCase).toHaveBeenCalledTimes(ok.length);
    expect(busy.length).toBeGreaterThanOrEqual(6 - CONFIG.concurrentCaseCallsPerRun);
    for (const r of busy) expect(r).toEqual({ status: 429, body: { error: "run_busy" } });
    // A refused call holds no row, so it can simply be called again once the run has room.
    expect(await caseRows(a.runId)).toHaveLength(ok.length);

    const busyCase = a.cases[all.findIndex((r) => r.status === 429)]!;
    expect(await callCase(a.runId, busyCase, { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });
  });

  it("does not count claims past the stale window, so a dead request cannot block a run", async () => {
    const a = await teamRun(5);
    for (const c of a.cases.slice(0, 4)) {
      await db()`
        INSERT INTO case_results (run_id, case_id, config_idx, status, claimed_at)
        VALUES (${a.runId}, ${c}, 0, 'pending', now() - make_interval(secs => ${CONFIG.claimStaleSeconds + 30}))`;
    }
    expect(await callCase(a.runId, a.cases[4]!, { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });
  });

  it("still replays a finished call's stored result while the run is full, without spending", async () => {
    const a = await teamRun(5);
    expect((await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).status).toBe(200);
    for (const c of a.cases.slice(1, 5)) {
      await db()`INSERT INTO case_results (run_id, case_id, config_idx, status) VALUES (${a.runId}, ${c}, 0, 'pending')`;
    }
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });
});

describe("demo case cap", () => {
  it("keeps the first twelve sample cases on a demo run and every case on a team run", async () => {
    const demo = await demoRun();
    expect(demo.cases).toHaveLength(CONFIG.demoCasesMax);
    expect(demo.cases[0]).toBe("INV-01");
    expect(demo.cases.at(-1)).toBe("INV-12");
    const team = await teamRun(15);
    expect(team.cases).toHaveLength(15);
    const rows = await db()`SELECT id, case_ids FROM runs WHERE id = ANY(${[demo.runId, team.runId]})`;
    const byId = new Map(rows.map((r) => [String(r.id), r.case_ids]));
    expect(byId.get(demo.runId)).toEqual(demo.cases);
    expect(byId.get(team.runId)).toEqual(team.cases);
  });
});

describe("C28: the operator's demo_off kill switch", () => {
  it("refuses a demo call with 429 budget_exhausted before any reservation, engine call or operator key read, and leaves team runs alone", async () => {
    const demo = await demoRun();
    const team = await teamRun(1);
    const before = await budgetRow(MAIN_DAY);
    flags.add("demo_off");

    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toEqual({ status: 429, body: { error: "budget_exhausted" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
    expect(await caseRows(demo.runId)).toHaveLength(0);
    expect(await budgetRow(MAIN_DAY)).toEqual(before);

    expect(await callCase(team.runId, "c0", { owner: team.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: "scored" } });

    flags.delete("demo_off");
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(operator.reads).toBe(1);
  });
});

describe("503 serv_unavailable: a call SERV never ran is released, not stored", () => {
  it("answers a team call that never connected, or got a 429, with 503, stores nothing, refunds the refusal charge and counts it as serv_unavailable", async () => {
    const a = await teamRun(1);
    const ip = freshIp();
    for (const [n, patch] of [[1, NEVER_SENT], [2, SERV_429]] as const) {
      engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, patch));
      expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 503, body: { error: "serv_unavailable" } });
      expect(await caseRows(a.runId)).toHaveLength(0);
      expect(await bucketCount(refusalBucket(ip))).toBe(0);
      expect(await bucketCount(unavailableBucket(ip))).toBe(n);
    }
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(3);
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    expect(await bucketCount(unavailableBucket(ip))).toBe(2);
  });

  it("never locks out a good key: thirty-one SERV outages in a row leave the key refusal budget untouched", async () => {
    const limit = CONFIG.keyRefusalsPerIpPerWindow;
    const a = await teamRun(1);
    const ip = freshIp();
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, NEVER_SENT));
    for (let i = 0; i <= limit; i++) {
      expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 503, body: { error: "serv_unavailable" } });
    }
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg));
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
  });

  it("answers a demo call that never connected, or got a 429, with 503, and hands back the reservation and the demo call charge", async () => {
    const demo = await demoRun();
    const ip = freshIp();
    const caseId = demo.cases[0]!;
    const before = await budgetRow(MAIN_DAY);
    const callsBefore = await budgetCalls(MAIN_DAY);
    for (const [n, patch] of [[1, NEVER_SENT], [2, SERV_429]] as const) {
      engine.runCase.mockImplementationOnce(async (_w: unknown, id: string, cfg: RunConfig) => fixture(id, cfg, patch));
      expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toEqual({ status: 503, body: { error: "serv_unavailable" } });
      expect(await caseRows(demo.runId)).toHaveLength(0);
      expect(await budgetRow(MAIN_DAY)).toEqual(before);
      expect(await budgetCalls(MAIN_DAY)).toBe(callsBefore);
      expect(await bucketCount(demoBucket(ip))).toBe(0);
      expect(await bucketCount(unavailableBucket(ip))).toBe(n);
    }
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(await budgetCalls(MAIN_DAY)).toBe(callsBefore + 1);
    expect(await bucketCount(demoBucket(ip))).toBe(1);
  });

  it("answers 503 serv_unavailable without sending once an address has spent its serv_unavailable bucket, on team and demo runs", async () => {
    const a = await teamRun(1);
    const demo = await demoRun();
    const ip = freshIp();
    await setBucket(unavailableBucket(ip), CONFIG.servUnavailablePerIpPerWindow);
    const before = await budgetRow(MAIN_DAY);

    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 503, body: { error: "serv_unavailable" } });
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, ip })).toEqual({ status: 503, body: { error: "serv_unavailable" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(await caseRows(demo.runId)).toHaveLength(0);
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    expect(await bucketCount(demoBucket(ip))).toBe(0);
    expect(await bucketCount(unavailableBucket(ip))).toBe(CONFIG.servUnavailablePerIpPerWindow);
    expect(await budgetRow(MAIN_DAY)).toEqual(before);

    // Another address is not affected.
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip: freshIp() })).toMatchObject({ status: 200, body: { status: "scored" } });
  });

  it("stores a 500, a timeout and a reset after sending, because SERV may have billed them", async () => {
    const a = await teamRun(3);
    const demo = await demoRun();
    const failures: Partial<CaseResult>[] = [
      { status: "upstream_error", answer: null, answerText: null, correct: false, httpStatus: 500, error: "http_500: boom" },
      { status: "timeout", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: null, servRequestId: null, error: "timeout" },
      { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: null, servRequestId: null, error: "network_error: ECONNRESET" },
    ];
    for (const [i, patch] of failures.entries()) {
      engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, patch));
      expect(await callCase(a.runId, `c${i}`, { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { status: patch.status } });
    }
    expect((await caseRows(a.runId)).map((r) => r.status)).toEqual(["upstream_error", "timeout", "upstream_error"]);

    const callsBefore = await budgetCalls(MAIN_DAY);
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, failures[0]));
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { httpStatus: 500 } });
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { httpStatus: 500 } });
    expect(engine.runCase).toHaveBeenCalledTimes(4);
    expect(await budgetCalls(MAIN_DAY)).toBe(callsBefore + 1);
  });
});

describe("C33: the refusal is charged before the key is sent and refunded when SERV accepts it", () => {
  it("lets at most 30 of 40 concurrent bad-key calls from one address reach the engine", async () => {
    const limit = CONFIG.keyRefusalsPerIpPerWindow;
    const runs = await Promise.all(Array.from({ length: 10 }, () => teamRun(CONFIG.concurrentCaseCallsPerRun)));
    const ip = freshIp();
    engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => {
      await sleep(300);
      return fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: 401, error: "http_401: invalid key [key]" });
    });
    const all = await Promise.all(runs.flatMap((r) => r.cases.map((c) => callCase(r.runId, c, { owner: r.owner, key: CANARY, ip }))));
    expect(all).toHaveLength(40);
    expect(engine.runCase.mock.calls.length).toBeLessThanOrEqual(limit);
    expect(engine.runCase).toHaveBeenCalledTimes(limit);
    expect(all.filter((r) => r.status === 401)).toHaveLength(limit);
    const refused = all.filter((r) => r.status === 429);
    expect(refused).toHaveLength(40 - limit);
    for (const r of refused) expect(r.body).toEqual({ error: "rate_limited" });
    const rows = await Promise.all(runs.map((r) => caseRows(r.runId)));
    expect(rows.flat()).toHaveLength(0);
  });

  it("refunds the charge for a 2xx, a 5xx or no answer, and sends a team call with no output cap", async () => {
    const a = await teamRun(3);
    const ip = freshIp();
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, httpStatus: 503, error: "http_503: busy" }),
    );
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { httpStatus: 503 } });
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { status: "timeout", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus: null, servRequestId: null, error: "timeout" }),
    );
    expect(await callCase(a.runId, "c2", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "timeout" } });
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    expect(engine.runCase.mock.calls[0]![4]).toBeUndefined();
  });

  it("refunds the charge and releases the claim when the engine throws before sending", async () => {
    const a = await teamRun(1);
    const ip = freshIp();
    engine.runCase.mockImplementationOnce(async () => {
      throw new Error("engine refused before sending");
    });
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 500, body: { error: "internal" } });
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    expect(await caseRows(a.runId)).toHaveLength(0);
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
  });

  it("keeps the charge for every other 4xx SERV answers, 400, 403, 404 and 422, and stores each one", async () => {
    const statuses = [400, 403, 404, 422];
    const a = await teamRun(statuses.length);
    const ip = freshIp();
    for (const [i, httpStatus] of statuses.entries()) {
      engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
        fixture(caseId, cfg, { status: "upstream_error", answer: null, answerText: null, correct: false, usage: NO_USAGE, httpStatus, error: `http_${httpStatus}: no` }),
      );
      expect(await callCase(a.runId, `c${i}`, { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "upstream_error", httpStatus } });
      expect(await bucketCount(refusalBucket(ip))).toBe(i + 1);
    }
    expect((await caseRows(a.runId)).map((r) => r.status)).toEqual(statuses.map(() => "upstream_error"));
  });

  it("counts nothing for an attempt the limit refuses, so a refund hands back a real charge", async () => {
    const limit = CONFIG.keyRefusalsPerIpPerWindow;
    const ip = freshIp();
    const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
    await setBucket(refusalBucket(ip), limit - 1);
    const window = await enforceRateLimit("key_refusals", hash);
    expect(await bucketCount(refusalBucket(ip))).toBe(limit);
    for (let i = 0; i < 5; i++) {
      await expect(enforceRateLimit("key_refusals", hash)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    }
    expect(await bucketCount(refusalBucket(ip))).toBe(limit);
    await refundRateLimit("key_refusals", hash, window);
    expect(await bucketCount(refusalBucket(ip))).toBe(limit - 1);
    await enforceRateLimit("key_refusals", hash);
    await expect(enforceRateLimit("key_refusals", hash)).rejects.toMatchObject({ status: 429 });
    expect(await bucketCount(refusalBucket(ip))).toBe(limit);
  });
});

describe("demo calls are limited per address", () => {
  it("refuses the 73rd demo call from one address in an hour with 429 rate_limited, before any engine call, and hands back its reservation", async () => {
    const demo = await demoRun();
    const ip = freshIp();
    await setBucket(demoBucket(ip), CONFIG.demoCallsPerIpPerWindow - 1);

    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase.mock.calls[0]![4]).toEqual({ maxCompletionTokens: CONFIG.demoMaxCompletionTokens });
    const before = await budgetRow(MAIN_DAY);
    const callsBefore = await budgetCalls(MAIN_DAY);

    expect(await callCase(demo.runId, demo.cases[1]!, { owner: demo.owner, ip })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
    expect(operator.reads).toBe(1);
    expect(await budgetRow(MAIN_DAY)).toEqual(before);
    expect(await budgetCalls(MAIN_DAY)).toBe(callsBefore);
    expect((await caseRows(demo.runId)).map((r) => r.case_id)).toEqual([demo.cases[0]]);

    // A replay spends nothing, so it is not counted; another address is not affected.
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(await callCase(demo.runId, demo.cases[1]!, { owner: demo.owner, ip: freshIp() })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);
  });

  it("charges the address only for demo calls past the warm check and the day's budget", async () => {
    const demo = await demoRun([LUNA_RAW, LUNA_PLAIN]);
    const ip = freshIp();
    const caseId = demo.cases[0]!;
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip, config: ["1"] })).toEqual({ status: 429, body: { error: "budget_exhausted" } });
    expect(await bucketCount(demoBucket(ip))).toBe(0);
    flags.add("demo_off");
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toEqual({ status: 429, body: { error: "budget_exhausted" } });
    expect(await bucketCount(demoBucket(ip))).toBe(0);
    flags.delete("demo_off");
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(await caseRows(demo.runId)).toHaveLength(0);
    expect(await callCase(demo.runId, caseId, { owner: demo.owner, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(await bucketCount(demoBucket(ip))).toBe(1);
  });
});

describe("C28: demo calls other than raw stop once the sample prompts may have gone cold", () => {
  it("refuses a demo plain call with 429 budget_exhausted after CONFIG.samplePromptsWarmUntilMs, and still runs raw", async () => {
    expect(Date.now()).toBeGreaterThanOrEqual(CONFIG.samplePromptsWarmUntilMs);
    const demo = await demoRun([LUNA_RAW, LUNA_PLAIN]);
    const before = await budgetRow(MAIN_DAY);
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, config: ["1"] })).toEqual({ status: 429, body: { error: "budget_exhausted" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
    expect(await caseRows(demo.runId)).toHaveLength(0);
    expect(await budgetRow(MAIN_DAY)).toEqual(before);
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, config: ["0"] })).toMatchObject({ status: 200, body: { status: "scored" } });
  });
});

describe("C4: a demo call re-checks its setting against the sample's allowlist", () => {
  it("refuses a demo run whose setting is not on the sample's allowlist, before any charge or operator key read", async () => {
    const runId = newId();
    const owner = newOwnerToken();
    const ip = freshIp();
    created.runs.push(runId);
    await db()`
      INSERT INTO runs (id, workload_id, report_id, owner_hash, payer, configs, case_ids)
      VALUES (${runId}, ${SAMPLE}, ${newId()}, ${hashToken(owner)}, 'demo',
              ${JSON.stringify([{ model: "gpt-6-luna", mode: "guard", keepContentFilter: false }])}::jsonb, '["INV-01"]'::jsonb)`;
    expect(await callCase(runId, "INV-01", { owner, ip })).toEqual({ status: 403, body: { error: "config_not_allowed" } });
    expect(engine.runCase).not.toHaveBeenCalled();
    expect(operator.reads).toBe(0);
    expect(await caseRows(runId)).toHaveLength(0);
    expect(await bucketCount(demoBucket(ip))).toBe(0);
  });
});

describe("a paid answer is never lost to text Postgres cannot store", () => {
  it("stores and returns an answer holding a lone surrogate, made well formed, instead of a 500", async () => {
    const a = await teamRun(1);
    const half = "pay \ud83d";
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) =>
      fixture(caseId, cfg, { answer: { verdict: half, ["k\udc00"]: "x\u0000" }, answerText: `{"verdict":"${half}"}` }),
    );
    const r = await callCase(a.runId, "c0", { owner: a.owner, key: CANARY });
    expect(r).toMatchObject({ status: 200, body: { answer: { verdict: "pay �", "k�": "x�" }, answerText: '{"verdict":"pay �"}' } });
    const rows = await caseRows(a.runId);
    expect(rows[0]).toMatchObject({ status: "scored", result: { answerText: '{"verdict":"pay �"}' } });
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toMatchObject({ status: 200, body: { answer: { verdict: "pay �" } } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });

  it("returns the stored result with 200 when settling a demo call fails after the result was stored", async () => {
    vi.setSystemTime(SETTLE_DAY);
    const day = budgetDay(SETTLE_DAY);
    created.days.push(day);
    await db()`INSERT INTO demo_budget (day, cap_usd) VALUES (${day}::date, 1)`;
    const demo = await demoRun();
    const logStart = logs.length;
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) => {
      await db()`DELETE FROM demo_budget WHERE day = ${day}::date`;
      return fixture(caseId, cfg, { servRequestId: "req-settle" });
    });
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { status: "scored", servRequestId: "req-settle" } });
    expect(logs.slice(logStart).some((l) => l.includes("stored but not settled"))).toBe(true);
    const rows = await caseRows(demo.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.finished_at).not.toBeNull();
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { servRequestId: "req-settle" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });
});

describe("C26: a database past its size stop takes no new claim", () => {
  it("answers a new team or demo claim with 503 storage_full before any claim, charge or SERV call, and still replays a finished call", async () => {
    const a = await teamRun(2);
    const demo = await demoRun();
    const ip = freshIp();
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    const before = await budgetRow(MAIN_DAY);

    stop.bytes = 1;
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY, ip })).toEqual({ status: 503, body: { error: "storage_full" } });
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner, ip })).toEqual({ status: 503, body: { error: "storage_full" } });
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.runCase).toHaveBeenCalledTimes(1);
    expect(operator.reads).toBe(0);
    expect((await caseRows(a.runId)).map((r) => r.case_id)).toEqual(["c0"]);
    expect(await caseRows(demo.runId)).toHaveLength(0);
    expect(await bucketCount(refusalBucket(ip))).toBe(0);
    expect(await bucketCount(demoBucket(ip))).toBe(0);
    expect(await budgetRow(MAIN_DAY)).toEqual(before);

    stop.bytes = Number.MAX_SAFE_INTEGER;
    expect(await callCase(a.runId, "c1", { owner: a.owner, key: CANARY, ip })).toMatchObject({ status: 200, body: { status: "scored" } });
  });
});

describe("a paid answer survives one failed save", () => {
  it("saves again when the first save throws before storing, and returns the fresh result", async () => {
    const a = await teamRun(1);
    saves.fail = 1;
    const r = await callCase(a.runId, "c0", { owner: a.owner, key: CANARY });
    expect(r).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(saves.calls).toBe(2);
    const rows = await caseRows(a.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.finished_at).not.toBeNull();
    expect(rows[0]!.result).toMatchObject({ servRequestId: r.body.servRequestId });
    expect(logs.some((l) => l.includes("storing a paid result failed, trying once more"))).toBe(true);
  });

  it("returns the stored row when the first save committed but its answer was lost, without writing twice", async () => {
    const demo = await demoRun();
    const callsBefore = await budgetCalls(MAIN_DAY);
    saves.fail = 1;
    saves.commitFirst = true;
    engine.runCase.mockImplementationOnce(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg, { servRequestId: "req-saved-once" }));
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { servRequestId: "req-saved-once" } });
    expect(saves.calls).toBe(2);
    expect(await caseRows(demo.runId)).toHaveLength(1);
    expect(await budgetCalls(MAIN_DAY)).toBe(callsBefore + 1);
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });

  it("gives up after the one retry and answers 500, leaving the claim pending for the stale window", async () => {
    const a = await teamRun(1);
    saves.fail = 2;
    expect(await callCase(a.runId, "c0", { owner: a.owner, key: CANARY })).toEqual({ status: 500, body: { error: "internal" } });
    expect(saves.calls).toBe(2);
    expect((await caseRows(a.runId)).map((r) => r.status)).toEqual(["pending"]);
  });
});

describe("C28: a demo call reads the price list once", () => {
  it("prices the reservation and the settle from the same live list, even when the list changes mid-call", async () => {
    const demo = await demoRun();
    const before = await budgetRow(MAIN_DAY);
    // A live price well above the table's; a second read would find no list and fall back to the table.
    prices.next = [[{ id: "gpt-6-luna", inputUsdPerM: 1, outputUsdPerM: 2 }], null];
    expect(await callCase(demo.runId, demo.cases[0]!, { owner: demo.owner })).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(prices.reads).toBe(1);
    const rows = await caseRows(demo.runId);
    // 1,000 x 1 + 200 x 2, per million tokens.
    expect(Number(rows[0]!.est_cost_usd)).toBeCloseTo(0.0014, 10);
    const after = await budgetRow(MAIN_DAY);
    expect(Number(after!.spent) - Number(before!.spent)).toBeCloseTo(0.0014, 10);
    expect(after!.reserved).toBe(before!.reserved);
  });
});

describe("C35: a claim is released through urai_release_claim(), which cannot touch a stored answer", () => {
  it("is a SECURITY DEFINER function with a fixed search_path that the public cannot run", async () => {
    const fns = await db()`
      SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner, has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc WHERE proname = 'urai_release_claim' AND pronamespace = 'public'::regnamespace`;
    const owner = String((await db()`SELECT current_user AS u`)[0]!.u);
    expect(fns).toEqual([{ prosecdef: true, proconfig: ["search_path=pg_catalog, public"], owner, public_exec: false }]);
  });

  it("deletes an unfinished claim under its own mark only, and never a finished one", async () => {
    const a = await teamRun(2);
    const cfg: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };
    const pending = await claimCase({ runId: a.runId, caseId: "c0", configIdx: 0 }, "team", cfg);
    const done = await claimCase({ runId: a.runId, caseId: "c1", configIdx: 0 }, "team", cfg);
    if (pending.kind !== "claimed" || done.kind !== "claimed") throw new Error("test claims were not made");
    await db()`UPDATE case_results SET status = 'scored', result = '{}'::jsonb, finished_at = now() WHERE run_id = ${a.runId} AND case_id = 'c1'`;

    expect(await releaseClaim({ runId: a.runId, caseId: "c0", configIdx: 0 }, "1.5")).toBe(false);
    expect(await releaseClaim({ runId: a.runId, caseId: "c1", configIdx: 0 }, done.mark)).toBe(false);
    expect((await caseRows(a.runId)).map((r) => r.case_id)).toEqual(["c0", "c1"]);
    expect(await releaseClaim({ runId: a.runId, caseId: "c0", configIdx: 0 }, pending.mark)).toBe(true);
    expect((await caseRows(a.runId)).map((r) => [r.case_id, r.status])).toEqual([["c1", "scored"]]);
  });
});

describe("C14 and C22", () => {
  it("never reads a body on the case endpoint", async () => {
    const a = await teamRun(1);
    const r = await callCase(a.runId, "c0", { owner: a.owner, key: CANARY, body: "x".repeat(CONFIG.bodyMaxBytes + 1024) });
    expect(r.status).toBe(200);
  });

  it("never allows cross-origin reads and never lets a response be cached", () => {
    expect(responses.length).toBeGreaterThan(40);
    for (const { res } of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
