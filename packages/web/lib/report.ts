import { lintWorkload, parseWorkload, type ExpectedValue, type LintFinding, type RunConfig, type Workload } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "./config";
import { db } from "./db";
import { HttpError, type RunRecord } from "./http";

const count = z.number().int().nonnegative().nullable();

/*
 * The fields the report reads from a stored CaseResult. Stored rows are read back as untrusted
 * (trust boundary 3): a row that fails this shape stops the report instead of being skipped,
 * because a silently missing row would make the totals look complete when they are not (C26).
 */
const storedResultSchema = z.object({
  status: z.enum(["scored", "failed", "refused", "filtered", "upstream_error", "timeout"]),
  correct: z.boolean(),
  answer: z.record(z.string(), z.unknown()).nullable(),
  answerText: z.string().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  usage: z.object({ inputTokens: count, outputTokens: count }),
});

export type StoredResult = z.infer<typeof storedResultSchema>;

export interface ReportRow {
  caseId: string;
  configIdx: number;
  result: StoredResult;
  estCostUsd: number | null;
}

export interface ConfigTotals {
  calls: number;
  scored: number;
  correct: number;
  /** correct / calls: an answer that failed, was refused, filtered or never came back counts as wrong. Null with no calls. */
  accuracy: number | null;
  statusCounts: Record<string, number>;
  meanLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
}

/** A prompt or context cut at CONFIG.reportPromptMaxChars: the kept start, and the full length. */
export interface TruncatedText {
  truncated: true;
  chars: number;
  text: string;
}

export interface ReportCaseResult {
  status: StoredResult["status"];
  correct: boolean;
  // Null when absent or too long to show; answerTruncatedChars says which. A separate field, so no
  // model answer, whatever keys it has, can ever pass for the truncation marker.
  answer: Record<string, unknown> | null;
  answerTruncatedChars: number | null;
  answerText: string | null;
  latencyMs: number | null;
}

export interface Report {
  name: string;
  systemPrompt: string | TruncatedText;
  context: string | TruncatedText | null;
  answerSchema: Record<string, unknown>;
  configs: RunConfig[];
  totals: ConfigTotals[];
  balance: { before: number | null; after: number | null } | null;
  cases: {
    id: string;
    input: string;
    expected: Record<string, ExpectedValue>;
    /** One entry per configuration, in run order; null until that call has finished. */
    results: (ReportCaseResult | null)[];
  }[];
  disagreements: string[];
  lint: LintFinding[];
}

export interface ReportInput {
  workload: Workload;
  configs: RunConfig[];
  caseIds: string[];
  balance: { before: number | null; after: number | null };
  rows: ReportRow[];
}

/*
 * The bytes one code point adds to a JSON string once serialised as UTF-8: two for the short
 * escapes, six for the \u00XX form, and six for a lone surrogate, which JSON.stringify also escapes.
 */
function jsonBytes(code: number): number {
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return code < 0x10000 ? 3 : 4;
}

/*
 * The longest start of text that fits in max characters and in max bytes once JSON-escaped (C29).
 * Counting bytes as well is what makes the report size predictable: 2,000 control characters
 * would otherwise serialise to 12,000 bytes. Never cuts through a surrogate pair.
 */
function capText(text: string, max: number): string {
  let bytes = 0;
  let at = 0;
  for (const ch of text) {
    const cost = jsonBytes(ch.codePointAt(0)!);
    if (bytes + cost > max || at + ch.length > max) return text.slice(0, at);
    bytes += cost;
    at += ch.length;
  }
  return text;
}

function cap(text: string): string {
  return capText(text, CONFIG.reportTextMaxChars);
}

function capPrompt(text: string): string | TruncatedText {
  const kept = capText(text, CONFIG.reportPromptMaxChars);
  return kept.length === text.length ? text : { truncated: true, chars: text.length, text: kept };
}

/*
 * Measured in UTF-8 bytes of the serialised JSON, which is never less than its length in
 * characters, so an answer that passes is under the cap by either measure.
 */
function capAnswer(answer: Record<string, unknown> | null): { answer: Record<string, unknown> | null; answerTruncatedChars: number | null } {
  if (answer === null) return { answer: null, answerTruncatedChars: null };
  const text = JSON.stringify(answer);
  return Buffer.byteLength(text, "utf8") > CONFIG.reportAnswerMaxChars
    ? { answer: null, answerTruncatedChars: text.length }
    : { answer, answerTruncatedChars: null };
}

/* A total with any unknown part is unknown: a partial sum shown as the whole would read as
 * complete (C17, C25). */
