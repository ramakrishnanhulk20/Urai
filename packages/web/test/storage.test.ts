/*
 * How POST /api/workloads stores a workload, against the real Neon database: the key order of what
 * a team wrote survives the round trip to SERV's request, and the team storage cap and the whole
 * database's size stop each refuse a workload that would pass them. Both limits are replaced by
 * values this file controls, so no test here has to fill the database; other test files keep the
 * real ones. Not covered here: two inserts racing past the cap together (read in review: the
 * overshoot is one body per request in flight), a database size that cannot be read (read in
 * review: 503 unavailable), and workloads stored before migration 006, which keep the key order
 * jsonb gave them.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { buildRequest, type RunConfig } from "@urai/engine";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as postWorkload } from "../app/api/workloads/route";
import { db } from "../lib/db";
import { ipHash } from "../lib/ip";
import { loadWorkload } from "../lib/report";

const cap = vi.hoisted(() => ({ bytes: Number.MAX_SAFE_INTEGER, stop: Number.MAX_SAFE_INTEGER }));
vi.mock("../lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/config")>();
  return {
    ...real,
    CONFIG: {
      ...real.CONFIG,
      get workloadStoreMaxBytes() {
        return cap.bytes;
      },
      get dbSizeStopBytes() {
        return cap.stop;
      },
    },
  };
});

const BASE = "http://localhost:3000";
const MB = 1024 * 1024;
const LUNA_RAW: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };
const created = { workloads: [] as string[], buckets: [] as string[] };

function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  created.buckets.push(`workloads:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`);
  return ip;
}

function workload(name: string, properties: Record<string, unknown> = { verdict: { type: "string" } }): Record<string, unknown> {
  const field = Object.keys(properties).at(-1)!;
  return {
    name,
    systemPrompt: "Decide pay or hold.",
    context: null,
    answerSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    shadowHint: null,
    scoring: [{ field, rule: "exact" }],
    cases: [{ id: "c0", input: "invoice 0", expected: { [field]: "pay" } }],
  };
}

async function save(w: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`${BASE}/api/workloads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": freshIp() },
    body: JSON.stringify({ workload: w }),
  });
  const res = await postWorkload(req);
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status === 201) created.workloads.push(String(body.workloadId));
  return { status: res.status, body };
}

async function storedNamed(name: string): Promise<number> {
  return Number((await db()`SELECT count(*)::int AS n FROM workloads WHERE NOT is_sample AND data->>'name' = ${name}`)[0]?.n);
}

async function teamTotal(): Promise<number> {
  return Number((await db()`SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM workloads WHERE NOT is_sample AND expires_at > now()`)[0]?.n);
}

afterAll(async () => {
  cap.bytes = Number.MAX_SAFE_INTEGER;
  cap.stop = Number.MAX_SAFE_INTEGER;
  // Exact ids only, samples included: the stand-in rows below include a fake sample.
  await db()`DELETE FROM workloads WHERE id = ANY(${created.workloads})`;
  await db()`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe("workload key order", () => {
  it("stores the answer schema's properties in the order written and sends them to SERV in that order", async () => {
    // jsonb would put "answer" first, because it sorts shorter keys ahead of longer ones.
    const r = await save(workload("Key order", { reasoning: { type: "string" }, answer: { type: "string" } }));
    expect(r.status).toBe(201);
    const id = String(r.body.workloadId);

    const stored = await db()`SELECT json_object_keys(data->'answerSchema'->'properties') AS k FROM workloads WHERE id = ${id}`;
    expect(stored.map((row) => row.k)).toEqual(["reasoning", "answer"]);

    const w = await loadWorkload(id);
    const schema = (buildRequest(w, w.cases[0]!, LUNA_RAW).body.response_format as { json_schema: { schema: { properties: object; required: string[] } } }).json_schema.schema;
    expect(Object.keys(schema.properties)).toEqual(["reasoning", "answer"]);
    expect(schema.required).toEqual(["reasoning", "answer"]);
  });
});

describe("team storage cap", () => {
  it("refuses with 503 storage_full and stores nothing when the new workload would pass the cap", async () => {
    const name = `Cap refused ${randomBytes(6).toString("hex")}`;
    cap.bytes = 1;
    expect(await save(workload(name))).toEqual({ status: 503, body: { error: "storage_full" } });
    expect(await storedNamed(name)).toBe(0);
    cap.bytes = Number.MAX_SAFE_INTEGER;
    expect((await save(workload(name))).status).toBe(201);
  });

  it("counts stored, unexpired team workloads and leaves out samples and expired ones", async () => {
    const tag = randomBytes(6).toString("hex");
    const sample = `test-sample-cap-${tag}`;
    const expired = `test-expired-cap-${tag}`;
    const live = `test-live-cap-${tag}`;
    created.workloads.push(sample, expired, live);
    // Rows that claim a size without holding it. Only this file's cap is small, so they block no one else.
    await db()`INSERT INTO workloads (id, owner_hash, is_sample, data, expires_at, size_bytes) VALUES
      (${sample}, 'x', true, '{}'::json, now() + interval '1 day', ${1_000 * MB}),
      (${expired}, 'x', false, '{}'::json, now() - interval '1 day', ${1_000 * MB})`;
    // Room for 20 MB more than the team rows hold now, so other test files adding or removing a few
    // workloads meanwhile cannot move the answer either way.
    cap.bytes = (await teamTotal()) + 20 * MB;
    expect((await save(workload(`Cap room ${tag}`))).status).toBe(201);

    await db()`INSERT INTO workloads (id, owner_hash, data, expires_at, size_bytes) VALUES (${live}, 'x', '{}'::json, now() + interval '1 day', ${40 * MB})`;
    expect(await save(workload(`Cap full ${tag}`))).toEqual({ status: 503, body: { error: "storage_full" } });
    cap.bytes = Number.MAX_SAFE_INTEGER;
  });
});

describe("C26: the whole database's size stop", () => {
  it("refuses a workload with 503 storage_full while the database is over its size stop, and stores it once there is room", async () => {
    const name = `Size stop ${randomBytes(6).toString("hex")}`;
    // The stop is set against any possible size, never a fresh reading: the route compares with a size
    // cached for up to a minute, and parallel test files grow the shared database in the meantime.
    cap.stop = 1;
    expect(await save(workload(name))).toEqual({ status: 503, body: { error: "storage_full" } });
    expect(await storedNamed(name)).toBe(0);
    // The size stays cached for a minute, so this proves the stop is compared on every request.
    cap.stop = Number.MAX_SAFE_INTEGER;
    expect((await save(workload(name))).status).toBe(201);
    expect(await storedNamed(name)).toBe(1);
    cap.stop = Number.MAX_SAFE_INTEGER;
  });
});
