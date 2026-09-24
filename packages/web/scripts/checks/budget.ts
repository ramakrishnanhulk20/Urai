import type { CaseResult } from "@urai/engine";
import { budgetDay } from "../../lib/budget";
import { CONFIG } from "../../lib/config";
import { callCostUsd } from "../../lib/prices";
import { brief, type Ctx, field, LUNA_RAW, ownerHeaders, type Reply, SAMPLE_GOOD, sleep } from "./shared";

const PARALLEL = 10;
const LET_THROUGH = 3;
const POLL_MS = 1_500;
const POLL_TRIES = 120;

type BudgetRow = { cap: string; spent: string; reserved: string };

async function budgetRow(ctx: Ctx, day: string): Promise<BudgetRow | null> {
  const row = (await ctx.sql`
    SELECT cap_usd::text AS cap, spent_usd::text AS spent, reserved_usd::text AS reserved
    FROM demo_budget WHERE day = ${day}::date`)[0];
  return row === undefined ? null : { cap: String(row.cap), spent: String(row.spent), reserved: String(row.reserved) };
}

function show(r: BudgetRow | null): string {
  return r === null ? "no row" : `cap ${r.cap}, spent ${r.spent}, reserved ${r.reserved}`;
}

// A repeat of a finished call returns the stored result and spends nothing (C5), so polling is free.
async function untilStored(call: () => Promise<Reply>, first: Reply): Promise<Reply> {
  let r = first;
  for (let i = 0; i < POLL_TRIES && r.status === 202; i++) {
    await sleep(POLL_MS);
    r = await call();
  }
  return r;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** C5 and C6 against real demo calls: one spend per (run, case, config), and a daily cap concurrent calls cannot pass. */
export async function budget(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("budget");
  const day = budgetDay();

  const one = await api.createRun({ workloadId: SAMPLE_GOOD, configs: [LUNA_RAW], payer: "demo" });
  const caseId = one.cases[0]!;
  const call = () => api.caseCall(one.runId, caseId, "0", ownerHeaders(one.ownerToken));
  const beforeC5 = await budgetRow(ctx, day);
  const firstReplies = await Promise.all(Array.from({ length: PARALLEL }, call));
  const finalReplies: Reply[] = [];
  for (const r of firstReplies) finalReplies.push(await untilStored(call, r));
  const afterC5 = await budgetRow(ctx, day);

  const requestIds = new Set(finalReplies.map((r) => field(r.body, "servRequestId")));
  const [onlyId] = [...requestIds];
  const rows = await sql`
    SELECT est_cost_usd::text AS cost, result FROM case_results
    WHERE run_id = ${one.runId} AND case_id = ${caseId} AND config_idx = 0`;
  const row = rows[0];
  const usage = field(row?.result, "usage") as CaseResult["usage"] | undefined;
  const oneCall = usage === undefined ? null : callCostUsd(LUNA_RAW, usage);
  const stored = row?.cost === null || row?.cost === undefined ? null : Number(row.cost);
  const costMatches = stored === null ? oneCall === null : oneCall !== null && Math.abs(stored - oneCall) < 1e-12;
  const firstCodes = firstReplies.map(brief).join(", ");
  // C5 is "spent at most once", not "SERV answered": a call SERV fails (no request id, cost unknown)
  // must still be stored once and handed back identically to all ten callers.
  // Compared as data with sorted keys: the caller that ran the case gets the fresh result, the rest
  // get the stored copy, and Postgres jsonb hands object keys back in its own order.
  const sameBody = new Set(finalReplies.map((r) => canonical(r.body))).size === 1;
  // No row before the call means the day had no demo calls yet: nothing spent, not unknown.
  const spentBefore = beforeC5 === null ? 0 : Number(beforeC5.spent);
  const spentDelta = afterC5 === null ? Number.NaN : Number(afterC5.spent) - spentBefore;
  const atMostOneCall = spentDelta <= CONFIG.demoCallEstimateUsd + 1e-9;
  const upstream = String(field(finalReplies[0]?.body, "status"));
  rec.add(
    "C5",
    `${PARALLEL} simultaneous identical demo case calls`,
    `${PARALLEL} POST case calls at once on one demo run, same case and config; each 202 re-asked until stored`,
    `first answers: ${firstCodes}; case_results rows ${rows.length}; all ${PARALLEL} final replies identical: ${sameBody}; distinct servRequestId ${requestIds.size}${typeof onlyId === "string" ? "" : " (none set: SERV did not answer this one call)"}; the one call's status ${upstream}; est_cost_usd ${String(stored)} vs one call ${String(oneCall)}; spent rose ${spentDelta.toFixed(4)} (one call at most ${CONFIG.demoCallEstimateUsd}); budget before ${show(beforeC5)}, after ${show(afterC5)}`,
    rows.length === 1 && requestIds.size === 1 && sameBody && atMostOneCall && finalReplies.every((r) => r.status === 200) && costMatches,
  );

  const start = await budgetRow(ctx, day);
  if (start === null) throw new Error(`setup: no demo_budget row for ${day} after the C5 call`);
  const runs = [];
  for (let i = 0; i < PARALLEL; i++) runs.push(await api.createRun({ workloadId: SAMPLE_GOOD, configs: [LUNA_RAW], payer: "demo" }));

  const original = start.cap;
  let restoredTo: string | null = null;
  try {
    const room = (LET_THROUGH * CONFIG.demoCallEstimateUsd).toFixed(CONFIG.budgetUsdPlaces);
    const set = (await sql`
      UPDATE demo_budget SET cap_usd = spent_usd + reserved_usd + ${room}::numeric
      WHERE day = ${day}::date
      RETURNING cap_usd::text AS cap, spent_usd::text AS spent, reserved_usd::text AS reserved`)[0];
    if (set === undefined) throw new Error(`setup: could not set the cap for ${day}`);
    const replies = await Promise.all(runs.map((r) => api.caseCall(r.runId, r.cases[0]!, "0", ownerHeaders(r.ownerToken))));
    const through = replies.filter((r) => r.status === 200);
    const refused = replies.filter((r) => r.status === 429 && r.code === "budget_exhausted");
    const end = await budgetRow(ctx, day);
    const withinCap = end !== null && Number(end.spent) + Number(end.reserved) <= Number(end.cap);
    rec.add(
      "C6",
      `${PARALLEL} simultaneous demo calls with room for ${LET_THROUGH}`,
      `cap set to spent + reserved + ${LET_THROUGH} x ${CONFIG.demoCallEstimateUsd}; ${PARALLEL} POST case calls at once, one per demo run`,
      `${through.length} went through (${through.map((r) => String(field(r.body, "status"))).join(", ")}), ${refused.length} budget_exhausted, others: ${
        replies.filter((r) => !through.includes(r) && !refused.includes(r)).map(brief).join(", ") || "none"
      }; budget after: ${show(end)}; spent plus reserved within cap: ${withinCap}`,
      through.length === LET_THROUGH && refused.length === PARALLEL - LET_THROUGH && withinCap,
    );
  } finally {
    try {
      const back = (await sql`UPDATE demo_budget SET cap_usd = ${original}::numeric WHERE day = ${day}::date RETURNING cap_usd::text AS cap`)[0];
      restoredTo = back === undefined ? null : String(back.cap);
    } catch {
      restoredTo = null;
    }
    const readBack = (await budgetRow(ctx, day).catch(() => null))?.cap ?? null;
    console.log(`demo_budget ${day}: original cap_usd ${original}, read back ${String(readBack)}`);
    if (restoredTo !== original || readBack !== original) {
      console.warn(`WARNING: demo_budget cap_usd for ${day} was NOT restored. Set it back to ${original} by hand.`);
    }
    rec.add(
      "C6",
      "demo budget cap restored after the test",
      `UPDATE demo_budget SET cap_usd back to ${original} for ${day}`,
      `read back ${String(readBack)}`,
      readBack === original,
    );
  }
}