function sumOrNull(values: (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function totalsFor(rows: ReportRow[]): ConfigTotals {
  const calls = rows.length;
  const scored = rows.filter((r) => r.result.status === "scored").length;
  const correct = rows.filter((r) => r.result.correct).length;
  const statusCounts = new Map<string, number>();
  for (const r of rows) statusCounts.set(r.result.status, (statusCounts.get(r.result.status) ?? 0) + 1);
  const latencySum = sumOrNull(rows.map((r) => r.result.latencyMs));
  return {
    calls,
    scored,
    correct,
    accuracy: calls === 0 ? null : correct / calls,
    statusCounts: Object.fromEntries(statusCounts),
    meanLatencyMs: calls === 0 || latencySum === null ? null : Math.round(latencySum / calls),
    inputTokens: sumOrNull(rows.map((r) => r.result.usage.inputTokens)),
    outputTokens: sumOrNull(rows.map((r) => r.result.usage.outputTokens)),
    estCostUsd: sumOrNull(rows.map((r) => r.estCostUsd)),
  };
}

/**
 * Builds the report for a run from its workload, settings, case list, balance readings and
 * finished results. Pure: no database, no network. Case input and answer text are capped at
 * CONFIG.reportTextMaxChars, an answer longer than CONFIG.reportAnswerMaxChars once serialised
 * becomes answer null with answerTruncatedChars set, and the system prompt and context are cut at
 * CONFIG.reportPromptMaxChars into { truncated: true, chars, text } (C14, C29). Token counts, latency and cost pass through as stored and a
 * null anywhere in a configuration makes that total null (C25). Throws when a row names a case or
 * configuration outside the run, or a run case is missing from the workload (C26).
 */
export function buildReport(input: ReportInput): Report {
  const { workload, configs, caseIds } = input;
  const byId = new Map(workload.cases.map((c) => [c.id, c]));
  const slots = new Map<string, (ReportRow | null)[]>(caseIds.map((id) => [id, configs.map(() => null)]));
  const perConfig: ReportRow[][] = configs.map(() => []);

  for (const row of input.rows) {
    const slot = slots.get(row.caseId);
    if (slot === undefined || !Number.isInteger(row.configIdx) || row.configIdx < 0 || row.configIdx >= configs.length) {
      throw new Error("report row is outside the run");
    }
    if (slot[row.configIdx] !== null) throw new Error("report row is duplicated");
    slot[row.configIdx] = row;
    perConfig[row.configIdx]!.push(row);
  }

  const cases = caseIds.map((id) => {
    const c = byId.get(id);
    if (c === undefined) throw new Error("run case is missing from its workload");
    const results = slots.get(id)!.map((row): ReportCaseResult | null =>
      row === null
        ? null
        : {
            status: row.result.status,
            correct: row.result.correct,
            ...capAnswer(row.result.answer),
            answerText: row.result.answerText === null ? null : cap(row.result.answerText),
            latencyMs: row.result.latencyMs,
          },
    );
    return { id, input: cap(c.input), expected: c.expected, results };
  });

  const disagreements = cases
    .filter((c) => new Set(c.results.filter((r) => r !== null).map((r) => r.correct)).size > 1)
    .map((c) => c.id);

  const { before, after } = input.balance;
  return {
    name: workload.name,
    systemPrompt: capPrompt(workload.systemPrompt),
    context: workload.context === null ? null : capPrompt(workload.context),
    answerSchema: workload.answerSchema,
    configs,
    totals: perConfig.map(totalsFor),
    balance: before === null && after === null ? null : { before, after },
    cases,
    disagreements,
    lint: lintWorkload(workload, { configs }),
  };
}

/**
 * The run's workload, re-checked by parseWorkload as it is read back (trust boundary 3).
 * Throws 404 not_found once the workload has passed its retention date, and a plain error
 * (500) when the stored data no longer parses.
 */
export async function loadWorkload(workloadId: string): Promise<Workload> {
  const rows = await db()`SELECT data FROM workloads WHERE id = ${workloadId} AND expires_at > now()`;
  if (rows[0] === undefined) throw new HttpError(404, "not_found");
  const parsed = parseWorkload(rows[0].data);
  if (!parsed.ok) throw new Error("stored workload failed validation");
  return parsed.workload;
}

const resultRowSchema = z.object({
  case_id: z.string(),
  config_idx: z.number().int(),
  result: z.unknown(),
  est_cost_usd: z.union([z.string(), z.number()]).nullable(),
});

/**
 * Loads everything a run's report needs and builds it. The caller has already checked access.
 * Throws 500 response_too_large when the serialised report passes CONFIG.reportResponseMaxBytes,
 * rather than sending a cut body (C29); the caps in buildReport keep a maximal run well under it.
 * Checked here rather than in each route, so the owner's and the public report share one cap.
 */
export async function loadReport(run: RunRecord): Promise<Report> {
  if (run.caseIds === null) throw new HttpError(404, "not_found");
  const workload = await loadWorkload(run.workloadId);
  const raw = z.array(resultRowSchema).parse(
    await db()`
      SELECT case_id, config_idx, result, est_cost_usd
      FROM case_results
      WHERE run_id = ${run.id} AND finished_at IS NOT NULL`,
  );
  const rows: ReportRow[] = raw.map((r) => {
    const cost = r.est_cost_usd === null ? null : Number(r.est_cost_usd);
    if (cost !== null && !Number.isFinite(cost)) throw new Error("stored cost is not a number");
    return { caseId: r.case_id, configIdx: r.config_idx, result: storedResultSchema.parse(r.result), estCostUsd: cost };
  });
  return assertReportSize(
    buildReport({
      workload,
      configs: run.configs,
      caseIds: run.caseIds,
      balance: { before: run.balanceBefore, after: run.balanceAfter },
      rows,
    }),
  );
}

/** Returns report unchanged when it serialises within CONFIG.reportResponseMaxBytes, else throws 500 response_too_large (C29). */
export function assertReportSize(report: Report): Report {
  const bytes = Buffer.byteLength(JSON.stringify(report), "utf8");
  if (bytes > CONFIG.reportResponseMaxBytes) {
    console.error(`[urai] report of ${bytes} bytes is over the response cap, refused`);
    throw new HttpError(500, "response_too_large");
  }
  return report;
}
