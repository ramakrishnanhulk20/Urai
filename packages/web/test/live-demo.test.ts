/*
 * Spends real operator credit: one gpt-6-luna raw call on the first case of sample-invoices-good,
 * through the real case route, the real engine and SERV. Skipped unless URAI_LIVE=1.
 * Not covered here: plain mode, team keys, the balance probe, and anything the mocked suites
 * already prove (concurrency, budget exhaustion, key leaks).
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { POST as postCase } from "../app/api/runs/[id]/cases/[caseId]/route";
import { POST as postRun } from "../app/api/runs/route";
import { budgetDay } from "../lib/budget";
import { CONFIG, OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { ipHash } from "../lib/ip";

const BASE = "http://localhost:3000";
const LIVE = process.env.URAI_LIVE === "1";
const created = { runs: [] as string[], buckets: [] as string[] };

async function spentToday(): Promise<number> {
  const rows = await db()`SELECT spent_usd FROM demo_budget WHERE day = ${budgetDay()}::date`;
  return rows[0] === undefined ? 0 : Number(rows[0].spent_usd);
}

async function callCase(runId: string, caseId: string, owner: string) {
  const req = new Request(`${BASE}/api/runs/${runId}/cases/${caseId}?config=0`, { method: "POST", headers: { [OWNER_HEADER]: owner } });
  const res = await postCase(req, { params: Promise.resolve({ id: runId, caseId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterAll(async () => {
  if (!LIVE) return;
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe.skipIf(!LIVE)("live demo case on the operator key", () => {
  it("runs one real case, charges the demo budget, and replays without a second SERV call", async () => {
    const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
    const ip = `2001:db8:${hex.join(":")}`;
    if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
    created.buckets.push(`runs:${ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }))}`);

    const res = await postRun(
      new Request(`${BASE}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({ workloadId: "sample-invoices-good", configs: [{ model: "gpt-6-luna", mode: "raw" }], payer: "demo" }),
      }),
    );
    expect(res.status).toBe(201);
    const run = (await res.json()) as { runId: string; ownerToken: string; cases: string[] };
    created.runs.push(run.runId);
    const caseId = run.cases[0]!;

    const before = await spentToday();
    const first = await callCase(run.runId, caseId, run.ownerToken);
    const after = await spentToday();
    const rows = await db()`SELECT est_cost_usd FROM case_results WHERE run_id = ${run.runId}`;
    const cost = rows[0]?.est_cost_usd === null || rows[0] === undefined ? null : Number(rows[0].est_cost_usd);

    const usage = first.body.usage as { inputTokens: number | null; outputTokens: number | null };
    console.log(
      [
        `case ${caseId}: HTTP ${first.status}, status ${String(first.body.status)}, correct ${String(first.body.correct)}`,
        `tokens in ${usage.inputTokens} out ${usage.outputTokens}, latency ${String(first.body.latencyMs)} ms`,
        `servRequestId ${String(first.body.servRequestId)}`,
        `est cost ${cost} USD, demo budget spent on ${budgetDay()}: ${before} -> ${after} USD`,
      ].join("\n"),
    );

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("scored");
    expect(after).toBeGreaterThan(before);
    expect(cost).not.toBeNull();
    expect(cost!).toBeLessThan(CONFIG.demoCallEstimateUsd);

    const second = await callCase(run.runId, caseId, run.ownerToken);
    expect(second.status).toBe(200);
    expect(second.body.servRequestId).toBe(first.body.servRequestId);
    expect(second.body).toEqual(first.body);
    expect(await spentToday()).toBe(after);
  }, 180_000);
});
