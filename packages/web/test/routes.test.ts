/*
 * Calls the route handlers directly against the real Neon database. Not covered here: the
 * Next.js server itself (routing, its automatic OPTIONS reply), Vercel's rewriting of the IP
 * headers, rate limits under true concurrency, the case endpoint, the demo budget and reports
 * (part 2), the storage cap (storage.test.ts), and a database outage (the fail-closed branches are
 * read in review, not executed).
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { POST as postLint } from "../app/api/lint/route";
import { GET as getRun } from "../app/api/runs/[id]/route";
import { POST as postRun } from "../app/api/runs/route";
import { POST as postWorkload } from "../app/api/workloads/route";
import { CONFIG, OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { hashToken, newId } from "../lib/ids";
import { ipHash } from "../lib/ip";

const BASE = "http://localhost:3000";
const SAMPLE = "sample-invoices-good";

const created = { workloads: [] as string[], runs: [] as string[], buckets: [] as string[] };
const responses: Response[] = [];

// A fresh documentation-range IPv6 address per test, so no test shares a rate-limit bucket.
function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  // An invalid address would fall into the shared "unknown" bucket and the tests would collide.
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
  created.buckets.push(`workloads:${hash}`, `runs:${hash}`, `lint:${hash}`);
  return ip;
}

function workload(cases = 2): Record<string, unknown> {
  return {
    name: "Route test",
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

function jsonRequest(path: string, body: string, ip: string, owner?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip };
  if (owner !== undefined) headers[OWNER_HEADER] = owner;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body });
}

async function call(p: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await p;
  responses.push(res);
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

async function createWorkload(ip: string, w: unknown = workload()) {
  const r = await call(postWorkload(jsonRequest("/api/workloads", JSON.stringify({ workload: w }), ip)));
  if (r.status === 201) created.workloads.push(String(r.body.workloadId));
  return r;
}

async function createRun(ip: string, body: unknown, owner?: string) {
  const r = await call(postRun(jsonRequest("/api/runs", JSON.stringify(body), ip, owner)));
  if (r.status === 201) created.runs.push(String(r.body.runId));
  return r;
}

function readRun(runId: string, owner?: string) {
  const headers: Record<string, string> = {};
  if (owner !== undefined) headers[OWNER_HEADER] = owner;
  return call(getRun(new Request(`${BASE}/api/runs/${runId}`, { headers }), { params: Promise.resolve({ id: runId }) }));
}

const LUNA_RAW = { model: "gpt-6-luna", mode: "raw" };
const LUNA_PLAIN = { model: "gpt-6-luna", mode: "plain" };

afterAll(async () => {
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${created.workloads}) AND NOT is_sample`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe("POST /api/workloads", () => {
  it("stores a valid workload and keeps only the owner token's hash", async () => {
    const r = await createWorkload(freshIp());
    expect(r.status).toBe(201);
    const { workloadId, ownerToken } = r.body as { workloadId: string; ownerToken: string };
    expect(workloadId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await db()`
      SELECT owner_hash, is_sample, row_to_json(w)::text AS whole, size_bytes, octet_length(data::text) AS stored_bytes,
             extract(epoch FROM expires_at - now()) / 86400 AS days_left
      FROM workloads w WHERE id = ${workloadId}`;
    const row = rows[0];
    expect(row?.owner_hash).toBe(hashToken(ownerToken));
    expect(row?.is_sample).toBe(false);
    expect(row?.size_bytes).toBe(row?.stored_bytes);
    expect(Number(row?.size_bytes)).toBeGreaterThan(0);
    expect(String(row?.whole)).not.toContain(ownerToken);
    expect(Number(row?.days_left)).toBeGreaterThan(CONFIG.workloadRetentionDays - 0.01);
    expect(Number(row?.days_left)).toBeLessThanOrEqual(CONFIG.workloadRetentionDays);
  });

  it("refuses a workload over the case cap without echoing it", async () => {
    const r = await createWorkload(freshIp(), workload(CONFIG.casesPerWorkloadMax + 1));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_workload" });
  });

  it("refuses a 301 KB body with 413 before parsing it", async () => {
    const pad = "x".repeat(301 * 1024);
    const r = await call(postWorkload(jsonRequest("/api/workloads", JSON.stringify({ workload: pad }), freshIp())));
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: "body_too_large" });
  });

  it("refuses a body that is not declared as JSON", async () => {
    const req = new Request(`${BASE}/api/workloads`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-real-ip": freshIp() },
      body: JSON.stringify({ workload: workload() }),
    });
    const r = await call(postWorkload(req));
    expect(r.status).toBe(415);
  });

  it("returns 429 on the 21st workload from one IP in an hour", async () => {
    const ip = freshIp();
    for (let i = 0; i < CONFIG.workloadsPerIpPerWindow; i++) {
      expect((await createWorkload(ip)).status).toBe(201);
    }
    const r = await createWorkload(ip);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "rate_limited" });
    expect((await createWorkload(freshIp())).status).toBe(201);
  }, 180_000);
});

describe("POST /api/runs", () => {
  it("creates a team run only with the workload's owner token", async () => {
    const ip = freshIp();
    const w = await createWorkload(ip);
    const { workloadId, ownerToken } = w.body as { workloadId: string; ownerToken: string };
    const body = { workloadId, configs: [LUNA_RAW, LUNA_PLAIN], payer: "team" };

    expect(await createRun(ip, body)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await createRun(ip, body, newId())).toMatchObject({ status: 404, body: { error: "not_found" } });
    const other = await createWorkload(ip);
    expect((await createRun(ip, body, String(other.body.ownerToken))).status).toBe(404);

    const r = await createRun(ip, body, ownerToken);
    expect(r.status).toBe(201);
    const run = r.body as { runId: string; reportId: string; ownerToken: string; cases: string[]; configs: unknown[] };
    expect(run.runId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(run.reportId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(run.reportId).not.toBe(run.runId);
    expect(run.ownerToken).not.toBe(ownerToken);
    expect(run.cases).toEqual(["c0", "c1"]);
    expect(run.configs).toEqual([
      { model: "gpt-6-luna", mode: "raw", keepContentFilter: false },
      { model: "gpt-6-luna", mode: "plain", keepContentFilter: false },
    ]);

    const rows = await db()`SELECT payer, owner_hash, report_id, shared FROM runs WHERE id = ${run.runId}`;
    expect(rows[0]).toEqual({ payer: "team", owner_hash: hashToken(run.ownerToken), report_id: run.reportId, shared: false });
  });

  it("refuses duplicate settings and more than the settings cap", async () => {
    const ip = freshIp();
    const w = await createWorkload(ip);
    const owner = String(w.body.ownerToken);
    const workloadId = String(w.body.workloadId);
    const dup = await createRun(ip, { workloadId, configs: [LUNA_PLAIN, { ...LUNA_PLAIN, model: " gpt-6-luna " }], payer: "team" }, owner);
    expect(dup).toMatchObject({ status: 400, body: { error: "invalid_configs" } });
    const many = Array.from({ length: CONFIG.configsPerRunMax + 1 }, (_, i) => ({ model: `m${i}`, mode: "plain" }));
    expect((await createRun(ip, { workloadId, configs: many, payer: "team" }, owner)).status).toBe(400);
  });

  it("creates a demo run on a sample with an allowed setting and no token", async () => {
    const r = await createRun(freshIp(), { workloadId: SAMPLE, configs: [LUNA_PLAIN], payer: "demo" });
    expect(r.status).toBe(201);
    expect((r.body.cases as string[]).length).toBe(CONFIG.demoCasesMax);
    const rows = await db()`SELECT payer FROM runs WHERE id = ${String(r.body.runId)}`;
    expect(rows[0]?.payer).toBe("demo");
  });

  it("refuses a demo run on a sample with a setting off its allowlist", async () => {
    const ip = freshIp();
    for (const cfg of [{ model: "gpt-6-luna", mode: "full" }, { model: "gpt-6-astra", mode: "raw" }, { ...LUNA_PLAIN, keepContentFilter: true }]) {
      const r = await createRun(ip, { workloadId: SAMPLE, configs: [LUNA_RAW, cfg], payer: "demo" });
      expect(r).toMatchObject({ status: 403, body: { error: "config_not_allowed" } });
    }
  });

  it("refuses a demo run on a team's own workload at creation (C4)", async () => {
    const ip = freshIp();
    const w = await createWorkload(ip);
    const body = { workloadId: String(w.body.workloadId), configs: [LUNA_RAW], payer: "demo" };
    expect(await createRun(ip, body)).toMatchObject({ status: 403, body: { error: "demo_not_allowed" } });
    // Holding the owner token does not turn a team workload into a demo one.
    expect((await createRun(ip, body, String(w.body.ownerToken))).status).toBe(403);
  });

  it("refuses a team run on a sample, which nobody owns", async () => {
    const r = await createRun(freshIp(), { workloadId: SAMPLE, configs: [LUNA_RAW], payer: "team" }, newId());
    expect(r.status).toBe(404);
  });
});

describe("GET /api/runs/[id]", () => {
  it("answers 404 to a missing, wrong or borrowed token, and to an unknown run", async () => {
    const ip = freshIp();
    const w = await createWorkload(ip);
    const r = await createRun(ip, { workloadId: String(w.body.workloadId), configs: [LUNA_RAW], payer: "team" }, String(w.body.ownerToken));
    const runId = String(r.body.runId);

    for (const owner of [undefined, "", String(w.body.ownerToken), String(r.body.reportId), runId]) {
      expect(await readRun(runId, owner)).toMatchObject({ status: 404, body: { error: "not_found" } });
    }
    expect(await readRun(newId(), String(r.body.ownerToken))).toMatchObject({ status: 404, body: { error: "not_found" } });
    // The report id is not a run id: it opens nothing on the run API (C9).
    expect((await readRun(String(r.body.reportId), String(r.body.ownerToken))).status).toBe(404);
  });

  it("returns status, totals and per-call status to the owner, and no answer, hash, token or report id", async () => {
    const ip = freshIp();
    const w = await createWorkload(ip);
    const r = await createRun(
      ip,
      { workloadId: String(w.body.workloadId), configs: [LUNA_RAW, LUNA_PLAIN], payer: "team" },
      String(w.body.ownerToken),
    );
    const runId = String(r.body.runId);
    const runToken = String(r.body.ownerToken);
    await db()`
      INSERT INTO case_results (run_id, case_id, config_idx, status, result, finished_at)
      VALUES (${runId}, 'c0', 0, 'done', ${JSON.stringify({ status: "scored", correct: true })}::jsonb, now())`;

    const g = await readRun(runId, runToken);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({
      payer: "team",
      shared: false,
      totalCalls: 4,
      totals: { done: 1 },
    });
    // Status only since C29: the stored result, answers included, stays out of this route.
    expect(g.body.results).toEqual([{ caseId: "c0", configIdx: 0, status: "done", finishedAt: expect.any(String) }]);
    const text = JSON.stringify(g.body);
    for (const secret of [runToken, String(w.body.ownerToken), hashToken(runToken), String(r.body.reportId), String(w.body.workloadId)]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("checks that come before the rate count", () => {
  it("refuses a body not declared as JSON on workloads, runs and lint without charging the sender's bucket", async () => {
    const ip = freshIp();
    const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
    const routes: [string, (req: Request) => Promise<Response>][] = [
      ["/api/workloads", postWorkload],
      ["/api/runs", postRun],
      ["/api/lint", postLint],
    ];
    for (const [path, handler] of routes) {
      const req = new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "text/plain", "x-real-ip": ip }, body: "{}" });
      expect(await call(handler(req))).toMatchObject({ status: 415, body: { error: "unsupported_media_type" } });
    }
    const counted = await db()`SELECT bucket FROM rate_limits WHERE bucket = ANY(${["workloads", "runs", "lint"].map((k) => `${k}:${hash}`)})`;
    expect(counted).toEqual([]);
  });
});

describe("response headers", () => {
  it("never allows cross-origin reads and never lets a response be cached", () => {
    expect(responses.length).toBeGreaterThan(30);
    for (const res of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
