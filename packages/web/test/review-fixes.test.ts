/*
 * The backend gate review fixes, C28 to C32, against the real Neon database. The engine's runCase
 * and readBalance are replaced by fixtures and the server-wide probe_ran flag lives in memory, so
 * no request reaches SERV, no money moves, and the live app's demo is never stopped. Demo days are
 * made-up days in the 2100s, apart from the ones cases.test.ts uses.
 * Not covered here: the real 402 balance text (packages/engine/test/balance.test.ts), the SQL
 * form of the flag check inside reserveDemoCall (the in-memory flag stands in for the table), a
 * status body over its cap (unreachable with the capped inputs, read in review), a real SERV
 * price change, and Vercel's function time limits.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { type CaseResult, isPlausibleKey, LIMITS, type RunConfig, type Workload } from "@urai/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPublicReport } from "../app/api/reports/[reportId]/route";
import { GET as getRun } from "../app/api/runs/[id]/route";
import { POST as postCase } from "../app/api/runs/[id]/cases/[caseId]/route";
import { POST as postShare } from "../app/api/runs/[id]/share/route";
import { POST as postUnshare } from "../app/api/runs/[id]/unshare/route";
import { POST as postRun } from "../app/api/runs/route";
import { POST as postWorkload } from "../app/api/workloads/route";
import { budgetDay } from "../lib/budget";
import { CONFIG, OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { HttpError } from "../lib/http";
import { newId, newOwnerToken } from "../lib/ids";
import { ipHash } from "../lib/ip";
import { checkOperatorSpend, isOperatorProbeCall } from "../lib/operator-balance";
import { callCostUsd } from "../lib/prices";
import { assertReportSize, buildReport, type ReportRow } from "../lib/report";

const engine = vi.hoisted(() => ({ runCase: vi.fn(), readBalance: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, runCase: engine.runCase, readBalance: engine.readBalance };
});

const flags = vi.hoisted(() => new Set<string>());
vi.mock("../lib/flags", () => ({
  isSet: async (name: string) => flags.has(name),
  setFlag: async (name: string) => {
    flags.add(name);
  },
}));

const BASE = "http://localhost:3000";
const SAMPLE = "sample-invoices-good";
const LUNA_RAW: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };

const created = { workloads: [] as string[], runs: [] as string[], buckets: [] as string[], days: [] as string[] };

const FIRST_DAY = (() => {
  const r = randomBytes(3);
  return Date.UTC(2100 + (r[0]! % 10), r[1]! % 12, 1 + (r[2]! % 28), 12);
})();

// One random base per run and a distinct offset per test, so no two tests share a budget day.
function futureDay(offset: number): Date {
  return new Date(FIRST_DAY + offset * 86_400_000);
}

function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
  created.buckets.push(`workloads:${hash}`, `runs:${hash}`, `report:${hash}`);
  return ip;
}

async function body(p: Promise<Response>): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await p;
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

function post(path: string, payload: unknown, ip: string, owner?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip };
  if (owner !== undefined) headers[OWNER_HEADER] = owner;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

function workload(cases: number): Record<string, unknown> {
  return {
    name: "Review fixes test",
    systemPrompt: "Decide pay or hold.",
    context: null,
    answerSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
    shadowHint: null,
    scoring: [{ field: "verdict", rule: "exact" }],
    cases: Array.from({ length: cases }, (_, i) => ({ id: `c${i}`, input: `invoice ${i}`, expected: { verdict: "pay" } })),
  };
}

async function newWorkload(ip: string) {
  const w = await body(postWorkload(post("/api/workloads", { workload: workload(2) }, ip)));
  expect(w.status).toBe(201);
  created.workloads.push(String(w.body.workloadId));
  return { workloadId: String(w.body.workloadId), owner: String(w.body.ownerToken) };
}

async function teamRun() {
  const ip = freshIp();
  const w = await newWorkload(ip);
  const r = await body(postRun(post("/api/runs", { workloadId: w.workloadId, configs: [LUNA_RAW], payer: "team" }, ip, w.owner)));
  expect(r.status).toBe(201);
  created.runs.push(String(r.body.runId));
  return { runId: String(r.body.runId), reportId: String(r.body.reportId), owner: String(r.body.ownerToken) };
}

async function demoRun() {
  const r = await body(postRun(post("/api/runs", { workloadId: SAMPLE, configs: [LUNA_RAW], payer: "demo" }, freshIp())));
  expect(r.status).toBe(201);
  created.runs.push(String(r.body.runId));
  return { runId: String(r.body.runId), owner: String(r.body.ownerToken), cases: r.body.cases as string[] };
}

function demoCall(run: { runId: string; owner: string }, caseId: string) {
  const req = new Request(`${BASE}/api/runs/${run.runId}/cases/${caseId}?config=0`, { method: "POST", headers: { [OWNER_HEADER]: run.owner } });
  return body(postCase(req, { params: Promise.resolve({ id: run.runId, caseId }) }));
}

function fixture(caseId: string, config: RunConfig): CaseResult {
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
  };
}

async function openDay(day: Date, capUsd: number): Promise<string> {
  const d = budgetDay(day);
  created.days.push(d);
  await db()`INSERT INTO demo_budget (day, cap_usd) VALUES (${d}::date, ${capUsd}::numeric)`;
  vi.setSystemTime(day);
  return d;
}

async function dayRow(d: string) {
  const rows = await db()`
    SELECT balance_start_usd::text AS start, calls, stopped FROM demo_budget WHERE day = ${d}::date`;
  return rows[0];
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

beforeEach(() => {
  engine.runCase.mockReset();
  engine.readBalance.mockReset();
  engine.readBalance.mockResolvedValue({ ok: false, reason: "unavailable" });
  engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg));
  flags.clear();
});

afterAll(async () => {
  vi.useRealTimers();
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${created.workloads}) AND NOT is_sample`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
  await sql`DELETE FROM demo_budget WHERE day = ANY(${created.days}::date[])`;
});

describe("C28: the demo budget follows the operator's real balance", () => {
  it("reads the balance on the first call and every 20th, never in between", () => {
    expect([1, 2, 19, 20, 21, 40, 400].map(isOperatorProbeCall)).toEqual([true, false, false, true, false, true, true]);
    expect(CONFIG.demoOperatorProbeEvery).toBe(20);
  });

  it("stores the day's first reading, stops the day once the realised drop passes the cap, and refuses the next demo call", async () => {
    const d = await openDay(futureDay(0), 0.05);
    const run = await demoRun();

    engine.readBalance.mockResolvedValueOnce({ ok: true, usd: 3.4 });
    expect(await demoCall(run, run.cases[0]!)).toMatchObject({ status: 200, body: { status: "scored" } });
    expect(engine.readBalance).toHaveBeenCalledTimes(1);
    expect(isPlausibleKey(engine.readBalance.mock.calls[0]![0])).toBe(true);
    expect(await dayRow(d)).toEqual({ start: "3.4000", calls: 1, stopped: false });

    // Eighteen more calls happened; the next one is the day's 20th and reads again. 3.40 - 3.30 = 0.10 > 0.05.
    await db()`UPDATE demo_budget SET calls = 19 WHERE day = ${d}::date`;
    engine.readBalance.mockResolvedValueOnce({ ok: true, usd: 3.3 });
    expect((await demoCall(run, run.cases[1]!)).status).toBe(200);
    expect(await dayRow(d)).toEqual({ start: "3.4000", calls: 20, stopped: true });

    expect(await demoCall(run, run.cases[2]!)).toEqual({ status: 429, text: '{"error":"budget_exhausted"}', body: { error: "budget_exhausted" } });
    expect(engine.runCase).toHaveBeenCalledTimes(2);
    expect(await db()`SELECT 1 FROM case_results WHERE run_id = ${run.runId} AND case_id = ${run.cases[2]!}`).toHaveLength(0);
  });

  it("keeps the day open while the realised drop is within the cap", async () => {
    const d = await openDay(futureDay(1), 0.5);
    const run = await demoRun();
    engine.readBalance.mockResolvedValueOnce({ ok: true, usd: 3.4 }).mockResolvedValueOnce({ ok: true, usd: 3.2 });
    expect((await demoCall(run, run.cases[0]!)).status).toBe(200);
    await db()`UPDATE demo_budget SET calls = 19 WHERE day = ${d}::date`;
    expect((await demoCall(run, run.cases[1]!)).status).toBe(200);
    expect(await dayRow(d)).toEqual({ start: "3.4000", calls: 20, stopped: false });
    expect((await demoCall(run, run.cases[2]!)).status).toBe(200);
  });

  it("sets the global stop and stops the day when the probe was billed as a real call", async () => {
    const d = await openDay(futureDay(2), 1);
    const run = await demoRun();
    engine.readBalance.mockResolvedValueOnce({ ok: false, reason: "probe_ran" });
    expect((await demoCall(run, run.cases[0]!)).status).toBe(200);
    expect(flags.has("probe_ran")).toBe(true);
    expect(await dayRow(d)).toMatchObject({ start: null, stopped: true });
    expect(await demoCall(run, run.cases[1]!)).toMatchObject({ status: 429, body: { error: "budget_exhausted" } });

    // The global stop alone refuses a demo call on a fresh day, and no probe is sent while it is set.
    await openDay(futureDay(3), 1);
    const other = await demoRun();
    expect(await demoCall(other, other.cases[0]!)).toMatchObject({ status: 429, body: { error: "budget_exhausted" } });
    expect(await checkOperatorSpend(d)).toBe("probe_disabled");
    expect(engine.readBalance).toHaveBeenCalledTimes(1);
    expect(engine.runCase).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when the balance cannot be read", async () => {
    const d = await openDay(futureDay(4), 1);
    const run = await demoRun();
    expect((await demoCall(run, run.cases[0]!)).status).toBe(200);
    expect(engine.readBalance).toHaveBeenCalledTimes(1);
    expect(await dayRow(d)).toEqual({ start: null, calls: 1, stopped: false });
    expect(flags.size).toBe(0);
    expect((await demoCall(run, run.cases[1]!)).status).toBe(200);
  });

  it("stops the day without probing once the day's probe allowance is used up", async () => {
    const d = await openDay(futureDay(5), 1);
    const beyond = CONFIG.probesPerDayMax * CONFIG.demoOperatorProbeEvery;
    await db()`UPDATE demo_budget SET calls = ${beyond} WHERE day = ${d}::date`;
    expect(await checkOperatorSpend(d)).toBe("probe_limit");
    expect(engine.readBalance).not.toHaveBeenCalled();
    expect(await dayRow(d)).toMatchObject({ stopped: true });
  });
});

describe("C28: a call settles at the higher of the table price and SERV's live price", () => {
  const usage = { inputTokens: 1000, outputTokens: 200 };
  const table = (1000 * 0.13 + 200 * 0.65) / 1_000_000;

  it("uses the live price when it is higher, matching the model id through the one normaliser", () => {
    const live = [{ id: "GPT-6-LUNA", inputUsdPerM: 1, outputUsdPerM: 2 }];
    expect(callCostUsd({ model: " gpt-6-luna ", mode: "raw" }, usage, live)).toBeCloseTo((1000 * 1 + 200 * 2) / 1_000_000, 12);
  });

  it("uses the table price when it is higher", () => {
    const live = [{ id: "gpt-6-luna", inputUsdPerM: 0.01, outputUsdPerM: 0.01 }];
    expect(callCostUsd(LUNA_RAW, usage, live)).toBeCloseTo(table, 12);
    expect(callCostUsd(LUNA_RAW, usage, null)).toBeCloseTo(table, 12);
  });

  it("uses a live price alone for a model the table does not list, and is null when neither has it", () => {
    const live = [{ id: "gpt-6-astra", inputUsdPerM: 2, outputUsdPerM: 4 }];
    expect(callCostUsd({ model: "gpt-6-astra", mode: "raw" }, usage, live)).toBeCloseTo((1000 * 2 + 200 * 4) / 1_000_000, 12);
    expect(callCostUsd({ model: "gpt-6-nova", mode: "raw" }, usage, live)).toBeNull();
    expect(callCostUsd({ model: "gpt-6-nova", mode: "raw" }, usage, null)).toBeNull();
  });
});

describe("C29: every response body has a stated size cap", () => {
  it("returns status only from the run status route, never an answer", async () => {
    const run = await teamRun();
    const marker = `answer-${randomBytes(8).toString("hex")}`;
    const result = { ...fixture("c0", LUNA_RAW), answer: { verdict: marker }, answerText: marker };
    await db()`
      INSERT INTO case_results (run_id, case_id, config_idx, status, result, finished_at)
      VALUES (${run.runId}, 'c0', 0, 'scored', ${JSON.stringify(result)}::jsonb, now())`;
    const req = new Request(`${BASE}/api/runs/${run.runId}`, { headers: { [OWNER_HEADER]: run.owner } });
    const g = await body(getRun(req, { params: Promise.resolve({ id: run.runId }) }));
    expect(g.status).toBe(200);
    expect(g.text).not.toContain(marker);
    const results = g.body.results as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(["caseId", "configIdx", "finishedAt", "status"]);
  });

  it("keeps a report of 100 cases x 6 settings at every cap under the response cap, with room for the uncapped workload fields", () => {
    const worst = "\u0001";
    const configs: RunConfig[] = (["raw", "plain", "guard", "multipath", "full"] as const).map((mode) => ({ model: "gpt-6-luna", mode, keepContentFilter: false }));
    configs.push({ model: "gpt-6-astra", mode: "raw", keepContentFilter: false });
    const caseIds = Array.from({ length: LIMITS.casesMax }, (_, i) => `c${i}`);
    const w: Workload = {
      name: "Maximal",
      systemPrompt: worst.repeat(LIMITS.systemPromptMaxChars),
      context: worst.repeat(LIMITS.contextMaxChars),
      answerSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
      shadowHint: null,
      scoring: [{ field: "v", rule: "exact" }],
      cases: caseIds.map((id) => ({ id, input: worst.repeat(LIMITS.caseInputMaxChars), expected: { v: "pay" } })),
    };
    // The largest answer that is still shown in full: exactly the cap once serialised.
    const answer = { v: "x".repeat(CONFIG.reportAnswerMaxChars - JSON.stringify({ v: "" }).length) };
    expect(JSON.stringify(answer)).toHaveLength(CONFIG.reportAnswerMaxChars);
    const rows: ReportRow[] = caseIds.flatMap((caseId) =>
      configs.map((_, configIdx) => ({
        caseId,
        configIdx,
        estCostUsd: 0.00026,
        result: { status: "scored" as const, correct: true, answer, answerText: worst.repeat(LIMITS.answerMaxChars), latencyMs: 120_000, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      })),
    );

    const report = buildReport({ workload: w, configs, caseIds, balance: { before: 3.4, after: 3.3 }, rows });
    const bytes = Buffer.byteLength(JSON.stringify(report), "utf8");
    // Expected values, the schema and the name are not cut by the report; they came in under the body cap.
    expect(bytes + CONFIG.bodyMaxBytes).toBeLessThan(CONFIG.reportResponseMaxBytes);
    expect(assertReportSize(report)).toBe(report);
    expect(report.cases[0]!.results[0]!.answer).toEqual(answer);
    expect(Buffer.byteLength(JSON.stringify(report.cases[0]!.results[0]!.answerText), "utf8")).toBeLessThanOrEqual(CONFIG.reportTextMaxChars + 2);
    expect(report.systemPrompt).toMatchObject({ truncated: true, chars: LIMITS.systemPromptMaxChars });
    expect(report.context).toMatchObject({ truncated: true, chars: LIMITS.contextMaxChars });
  });

  it("replaces an oversized answer with the truncated marker and keeps the capped answer text", () => {
    const wide = { verdict: "x".repeat(5_000) };
    // Under the cap in characters, over it in bytes: three bytes each.
    const multibyte = { verdict: "€".repeat(1_000) };
    const w: Workload = { ...(workload(2) as unknown as Workload) };
    const rows: ReportRow[] = [
      { caseId: "c0", configIdx: 0, estCostUsd: null, result: { status: "scored", correct: true, answer: wide, answerText: JSON.stringify(wide), latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
      { caseId: "c1", configIdx: 0, estCostUsd: null, result: { status: "scored", correct: true, answer: multibyte, answerText: "ok", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
    ];
    const report = buildReport({ workload: w, configs: [LUNA_RAW], caseIds: ["c0", "c1"], balance: { before: null, after: null }, rows });
    expect(report.cases[0]!.results[0]!.answer).toBeNull();
    expect(report.cases[0]!.results[0]!.answerTruncatedChars).toBe(JSON.stringify(wide).length);
    // The text is kept, cut so it fits the cap once JSON-escaped: its four quote marks count two bytes each.
    const kept = report.cases[0]!.results[0]!.answerText!;
    expect(JSON.stringify(wide).startsWith(kept)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(kept), "utf8")).toBe(CONFIG.reportTextMaxChars + 2);
    expect(report.cases[1]!.results[0]!.answer).toBeNull();
    expect(report.cases[1]!.results[0]!.answerTruncatedChars).toBe(JSON.stringify(multibyte).length);
    expect(report.systemPrompt).toBe("Decide pay or hold.");

    let thrown: unknown;
    try {
      assertReportSize({ ...report, name: "x".repeat(CONFIG.reportResponseMaxBytes) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ status: 500, code: "response_too_large" });
  });
});

function publicReport(reportId: string, ip = freshIp()) {
  const req = new Request(`${BASE}/api/reports/${reportId}`, { headers: { "x-real-ip": ip } });
  return body(getPublicReport(req, { params: Promise.resolve({ reportId }) }));
}

function ownerPost(route: typeof postShare, path: string, runId: string, owner?: string) {
  const headers: Record<string, string> = owner === undefined ? {} : { [OWNER_HEADER]: owner };
  return body(route(new Request(`${BASE}${path}`, { method: "POST", headers }), { params: Promise.resolve({ id: runId }) }));
}

describe("C30: the owner can take a shared report back", () => {
  it("unshares only with the run's owner token, after which the public report is 404", async () => {
    const run = await teamRun();
    const other = await teamRun();
    expect((await ownerPost(postShare, `/api/runs/${run.runId}/share`, run.runId, run.owner)).status).toBe(200);
    expect((await publicReport(run.reportId)).status).toBe(200);

    for (const token of [undefined, other.owner, newOwnerToken(), run.reportId]) {
      expect(await ownerPost(postUnshare, `/api/runs/${run.runId}/unshare`, run.runId, token)).toMatchObject({ status: 404, body: { error: "not_found" } });
    }
    expect((await publicReport(run.reportId)).status).toBe(200);

    expect(await ownerPost(postUnshare, `/api/runs/${run.runId}/unshare`, run.runId, run.owner)).toMatchObject({ status: 200, body: { shared: false } });
    expect(await publicReport(run.reportId)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await db()`SELECT shared FROM runs WHERE id = ${run.runId}`)[0]?.shared).toBe(false);
    // The report id is not a run id on the unshare route either (C9).
    expect((await ownerPost(postUnshare, `/api/runs/${run.reportId}/unshare`, run.reportId, run.owner)).status).toBe(404);
  });
});

describe("C31: public report reads are rate-limited per client address", () => {
  it("answers the 121st read from one address in an hour with 429, and another address normally", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let batch = 0; batch < CONFIG.reportPerIpPerWindow / 20; batch++) {
      const replies = await Promise.all(Array.from({ length: 20 }, () => publicReport(newId(), ip)));
      statuses.push(...replies.map((r) => r.status));
    }
    expect(statuses).toHaveLength(CONFIG.reportPerIpPerWindow);
    expect(statuses.every((s) => s === 404)).toBe(true);
    expect(await publicReport(newId(), ip)).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect((await publicReport(newId())).status).toBe(404);
  }, 120_000);
});

describe("C32: one model id policy everywhere", () => {
  it("refuses two spellings of one model as a duplicate setting, and matches the demo allowlist on the canonical id", async () => {
    const ip = freshIp();
    const w = await newWorkload(ip);
    const dup = await body(
      postRun(post("/api/runs", { workloadId: w.workloadId, configs: [{ model: "gpt-6-luna", mode: "raw" }, { model: "GPT-6-LUNA", mode: "raw" }], payer: "team" }, ip, w.owner)),
    );
    expect(dup).toMatchObject({ status: 400, body: { error: "invalid_configs" } });

    const demo = await body(postRun(post("/api/runs", { workloadId: SAMPLE, configs: [{ model: " GPT-6-Luna ", mode: "raw" }], payer: "demo" }, freshIp())));
    expect(demo.status).toBe(201);
    created.runs.push(String(demo.body.runId));
    expect(demo.body.configs).toEqual([LUNA_RAW]);
  });
});
