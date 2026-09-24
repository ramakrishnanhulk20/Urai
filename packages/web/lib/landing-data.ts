// Server only: this reads the database. Never import it from a "use client" file.
import { applyLayoutFix, buildRequest, lintWorkload, parseWorkload, SERV_CHAT_URL, type RunConfig, type Workload } from "@urai/engine";
import badWorkloadJson from "../../engine/workloads/invoices-bad.json";
import goodWorkloadJson from "../../engine/workloads/invoices-good.json";
import type { ConfigTotals, Report } from "./report";
import { getSampleReports, type Sample } from "./samples";
import securityRun from "./security-summary.json";

export interface AssayRowData {
  label: string;
  detail: string;
  accuracy: number;
  pct: string;
  correct: number;
  calls: number;
}

export interface RequestSnippet {
  label: string;
  url: string;
  headers: [string, string][];
  model: string;
  tools: string[];
}

export interface ConfigSummary {
  label: string;
  off: boolean;
  pct: string;
  accuracy: number;
  correct: number;
  calls: number;
  tokens: number | null;
  meanLatencyMs: number | null;
}

export interface HowData {
  workload: {
    name: string;
    promptLines: string[];
    /** Characters of the system prompt after the lines shown. */
    promptRestChars: number;
    schemaFields: string[];
    scoredField: string;
    caseCount: number;
    sampleCase: { id: string; expected: string };
  };
  requests: [RequestSnippet, RequestSnippet];
  grid: {
    rows: { label: string; off: boolean; correct: number; calls: number; cells: ("right" | "wrong" | "none")[] }[];
    caseIds: string[];
    disagreements: number[];
  };
  verdict: {
    name: string;
    configs: ConfigSummary[];
    tokenChange: number | null;
    disagreements: number;
    cases: number;
    reportHref: string;
  };
}

export interface SetupData {
  workloadName: string;
  findings: { severity: "error" | "warning" | "info"; title: string; detail: string; evidence: string | null }[];
  moved: { heading: string; kind: string; chars: number }[];
  promptCharsBefore: number;
  promptCharsAfter: number;
  before: { pct: string; href: string; correct: number; calls: number };
  after: { pct: string; href: string; correct: number; calls: number };
}

export interface LedgerRow {
  slug: string;
  title: string;
  detail: string;
  off: string | null;
  on: string | null;
  offAccuracy: number | null;
  onAccuracy: number | null;
  tokenChange: number | null;
  href: string;
}

export interface LedgerData {
  rows: LedgerRow[];
  hard: { off: string; on: string; clauses: number | null };
  parity: { off: string; on: string; gap: number; tokenChange: number | null };
}

export interface SecuritySummary {
  ok: number;
  broken: number;
  pending: number;
  date: string | null;
}

export interface LandingData {
  hero: { cases: number; model: string; servLabel: string; beforePct: string; afterPct: string; reportHref: string };
  assay: { cases: number; before: AssayRowData; after: AssayRowData };
  how: HowData;
  setup: SetupData;
  ledger: LedgerData;
  security: SecuritySummary | null;
}

function pick(samples: Sample[], slug: string): Sample {
  const found = samples.find((sample) => sample.slug === slug);
  if (found === undefined) throw new Error(`sample ${slug} is missing from lib/sample-reports.json`);
  return found;
}

// One decimal at most, with a trailing zero dropped: 0.675 reads 67.5 and 1 reads 100.
function percent(accuracy: number): string {
  return String(Number((accuracy * 100).toFixed(1)));
}

// A missing accuracy must never be drawn as zero, so a run with no finished calls stops the page.
function accuracyOf(totals: ConfigTotals | undefined, where: string): number {
  if (totals === undefined || totals.accuracy === null) throw new Error(`${where} has no accuracy`);
  return totals.accuracy;
}

// The sample titles read "Before the fix: what was different"; the part after the colon is the detail.
function titleParts(title: string): { head: string; detail: string } {
  const at = title.indexOf(": ");
  return at === -1 ? { head: title, detail: "" } : { head: title.slice(0, at), detail: title.slice(at + 2) };
}

function totalTokens(totals: ConfigTotals): number | null {
  return totals.inputTokens === null || totals.outputTokens === null ? null : totals.inputTokens + totals.outputTokens;
}

/** Percent change in total tokens from SERV off to SERV on, rounded. Null unless both runs reported every count. */
function tokenChange(report: Report): number | null {
  const offIdx = report.configs.findIndex((c) => c.mode === "raw");
  const onIdx = report.configs.findIndex((c) => c.mode !== "raw");
  if (offIdx === -1 || onIdx === -1) return null;
  const off = totalTokens(report.totals[offIdx]!);
  const on = totalTokens(report.totals[onIdx]!);
  if (off === null || on === null || off === 0) return null;
  return Math.round(((on - off) / off) * 100);
}

