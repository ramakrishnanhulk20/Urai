/*
 * A team run that compares two models: the run route accepts one setting per model, and each case
 * call reaches the engine with its own setting's model. The engine's runCase is replaced by a
 * fixture, the same way cases.test.ts does it, so no request reaches SERV and no money moves; the
 * run and its rows are written to the real Neon database and removed afterwards.
 * Also checks the labels a two-model run gets, cost per correct answer, and the builder's helpers
 * for the second model. Not covered here: a real SERV call on the second model (its id is never
 * checked against SERV's live list in this file), how the pages look, and the lint's model check.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { buildRequest, type CaseResult, type RunConfig, type Workload } from "@urai/engine";
import { createElement, type ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postCase } from "../app/api/runs/[id]/cases/[caseId]/route";
import { POST as postRun } from "../app/api/runs/route";
import { POST as postWorkload } from "../app/api/workloads/route";
import type { ModelEntry } from "../components/new/api";
import { buildConfigs, compareProblem, EMPTY_COMPARE, estimate, mainModesMax, OUTPUT_TOKENS_GUESS, type FormLimits } from "../components/new/draft";
import {
  configLabels,
  costGap,
  costGapText,
  costPerCorrect,
  hasManyModels,
  perCorrectText,
  summarize,
  summaryText,
  unitUsd,
} from "../components/report/format";
import { Ledger } from "../components/run/ledger";
import { OWNER_HEADER } from "../lib/config";
import { db } from "../lib/db";
import { SERV_KEY_HEADER } from "../lib/http";
import { ipHash } from "../lib/ip";
import type { ConfigTotals, Report } from "../lib/report";

const engine = vi.hoisted(() => ({ runCase: vi.fn() }));
vi.mock("@urai/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@urai/engine")>();
  return { ...real, runCase: engine.runCase };
});

// react-dom ships no type declarations here, so the one function used is loaded with its signature written out.
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as { renderToString: (node: ReactNode) => string };

const BASE = "http://localhost:3000";
const BIG = "gpt-6-astra";
const SMALL = "gpt-6-luna";
const KEY = `sk-canary-${randomBytes(16).toString("hex")}`;

const created = { workloads: [] as string[], runs: [] as string[], buckets: [] as string[] };

function freshIp(): string {
  const hex = randomBytes(12).toString("hex").match(/.{4}/g) ?? [];
  const ip = `2001:db8:${hex.join(":")}`;
  if (isIP(ip) !== 6) throw new Error("test fixture built an invalid IPv6 address");
  const hash = ipHash(new Request(BASE, { headers: { "x-real-ip": ip } }));
  created.buckets.push(`workloads:${hash}`, `runs:${hash}`, `key_refusals:${hash}`, `demo_calls:${hash}`, `serv_unavailable:${hash}`);
  return ip;
}

function post(path: string, body: unknown, ip: string, owner?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-real-ip": ip };
  if (owner !== undefined) headers[OWNER_HEADER] = owner;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function read(p: Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await p;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const WORKLOAD = {
  name: "Two model compare test",
  systemPrompt: "Decide pay or hold.",
  context: null,
  answerSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
  shadowHint: null,
  scoring: [{ field: "verdict", rule: "exact" }],
  cases: [
    { id: "c0", input: "invoice 0", expected: { verdict: "pay" } },
    { id: "c1", input: "invoice 1", expected: { verdict: "pay" } },
  ],
};

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

beforeEach(() => {
  engine.runCase.mockReset();
  engine.runCase.mockImplementation(async (_w: unknown, caseId: string, cfg: RunConfig) => fixture(caseId, cfg));
});

afterAll(async () => {
  const sql = db();
  await sql`DELETE FROM case_results WHERE run_id = ANY(${created.runs})`;
  await sql`DELETE FROM runs WHERE id = ANY(${created.runs})`;
  await sql`DELETE FROM workloads WHERE id = ANY(${created.workloads}) AND NOT is_sample`;
  await sql`DELETE FROM rate_limits WHERE bucket = ANY(${created.buckets})`;
});

describe("a team run over two models", () => {
  it("accepts a large model with SERV off against a small one with SERV on, and sends each case call with its own model", async () => {
    const ip = freshIp();
    const w = await read(postWorkload(post("/api/workloads", { workload: WORKLOAD }, ip)));
    expect(w.status).toBe(201);
    const workloadId = String(w.body.workloadId);
    created.workloads.push(workloadId);

    const configs = [
      { model: BIG, mode: "raw" },
      { model: SMALL, mode: "plain" },
    ];
    const r = await read(postRun(post("/api/runs", { workloadId, configs, payer: "team" }, ip, String(w.body.ownerToken))));
    expect(r.status).toBe(201);
    const runId = String(r.body.runId);
    created.runs.push(runId);
    expect(r.body.configs).toEqual([
      { model: BIG, mode: "raw", keepContentFilter: false },
      { model: SMALL, mode: "plain", keepContentFilter: false },
    ]);

    const owner = String(r.body.ownerToken);
    for (const caseId of ["c0", "c1"]) {
      for (const idx of [0, 1]) {
        const url = `${BASE}/api/runs/${runId}/cases/${caseId}?config=${idx}`;
        const req = new Request(url, { method: "POST", headers: { "x-real-ip": ip, [OWNER_HEADER]: owner, [SERV_KEY_HEADER]: KEY } });
        const out = await read(postCase(req, { params: Promise.resolve({ id: runId, caseId }) }));
        expect(out.status).toBe(200);
      }
    }

    const calls = engine.runCase.mock.calls.map((c) => ({ caseId: c[1] as string, model: (c[2] as RunConfig).model, mode: (c[2] as RunConfig).mode }));
    expect(calls).toEqual([
      { caseId: "c0", model: BIG, mode: "raw" },
      { caseId: "c0", model: SMALL, mode: "plain" },
      { caseId: "c1", model: BIG, mode: "raw" },
      { caseId: "c1", model: SMALL, mode: "plain" },
    ]);
    const rows = await db()`SELECT config_idx, count(*)::int AS n FROM case_results WHERE run_id = ${runId} GROUP BY config_idx ORDER BY config_idx`;
    expect(rows.map((x) => [x.config_idx, x.n])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("still refuses the same setting twice, whatever the model id's case", async () => {
    const ip = freshIp();
    const w = await read(postWorkload(post("/api/workloads", { workload: WORKLOAD }, ip)));
    created.workloads.push(String(w.body.workloadId));
    const configs = [
      { model: SMALL, mode: "plain" },
      { model: SMALL.toUpperCase(), mode: "plain" },
    ];
    const r = await read(postRun(post("/api/runs", { workloadId: w.body.workloadId, configs, payer: "team" }, ip, String(w.body.ownerToken))));
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_configs" } });
    expect(engine.runCase).not.toHaveBeenCalled();
  });

  it("builds each SERV request on its own setting's model (the real buildRequest, not the fixture)", () => {
    const w = WORKLOAD as unknown as Workload;
    const c = w.cases[0]!;
    expect(buildRequest(w, c, { model: BIG, mode: "raw" }).body.model).toBe(BIG);
    expect(buildRequest(w, c, { model: SMALL, mode: "plain" }).body.model).toBe(SMALL);
    expect(buildRequest(w, c, { model: SMALL, mode: "multipath" }).body.model).toBe(`${SMALL}-serv-multipath`);
  });
});

const off = (model: string): RunConfig => ({ model, mode: "raw", keepContentFilter: false });
const plain = (model: string): RunConfig => ({ model, mode: "plain", keepContentFilter: false });
const full = (model: string): RunConfig => ({ model, mode: "full", keepContentFilter: false });
const multipath = (model: string): RunConfig => ({ model, mode: "multipath", keepContentFilter: false });

describe("labels on a run over two models", () => {
  it("leads every label with its model", () => {
    expect(configLabels([off(BIG), plain(SMALL)])).toEqual([`${BIG}, SERV off`, `${SMALL}, SERV on`]);
    expect(configLabels([off(SMALL), plain(SMALL), off(BIG)])).toEqual([`${SMALL}, SERV off`, `${SMALL}, SERV on`, `${BIG}, SERV off`]);
    expect(configLabels([off(SMALL), plain(SMALL), full(BIG)])).toEqual([`${SMALL}, SERV off`, `${SMALL}, SERV plain`, `${BIG}, SERV full`]);
  });

  it("keeps the Multipath name against SERV off, on one model and on two", () => {
    expect(configLabels([off(SMALL), multipath(SMALL)])).toEqual(["SERV off", "SERV Multipath"]);
    expect(configLabels([off(BIG), multipath(SMALL)])).toEqual([`${BIG}, SERV off`, `${SMALL}, SERV Multipath`]);
  });

  it("keeps today's labels for a run on one model", () => {
    expect(configLabels([off(SMALL), plain(SMALL)])).toEqual(["SERV off", "SERV on"]);
    expect(configLabels([off(SMALL), plain(SMALL), full(SMALL)])).toEqual(["SERV off", "SERV plain", "SERV full"]);
    expect(hasManyModels([off(SMALL), plain(SMALL.toUpperCase())])).toBe(false);
    expect(hasManyModels([off(BIG), plain(SMALL)])).toBe(true);
  });

  it("names both models in the summary sentence, SERV on first", () => {
    const t = (accuracy: number): ConfigTotals => ({ ...totals(0.01, 4), accuracy, calls: 4, inputTokens: 1000, outputTokens: 100 });
    const report = { configs: [off(BIG), plain(SMALL)], totals: [t(0.75), t(1)], cases: [] } as unknown as Report;
    expect(summaryText(summarize(report))).toBe(`${SMALL}, SERV on scored 100% against 75% with ${BIG}, SERV off, using the same number of tokens.`);
  });

  it("names both models even when SERV off stays ticked on the main model", () => {
    const t = (accuracy: number): ConfigTotals => ({ ...totals(0.01, 4), accuracy, calls: 4, inputTokens: 1000, outputTokens: 100 });
    const report = { configs: [off(SMALL), plain(SMALL), off(BIG)], totals: [t(0.5), t(1), t(0.75)], cases: [] } as unknown as Report;
    expect(summaryText(summarize(report))).toBe(`${SMALL}, SERV on scored 100% against 75% with ${BIG}, SERV off, using the same number of tokens.`);
    const twoOn = { configs: [plain(SMALL), plain(BIG)], totals: [t(1), t(0.5)], cases: [] } as unknown as Report;
    expect(summaryText(summarize(twoOn))).toContain(`${BIG}, SERV on`);
  });
});

function totals(estCostUsd: number | null, correct: number): ConfigTotals {
  return {
    calls: 4,
    scored: 4,
    correct,
    accuracy: correct / 4,
    statusCounts: { scored: 4 },
    meanLatencyMs: 900,
    inputTokens: 4000,
    outputTokens: 800,
    estCostUsd,
  };
}

describe("cost per correct answer", () => {
  it("divides the estimated cost by the right answers", () => {
    expect(costPerCorrect(totals(0.02, 4))).toEqual({ kind: "usd", value: 0.005 });
    expect(perCorrectText(costPerCorrect(totals(0.02, 4)))).toBe("$0.005");
    expect(perCorrectText(costPerCorrect(totals(0.00104, 4)))).toBe("$0.00026");
  });

  it("is unknown when the cost is unknown, and says so when nothing was right", () => {
    expect(perCorrectText(costPerCorrect(totals(null, 3)))).toBe("unknown");
    expect(perCorrectText(costPerCorrect(undefined))).toBe("unknown");
    expect(perCorrectText(costPerCorrect(totals(0.02, 0)))).toBe("no correct answers");
  });

  it("keeps two significant digits below a cent, so a cheap answer never reads as $0.0000", () => {
    expect(unitUsd(0.000026)).toBe("$0.000026");
    expect(unitUsd(0.0375)).toBe("$0.0375");
    expect(unitUsd(1.5)).toBe("$1.50");
    expect(unitUsd(0)).toBe("$0.00");
  });

  it("shows each setting's cost per correct answer in the run ledger, with the line that says it is an estimate", () => {
    const html = renderToString(
      createElement(Ledger, {
        labels: [`${BIG}, SERV off`, `${SMALL}, SERV on`],
        configs: [off(BIG), plain(SMALL)],
        totals: [totals(0.08, 2), totals(0.01, 0)],
        balance: null,
      }),
    ).replaceAll("<!-- -->", "");
    expect(html).toContain(`${BIG}, SERV off`);
    expect(html).toContain("Per correct answer");
    expect(html).toContain("$0.04");
    expect(html).toContain("no correct answers");
    expect(html).toContain("Cost per correct answer is each setting&#x27;s estimated cost divided by its right answers");
    expect(html).toContain("on earlier 23 Sep runs of the samples");
  });
});

describe("an unknown cost gives its real reason", () => {
  const noCounts = (): ConfigTotals => ({ ...totals(null, 2), inputTokens: null });

  it("says Urai does not price Multipath, full or an unlisted model, even with every token count in", () => {
    expect(costGap(full(SMALL), totals(null, 2))).toBe("unpriced");
    expect(costGap({ model: SMALL, mode: "multipath" }, totals(null, 2))).toBe("unpriced");
    expect(costGap(plain("gpt-6-unlisted"), totals(null, 2))).toBe("unpriced");
    expect(costGap(plain(SMALL), totals(0.01, 2))).toBeNull();
  });

  it("keeps the token-count reason only when a count is really missing", () => {
    expect(costGap(plain(SMALL), noCounts())).toBe("no_counts");
    // A full call is never priced, so its missing counts are not the reason.
    expect(costGap(full(SMALL), noCounts())).toBe("unpriced");
  });

  it("names each setting with its reason, on the report and in the run ledger", () => {
    const configs = [off(SMALL), plain(SMALL), full(SMALL)];
    const labels = configLabels(configs);
    const text = costGapText(configs, [totals(0.01, 2), noCounts(), totals(null, 2)], labels);
    expect(text).toBe(
      "SERV full reads unknown: Urai does not price Multipath, full, or a model missing from the price list. SERV plain reads unknown because SERV did not send token counts for every call.",
    );
    const html = renderToString(createElement(Ledger, { labels, configs, totals: [totals(0.01, 2), totals(0.01, 2), totals(null, 2)], balance: null }));
    expect(html).toContain("Urai does not price Multipath, full, or a model missing from the price list");
    expect(html).not.toContain("SERV did not send token counts");
    const live = renderToString(createElement(Ledger, { labels, configs, totals: null, balance: null }));
    expect(live).toContain("Multipath and full settings will read unknown");
  });
});

const LIMITS: FormLimits = {
  nameMaxChars: 120,
  systemPromptMaxChars: 60_000,
  contextMaxChars: 60_000,
  caseInputMaxChars: 20_000,
  casesMax: 200,
  caseIdMaxChars: 64,
  scoringRulesMax: 20,
  configsPerRunMax: 6,
  keyMinChars: 20,
  keyMaxChars: 200,
  bodyMaxBytes: 300 * 1024,
};

describe("the builder's second model", () => {
  it("adds one setting on the second model after the ticked ones", () => {
    expect(buildConfigs(SMALL, ["raw", "plain"], { model: BIG, mode: "raw" }, LIMITS)).toEqual([
      { model: SMALL, mode: "raw" },
      { model: SMALL, mode: "plain" },
      { model: BIG, mode: "raw" },
    ]);
    expect(buildConfigs(SMALL, ["raw"], EMPTY_COMPARE, LIMITS)).toEqual([{ model: SMALL, mode: "raw" }]);
  });

  it("leaves out and explains a repeated setting", () => {
    const compare = { model: ` ${SMALL.toUpperCase()} `, mode: "plain" as const };
    expect(buildConfigs(SMALL, ["raw", "plain"], compare, LIMITS)).toHaveLength(2);
    expect(compareProblem(SMALL, ["raw", "plain"], compare, LIMITS)).toBe(
      `${SMALL.toUpperCase()} with SERV plain is already in the run above. Pick another model to compare with, or another setting for it.`,
    );
    expect(compareProblem(SMALL, ["raw"], compare, LIMITS)).toBeNull();
  });

  it("keeps the run within the per-run cap and says what to untick", () => {
    const tight = { ...LIMITS, configsPerRunMax: 2 };
    const compare = { model: BIG, mode: "plain" as const };
    expect(mainModesMax(compare, tight)).toBe(1);
    expect(mainModesMax(EMPTY_COMPARE, tight)).toBe(2);
    expect(buildConfigs(SMALL, ["raw", "plain"], compare, tight)).toHaveLength(2);
    expect(compareProblem(SMALL, ["raw", "plain"], compare, tight)).toBe(
      "A run takes at most 2 settings. Untick one above to make room for the second model.",
    );
  });

  it("prices each setting at its own model, and gives no figure when a model has no price", () => {
    const w = { ...(WORKLOAD as unknown as Workload), systemPrompt: "x".repeat(3960) };
    const prices: ModelEntry[] = [
      { id: SMALL, inputUsdPerM: 0.13, outputUsdPerM: 0.65 },
      { id: BIG, inputUsdPerM: 2, outputUsdPerM: 8 },
    ];
    const alone = (model: string): number => estimate(w, [{ model, mode: "raw" }], prices)!.usd!;
    const both = estimate(w, [{ model: BIG, mode: "raw" }, { model: SMALL, mode: "plain" }], prices)!;
    expect(both.calls).toBe(4);
    expect(both.usd).toBeCloseTo(alone(BIG) + alone(SMALL), 12);
    // Output alone on the large model is 2 cases x OUTPUT_TOKENS_GUESS tokens at $8 per million.
    expect(alone(BIG)).toBeGreaterThan((2 * OUTPUT_TOKENS_GUESS * 8) / 1e6);
    expect(alone(BIG)).toBeGreaterThan(10 * alone(SMALL));
    expect(estimate(w, [{ model: SMALL, mode: "raw" }, { model: "gpt-6-unlisted", mode: "raw" }], prices)!.usd).toBeNull();
  });

  it("leaves Multipath and full out of the figure and counts them, as the report never prices them", () => {
    const w = { ...(WORKLOAD as unknown as Workload), systemPrompt: "x".repeat(3960) };
    const prices: ModelEntry[] = [{ id: SMALL, inputUsdPerM: 0.13, outputUsdPerM: 0.65 }];
    const raw = estimate(w, [{ model: SMALL, mode: "raw" }], prices)!;
    const mixed = estimate(w, [{ model: SMALL, mode: "raw" }, { model: SMALL, mode: "full" }, { model: SMALL, mode: "multipath" }], prices)!;
    expect(raw.leftOut).toBe(0);
    expect(mixed.usd).toBe(raw.usd);
    expect(mixed.leftOut).toBe(2);
    expect(mixed.calls).toBe(6);
    const only = estimate(w, [{ model: SMALL, mode: "full" }], prices)!;
    expect(only.usd).toBeNull();
    expect(only.leftOut).toBe(1);
  });
});
