/*
 * The report builder as a pure function, then the share and report routes against the real Neon
 * database with finished case rows inserted directly, so the engine is never called and nothing
 * is spent. Then the sample cache in lib/samples.ts, with a stand-in clock. Not covered here: how
 * the report page renders this JSON (C20 is the frontend's), any export of it (C21), workloads past
 * their retention date, and the sample cache under concurrent callers in one instance.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { RunConfig, Workload } from "@urai/engine";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GET as getPublicReport } from "../app/api/reports/[reportId]/route";
import { GET as getOwnerReport } from "../app/api/runs/[id]/report/route";
import { POST as postShare } from "../app/api/runs/[id]/share/route";
import { POST as postRun } from "../app/api/runs/route";
import { POST as postWorkload } from "../app/api/workloads/route";
import { CONFIG, OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { HttpError } from "../lib/http";
import { hashToken, newId, newOwnerToken } from "../lib/ids";
import { ipHash } from "../lib/ip";
import { buildReport, type ReportRow, type StoredResult } from "../lib/report";
import { cachedSample } from "../lib/samples";

const BASE = "http://localhost:3000";
const LUNA_RAW: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };
const LUNA_PLAIN: RunConfig = { model: "gpt-6-luna", mode: "plain", keepContentFilter: false };

const created = { workloads: [] as string[], runs: [] as string[], buckets: [] as string[] };

function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
  created.buckets.push(`workloads:${hash}`, `runs:${hash}`, `report:${hash}`);
  return ip;
}

const LONG = "y".repeat(5_000);

const WORKLOAD: Workload = {
  name: "Report test",
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
  cases: [
    { id: "c0", input: LONG, expected: { verdict: "pay" } },
    { id: "c1", input: "invoice 1", expected: { verdict: "hold" } },
    { id: "c2", input: "invoice 2", expected: { verdict: "pay" } },
  ],
};

function stored(patch: Partial<StoredResult> = {}): StoredResult {
  return {
    status: "scored",
    correct: true,
    answer: { verdict: "pay" },
    answerText: '{"verdict":"pay"}',
    latencyMs: 100,
    usage: { inputTokens: 1000, outputTokens: 200 },
    ...patch,
  };
}

function row(caseId: string, configIdx: number, result: StoredResult, estCostUsd: number | null = 0.00026): ReportRow {
  return { caseId, configIdx, result, estCostUsd };
}

afterAll(async () => {
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${created.workloads}) AND NOT is_sample`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe("buildReport", () => {
  const base = {
    workload: WORKLOAD,
    configs: [LUNA_RAW, LUNA_PLAIN],
    caseIds: ["c0", "c1", "c2"],
    balance: { before: null, after: null },
  };

  it("adds up each configuration and keeps a total null when any part of it is null (C17, C25)", () => {
    const report = buildReport({
      ...base,
      rows: [
        row("c0", 0, stored()),
        row("c1", 0, stored({ correct: false, latencyMs: 300 })),
        row("c0", 1, stored({ usage: { inputTokens: null, outputTokens: 50 }, latencyMs: null }), null),
        row("c1", 1, stored({ status: "filtered", correct: false, answer: null })),
      ],
    });
    expect(report.totals[0]).toEqual({
      calls: 2,
      scored: 2,
      correct: 1,
      accuracy: 0.5,
      statusCounts: { scored: 2 },
      meanLatencyMs: 200,
      inputTokens: 2000,
      outputTokens: 400,
      estCostUsd: 0.00052,
    });
    expect(report.totals[1]).toMatchObject({
      calls: 2,
      scored: 1,
      correct: 1,
      statusCounts: { scored: 1, filtered: 1 },
      meanLatencyMs: null,
      inputTokens: null,
      outputTokens: 250,
      estCostUsd: null,
    });
  });

  it("reports an empty configuration as zero calls with no accuracy, not as zero accuracy", () => {
    const report = buildReport({ ...base, rows: [] });
    expect(report.totals[0]).toMatchObject({ calls: 0, accuracy: null, meanLatencyMs: null, inputTokens: 0 });
    expect(report.cases.every((c) => c.results.every((r) => r === null))).toBe(true);
    expect(report.balance).toBeNull();
    expect(report.disagreements).toEqual([]);
  });

  it("caps case input and answer text at 2,000 characters", () => {
    const report = buildReport({ ...base, rows: [row("c0", 0, stored({ answerText: LONG }))] });
    expect(CONFIG.reportTextMaxChars).toBe(2_000);
    expect(report.cases[0]!.input).toHaveLength(2_000);
    expect(report.cases[0]!.results[0]!.answerText).toHaveLength(2_000);
  });

  it("lists the cases where configurations disagree on correct, ignoring calls not yet made", () => {
    const report = buildReport({
      ...base,
      rows: [
        row("c0", 0, stored()),
        row("c0", 1, stored({ correct: false })),
        row("c1", 0, stored()),
        row("c1", 1, stored()),
        row("c2", 0, stored({ correct: false })),
      ],
    });
    expect(report.disagreements).toEqual(["c0"]);
  });

  it("keeps a single balance reading and attaches the lint findings for the run's settings", () => {
    const report = buildReport({ ...base, balance: { before: 3.5, after: null }, rows: [] });
    expect(report.balance).toEqual({ before: 3.5, after: null });
    expect(report.lint.map((f) => f.id)).toContain("first-sight-cost");
    expect(report.configs).toEqual([LUNA_RAW, LUNA_PLAIN]);
  });

  it("caps an answer by the indented form the page renders, so a small deeply nested answer is dropped (C29)", () => {
    let nested: unknown = [];
    for (let i = 1; i < 990; i++) nested = [nested];
    const answer = { a: nested };
    const compact = JSON.stringify(answer).length;
    const rendered = JSON.stringify(answer, null, 2).length;
    // Under the cap in the compact form, so only the rendered measure can catch it.
    expect(compact).toBeLessThanOrEqual(CONFIG.reportAnswerMaxChars);
    expect(rendered).toBeGreaterThan(1_000_000);

    const report = buildReport({ ...base, rows: [row("c0", 0, stored({ answer }))] });
    expect(report.cases[0]!.results[0]).toMatchObject({ answer: null, answerTruncatedChars: rendered });
  });

  it("refuses a row that names a case or configuration outside the run", () => {
    expect(() => buildReport({ ...base, rows: [row("c9", 0, stored())] })).toThrow();
    expect(() => buildReport({ ...base, rows: [row("c0", 2, stored())] })).toThrow();
  });
});

async function json(p: Promise<Response>): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await p;
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

// Its own address per read, for the same reason as publicReport: the owner's route counts in the "report" bucket too.
function ownerReport(runId: string, owner?: string, ip = freshIp()) {
  const headers: Record<string, string> = owner === undefined ? { "x-real-ip": ip } : { [OWNER_HEADER]: owner, "x-real-ip": ip };
  return json(getOwnerReport(new Request(`${BASE}/api/runs/${runId}/report`, { headers }), { params: Promise.resolve({ id: runId }) }));
}

// Its own address per read: the public route is rate-limited since C31, and a shared bucket would tie tests together.
function publicReport(reportId: string) {
  const req = new Request(`${BASE}/api/reports/${reportId}`, { headers: { "x-real-ip": freshIp() } });
  return json(getPublicReport(req, { params: Promise.resolve({ reportId }) }));
}

function share(runId: string, owner?: string) {
  const headers: Record<string, string> = owner === undefined ? {} : { [OWNER_HEADER]: owner };
  return json(postShare(new Request(`${BASE}/api/runs/${runId}/share`, { method: "POST", headers }), { params: Promise.resolve({ id: runId }) }));
}

describe("share and report routes (C9, C11)", () => {
  it("serves the report to the owner, publishes it only on the owner's say, and leaks no id or token", async () => {
    const ip = freshIp();
    const w = await json(
      postWorkload(
        new Request(`${BASE}/api/workloads`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": ip },
          body: JSON.stringify({ workload: WORKLOAD }),
        }),
      ),
    );
    const workloadId = String(w.body.workloadId);
    const workloadOwner = String(w.body.ownerToken);
    created.workloads.push(workloadId);
    const r = await json(
      postRun(
        new Request(`${BASE}/api/runs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": ip, [OWNER_HEADER]: workloadOwner },
          body: JSON.stringify({ workloadId, configs: [LUNA_RAW, LUNA_PLAIN], payer: "team" }),
        }),
      ),
    );
    const runId = String(r.body.runId);
    const reportId = String(r.body.reportId);
    const owner = String(r.body.ownerToken);
    created.runs.push(runId);

    const result = { caseId: "c0", config: LUNA_RAW, fieldScores: [], finishReason: "stop", servRequestId: "req-1", httpStatus: 200, error: null, ...stored() };
    await db()`
      INSERT INTO case_results (run_id, case_id, config_idx, status, result, est_cost_usd, finished_at) VALUES
        (${runId}, 'c0', 0, 'scored', ${JSON.stringify(result)}::jsonb, 0.00026, now()),
        (${runId}, 'c1', 0, 'pending', NULL, NULL, NULL)`;

    const mine = await ownerReport(runId, owner);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      name: "Report test",
      totals: [{ calls: 1, correct: 1, estCostUsd: 0.00026 }, { calls: 0 }],
      balance: null,
    });
    expect((mine.body.cases as { results: unknown[] }[])[1]!.results).toEqual([null, null]);

    for (const token of [undefined, workloadOwner, reportId, runId]) {
      expect((await ownerReport(runId, token)).status).toBe(404);
    }
    expect((await ownerReport(reportId, owner)).status).toBe(404);

    expect(await publicReport(reportId)).toMatchObject({ status: 404, body: { error: "not_found" } });
    for (const token of [undefined, workloadOwner, reportId]) {
      expect((await share(runId, token)).status).toBe(404);
    }
    expect((await publicReport(reportId)).status).toBe(404);

    expect(await share(runId, owner)).toMatchObject({ status: 200, body: { reportId } });
    const pub = await publicReport(reportId);
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual(mine.body);
    expect((await publicReport(runId)).status).toBe(404);

    for (const text of [mine.text, pub.text]) {
      for (const secret of [runId, reportId, workloadId, owner, workloadOwner, hashToken(owner), hashToken(workloadOwner), "req-1"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("answers 404 to a report id that was never issued", async () => {
    expect((await publicReport(newId())).status).toBe(404);
    expect((await publicReport("not-an-id")).status).toBe(404);
  });

  it("charges the owner's report reads to the per-address report bucket before any lookup (C31)", async () => {
    const ip = freshIp();
    const bucket = `report:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`;
    expect((await ownerReport(newId(), newOwnerToken(), ip)).status).toBe(404);
    expect((await db()`SELECT count FROM rate_limits WHERE bucket = ${bucket}`).map((r) => r.count)).toEqual([1]);

    await db()`UPDATE rate_limits SET count = ${CONFIG.reportPerIpPerWindow} WHERE bucket = ${bucket}`;
    expect(await ownerReport(newId(), newOwnerToken(), ip)).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });
});

describe("sample cache", () => {
  it("serves the last good copy when a refresh fails, and surfaces only a first-ever failure or a 404", async () => {
    const name = `test:${randomBytes(6).toString("hex")}`;
    let now = Date.UTC(2026, 8, 26, 12);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const later = () => {
      now += CONFIG.sampleCacheSeconds * 1000 + 1;
    };
    try {
      await expect(cachedSample(name, () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
      expect(await cachedSample(name, () => Promise.resolve("v1"))).toBe("v1");

      later();
      const failing = vi.fn(() => Promise.reject(new Error("db down")));
      expect(await cachedSample(name, failing)).toBe("v1");
      expect(await cachedSample(name, failing)).toBe("v1");
      expect(failing).toHaveBeenCalledTimes(1);

      later();
      expect(await cachedSample(name, () => Promise.resolve("v2"))).toBe("v2");
      later();
      await expect(cachedSample(name, () => Promise.reject(new HttpError(404, "not_found")))).rejects.toThrow("not_found");
      later();
      await expect(cachedSample(name, () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    } finally {
      clock.mockRestore();
    }
  });
});
