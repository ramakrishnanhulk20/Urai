/*
 * Calls POST /api/lint directly against the real Neon database (for the rate limit) with the real
 * engine lint and layout fix. listModels is replaced by a guard that must never be called, because
 * no test here sends settings. Not covered here: model id checks against the SERV list
 * (models.test.ts), the Next.js server, and how the frontend renders reasons and findings (C20).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as postLint } from "../app/api/lint/route";
import { CONFIG } from "../lib/config";
import { db } from "../lib/db";
import { HttpError } from "../lib/http";
import { ipHash } from "../lib/ip";
import { enforceRateLimit } from "../lib/rate";

const engine = vi.hoisted(() => ({ listModels: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, listModels: engine.listModels };
});

const BASE = "http://localhost:3000";
const created = { buckets: [] as string[] };
const responses: Response[] = [];

function sample(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../engine/workloads/${file}`, import.meta.url)), "utf8")) as Record<string, unknown>;
}

function freshIp(): { ip: string; bucket: string } {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const bucket = `lint:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`;
  created.buckets.push(bucket);
  return { ip, bucket };
}

async function lint(body: string, ip = freshIp().ip, type = "application/json") {
  const res = await postLint(new Request(`${BASE}/api/lint`, { method: "POST", headers: { "content-type": type, "x-real-ip": ip }, body }));
  responses.push(res);
  return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> };
}

const BAD = sample("invoices-bad.json");
const GOOD = sample("invoices-good.json");

afterAll(async () => {
  await db()`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe("POST /api/lint", () => {
  it("finds the supplier book in invoices-bad and returns a fix equal to invoices-good, storing nothing (C21)", async () => {
    const stored = () => db()`SELECT count(*)::int AS n FROM workloads WHERE NOT is_sample AND data->>'name' = ${String(BAD.name)}`;
    const before = (await stored())[0]!.n;

    const r = await lint(JSON.stringify({ workload: BAD }));
    expect(r.status).toBe(200);
    const findings = r.body.findings as { id: string; fixable: boolean; severity: string }[];
    expect(findings.find((f) => f.id === "data-in-system-prompt")).toMatchObject({ fixable: true, severity: "error" });
    const fix = r.body.fix as { workload: Record<string, unknown>; moved: unknown[] };
    expect(fix.workload.systemPrompt).toBe(GOOD.systemPrompt);
    expect(fix.moved.length).toBeGreaterThan(0);

    expect((await stored())[0]!.n).toBe(before);
    expect(engine.listModels).not.toHaveBeenCalled();
  });

  it("returns no fix for a clean test set", async () => {
    const r = await lint(JSON.stringify({ workload: GOOD }));
    expect(r.status).toBe(200);
    expect(r.body.fix).toBeNull();
    const findings = r.body.findings as { id: string; fixable: boolean }[];
    expect(findings.some((f) => f.fixable)).toBe(false);
    expect(findings.map((f) => f.id)).toContain("first-sight-cost");
  });

  it("answers 400 with the engine's reasons, at most 20 of at most 200 characters (C14)", async () => {
    const longField = "f".repeat(1_000);
    const broken = {
      ...GOOD,
      scoring: [{ field: longField, rule: "exact" }],
      cases: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, input: `invoice ${i}`, expected: { verdict: "pay" } })),
    };
    const r = await lint(JSON.stringify({ workload: broken }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_workload");
    const reasons = r.body.reasons as string[];
    expect(reasons).toHaveLength(CONFIG.lintReasonsMax);
    for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(CONFIG.lintReasonMaxChars);
    expect(reasons[0]).toHaveLength(CONFIG.lintReasonMaxChars);
    expect(reasons[0]!.startsWith("scoring[0].field:")).toBe(true);

    const notAWorkload = await lint(JSON.stringify({ workload: "nope" }));
    expect(notAWorkload.status).toBe(400);
    expect(notAWorkload.body.error).toBe("invalid_workload");
    expect((notAWorkload.body.reasons as string[]).length).toBeGreaterThan(0);
  });

  it("refuses bad settings, an oversized body and a non-JSON content type before linting", async () => {
    expect(await lint(JSON.stringify({ workload: GOOD, configs: [{ model: "   ", mode: "plain" }] }))).toMatchObject({
      status: 400,
      body: { error: "invalid_configs" },
    });
    const tooMany = Array.from({ length: CONFIG.configsPerRunMax + 1 }, (_, i) => ({ model: `m${i}`, mode: "plain" }));
    expect((await lint(JSON.stringify({ workload: GOOD, configs: tooMany }))).status).toBe(400);
    expect(await lint(JSON.stringify({ workload: "x".repeat(CONFIG.bodyMaxBytes) }))).toMatchObject({ status: 413, body: { error: "body_too_large" } });
    expect((await lint(JSON.stringify({ workload: GOOD }), freshIp().ip, "text/plain")).status).toBe(415);
    expect(engine.listModels).not.toHaveBeenCalled();
  });

  it("rate-limits one IP at 60 lint calls per window", async () => {
    const { ip, bucket } = freshIp();
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds}),
              ${CONFIG.lintPerIpPerWindow - 1})`;
    expect((await lint(JSON.stringify({ workload: GOOD }), ip)).status).toBe(200);
    expect(await lint(JSON.stringify({ workload: GOOD }), ip)).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect((await lint(JSON.stringify({ workload: GOOD }))).status).toBe(200);
  });

  it("fails closed for a rate-limit kind with no limit, which the type checker already refuses", async () => {
    for (const kind of ["nope", "constructor"]) {
      // @ts-expect-error a kind outside RateKind must not compile; this proves the runtime guard behind it.
      const p = enforceRateLimit(kind, "0".repeat(64));
      await expect(p).rejects.toBeInstanceOf(HttpError);
      await expect(p).rejects.toMatchObject({ status: 503, code: "unavailable" });
    }
  });

  it("never allows cross-origin reads and never lets a response be cached (C22)", () => {
    expect(responses.length).toBeGreaterThan(8);
    for (const res of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