function configLabel(config: RunConfig): string {
  return config.mode === "raw" ? "SERV off" : "SERV on";
}

function assayRow(sample: Sample, label: string): AssayRowData {
  const totals = sample.report.totals[0];
  const accuracy = accuracyOf(totals, `sample ${sample.slug}`);
  return {
    label,
    detail: titleParts(sample.title).detail,
    accuracy,
    pct: percent(accuracy),
    correct: totals!.correct,
    calls: totals!.calls,
  };
}

function parsed(json: unknown, name: string): Workload {
  const result = parseWorkload(json);
  if (!result.ok) throw new Error(`${name} failed validation: ${result.errors.join("; ")}`);
  return result.workload;
}

function snippet(workload: Workload, config: RunConfig): RequestSnippet {
  const first = workload.cases[0];
  if (first === undefined) throw new Error("the good sample workload has no cases");
  const { body, headers } = buildRequest(workload, first, config);
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name ?? "tool"))
    : [];
  return { label: configLabel(config), url: SERV_CHAT_URL, headers: Object.entries(headers), model: String(body.model), tools };
}

function howData(parity: Sample): HowData {
  const good = parsed(goodWorkloadJson, "invoices-good.json");
  const report = parity.report;

  const offConfig = report.configs.find((c) => c.mode === "raw");
  const onConfig = report.configs.find((c) => c.mode !== "raw");
  if (offConfig === undefined || onConfig === undefined) throw new Error("the parity sample did not run SERV both ways");

  const schemaProps = (good.answerSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const scoredField = good.scoring[0]?.field ?? "verdict";
  const firstCase = good.cases[0]!;

  // The first few lines with words in them, and how much of the prompt comes after the last one.
  const promptLines: string[] = [];
  let shownEnd = 0;
  let offset = 0;
  for (const line of good.systemPrompt.split("\n")) {
    if (promptLines.length === 5) break;
    offset += line.length + 1;
    if (line.trim() === "") continue;
    promptLines.push(line);
    shownEnd = offset;
  }

  const rows = report.configs.map((config, idx) => {
    const totals = report.totals[idx]!;
    return {
      label: configLabel(config),
      off: config.mode === "raw",
      correct: totals.correct,
      calls: totals.calls,
      cells: report.cases.map((c): "right" | "wrong" | "none" => {
        const result = c.results[idx];
        if (result === null || result === undefined) return "none";
        return result.correct ? "right" : "wrong";
      }),
    };
  });
  const disagreeing = new Set(report.disagreements);

  const configs = report.configs.map((config, idx): ConfigSummary => {
    const totals = report.totals[idx]!;
    const accuracy = accuracyOf(totals, "the parity sample");
    return {
      label: configLabel(config),
      off: config.mode === "raw",
      pct: percent(accuracy),
      accuracy,
      correct: totals.correct,
      calls: totals.calls,
      tokens: totalTokens(totals),
      meanLatencyMs: totals.meanLatencyMs,
    };
  });

  return {
    workload: {
      name: good.name,
      promptLines,
      promptRestChars: Math.max(0, good.systemPrompt.length - shownEnd),
      schemaFields: Object.keys(schemaProps),
      scoredField,
      caseCount: good.cases.length,
      sampleCase: { id: firstCase.id, expected: String(firstCase.expected[scoredField]) },
    },
    requests: [snippet(good, offConfig), snippet(good, onConfig)],
    grid: {
      rows,
      caseIds: report.cases.map((c) => c.id),
      disagreements: report.cases.flatMap((c, i) => (disagreeing.has(c.id) ? [i] : [])),
    },
    verdict: {
      name: report.name,
      configs,
      tokenChange: tokenChange(report),
      disagreements: report.disagreements.length,
      cases: report.cases.length,
      reportHref: `/r/${parity.reportId}`,
    },
  };
}

function firstSentence(text: string): string {
  const at = text.indexOf(". ");
  return at === -1 ? text : text.slice(0, at + 1);
}

function setupData(before: Sample, after: Sample): SetupData {
  const bad = parsed(badWorkloadJson, "invoices-bad.json");
  const findings = lintWorkload(bad, { configs: before.report.configs }).map((f) => ({
    severity: f.severity,
    title: f.title,
    detail: firstSentence(f.detail),
    evidence: f.evidence,
  }));
  const fix = applyLayoutFix(bad);
  const beforeAcc = accuracyOf(before.report.totals[0], "sample fix-before");
  const afterAcc = accuracyOf(after.report.totals[0], "sample fix-after");
  return {
    workloadName: bad.name,
    findings,
    moved: fix.moved.map((m) => ({ heading: m.heading ?? "DATA", kind: m.kind, chars: m.chars })),
    promptCharsBefore: bad.systemPrompt.length,
    promptCharsAfter: fix.workload.systemPrompt.length,
    before: { pct: percent(beforeAcc), href: `/r/${before.reportId}`, correct: before.report.totals[0]!.correct, calls: before.report.totals[0]!.calls },
    after: { pct: percent(afterAcc), href: `/r/${after.reportId}`, correct: after.report.totals[0]!.correct, calls: after.report.totals[0]!.calls },
  };
}

function ledgerRow(sample: Sample): LedgerRow {
  const { configs, totals } = sample.report;
  const offIdx = configs.findIndex((c) => c.mode === "raw");
  const onIdx = configs.findIndex((c) => c.mode !== "raw");
  const offAccuracy = offIdx === -1 ? null : accuracyOf(totals[offIdx], `sample ${sample.slug}`);
  const onAccuracy = onIdx === -1 ? null : accuracyOf(totals[onIdx], `sample ${sample.slug}`);
  const { head, detail } = titleParts(sample.title);
  return {
    slug: sample.slug,
    title: head,
    detail,
    off: offAccuracy === null ? null : percent(offAccuracy),
    on: onAccuracy === null ? null : percent(onAccuracy),
    offAccuracy,
    onAccuracy,
    tokenChange: tokenChange(sample.report),
    href: `/r/${sample.reportId}`,
  };
}

function ledgerData(samples: Sample[]): LedgerData {
  const order = ["fix-before", "fix-after", "parity", "hard"];
  const rows = order.map((slug) => ledgerRow(pick(samples, slug)));
  const hard = rows.find((r) => r.slug === "hard")!;
  const parity = rows.find((r) => r.slug === "parity")!;
  if (hard.off === null || hard.on === null || parity.off === null || parity.on === null) {
    throw new Error("the parity and hard samples must both run SERV off and on");
  }
  // The clause count lives in the sample's own title; the sentence drops it rather than guess.
  const clauses = /(\d+) clauses/.exec(pick(samples, "hard").title);
  return {
    rows,
    hard: { off: hard.off, on: hard.on, clauses: clauses ? Number(clauses[1]) : null },
    parity: {
      off: parity.off,
      on: parity.on,
      gap: Number(((parity.offAccuracy! - parity.onAccuracy!) * 100).toFixed(1)),
      tokenChange: parity.tokenChange,
    },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/*
 * The counts of the newest security check run. scripts/verify-security.ts writes this file next to
 * its record in docs/security/checks, and importing it bundles it into the build. A malformed file
 * returns null, so the page leaves the line out rather than showing a count nobody measured.
 */
async function securitySummary(): Promise<SecuritySummary | null> {
  const s: unknown = securityRun;
  if (typeof s !== "object" || s === null) return null;
  const { ok, broken, pending, runAt } = s as Record<string, unknown>;
  const counts = [ok, broken, pending];
  if (!counts.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) return null;
  const stamp = typeof runAt === "string" ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(runAt) : null;
  const date = stamp ? `${Number(stamp[3])} ${MONTHS[Number(stamp[2]) - 1] ?? ""} ${stamp[1]}` : null;
  return { ok: ok as number, broken: broken as number, pending: pending as number, date };
}

/** Everything the landing page shows, read live from the sample reports, the engine and the check record. */
export async function getLandingData(): Promise<LandingData> {
  const [samples, security] = await Promise.all([getSampleReports(), securitySummary()]);
  const before = pick(samples, "fix-before");
  const after = pick(samples, "fix-after");
  const parity = pick(samples, "parity");

  const model = after.report.configs[0]?.model;
  if (model === undefined) throw new Error("sample fix-after has no configuration");
  const cases = after.report.cases.length;

  // "On and off" is only claimed when some sample really ran SERV off (raw) next to a SERV mode.
  const modes = new Set(samples.flatMap((sample) => sample.report.configs.map((config) => config.mode)));
  const bothWays = modes.has("raw") && [...modes].some((mode) => mode !== "raw");

  const beforeRow = assayRow(before, "Before the fix");
  const afterRow = assayRow(after, "After one click");

  return {
    hero: {
      cases,
      model,
      servLabel: bothWays ? "SERV on and off" : "SERV on",
      beforePct: beforeRow.pct,
      afterPct: afterRow.pct,
      reportHref: `/r/${after.reportId}`,
    },
    assay: { cases, before: beforeRow, after: afterRow },
    how: howData(parity),
    setup: setupData(before, after),
    ledger: ledgerData(samples),
    security,
  };
}
