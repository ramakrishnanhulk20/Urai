import type { ExpectedValue, RunConfig, ServMode } from "@urai/engine";
import type { ConfigTotals, Report, ReportCaseResult, TruncatedText } from "../../lib/report";

const MODE_LABELS: Record<ServMode, string> = {
  raw: "SERV off",
  plain: "SERV plain",
  guard: "SERV with PromptGuard",
  multipath: "SERV Multipath",
  full: "SERV full",
};

/*
 * The plain-words name of a setting. The content filter flag is spelled out because two settings
 * can differ only by it, and they must never read as the same column.
 */
export function configLabel(config: RunConfig): string {
  const base = MODE_LABELS[config.mode] ?? config.mode;
  return config.mode !== "raw" && config.keepContentFilter === true ? `${base}, content filter kept` : base;
}

function onModes(configs: RunConfig[]): Set<ServMode> {
  return new Set(configs.filter((c) => c.mode !== "raw").map((c) => c.mode));
}

/** True when a run's settings use more than one model, which is when every label has to name its model. */
export function hasManyModels(configs: RunConfig[]): boolean {
  return new Set(configs.map((c) => c.model.trim().toLowerCase())).size > 1;
}

/*
 * Labels for every setting. When plain is the run's only SERV mode it reads "SERV on", the plain
 * opposite of "SERV off". Multipath, PromptGuard and full always keep their names, because "SERV
 * on" would hide that more than SERV's reasoning was switched on, and every mode is named when a
 * run compares two SERV modes. A run over two or more models leads every label with its model,
 * "gpt-6-luna, SERV on", because "SERV off against SERV on" would hide the other change. A run on
 * one model keeps the short labels, with the model added only where two would match.
 */
export function configLabels(configs: RunConfig[]): string[] {
  const single = onModes(configs).size <= 1;
  const base = configs.map((c) => {
    if (!single || c.mode !== "plain") return configLabel(c);
    return c.keepContentFilter === true ? "SERV on, content filter kept" : "SERV on";
  });
  if (hasManyModels(configs)) return base.map((label, i) => `${configs[i]!.model}, ${label}`);
  return base.map((label, i) =>
    base.filter((other) => other === label).length > 1 ? `${label} on ${configs[i]!.model}` : label,
  );
}

/** Defines "plain" the first time a report names it next to another SERV mode. Null when no mode is named. */
export function modeNote(configs: RunConfig[]): string | null {
  const modes = onModes(configs);
  if (modes.size <= 1 || !modes.has("plain")) return null;
  return "SERV plain means SERV's reasoning on, with its output filter off (Urai always switches it off so answers that quote the rules are not cut), nothing else added.";
}

// One decimal at most, trailing zero dropped, the same way the landing page writes it: 0.975 is 97.5.
export function percentNumber(accuracy: number): string {
  return String(Number((accuracy * 100).toFixed(1)));
}

export function percent(accuracy: number | null): string {
  return accuracy === null ? "unknown" : `${percentNumber(accuracy)}%`;
}

export function count(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString("en-US");
}

export function seconds(ms: number | null): string {
  if (ms === null) return "unknown";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Up to four decimals below a dollar, because a whole run of cheap calls is often a few cents,
// with trailing zeros dropped down to cents: 0.1 reads $0.10 and 0.0375 reads $0.0375.
export function usd(value: number | null): string {
  if (value === null) return "unknown";
  const fixed = value.toFixed(Math.abs(value) >= 1 ? 2 : 4);
  return `$${fixed.replace(/(\.\d\d\d*?)0+$/, "$1")}`;
}

/*
 * A price per unit, which is often a small fraction of a cent: two significant digits instead of
 * usd's four decimals, so $0.00026 never rounds to $0.0003 or, for a cheaper model, to $0.0000.
 */
export function unitUsd(value: number | null): string {
  if (value === null) return "unknown";
  if (value === 0 || Math.abs(value) >= 0.01) return usd(value);
  const decimals = Math.min(10, 1 - Math.floor(Math.log10(Math.abs(value))));
  return `$${value.toFixed(decimals).replace(/0+$/, "")}`;
}

export type PerCorrect = { kind: "unknown" } | { kind: "none" } | { kind: "usd"; value: number };

/**
 * What each right answer cost under one setting: its estimated cost from SERV's token counts
 * divided by its right answers. Unknown when that cost is unknown, so a partial sum is never
 * divided; "none" when no answer was right, where there is nothing to divide by.
 */
export function costPerCorrect(t: ConfigTotals | undefined): PerCorrect {
  if (t === undefined || t.estCostUsd === null) return { kind: "unknown" };
  if (t.correct === 0) return { kind: "none" };
  return { kind: "usd", value: t.estCostUsd / t.correct };
}

export function perCorrectText(p: PerCorrect): string {
  if (p.kind === "unknown") return "unknown";
  return p.kind === "none" ? "no correct answers" : unitUsd(p.value);
}

/** The one line that says what cost per correct answer is, shared by the report and the run ledger. */
export const PER_CORRECT_NOTE =
  "Cost per correct answer is each setting's estimated cost divided by its right answers, so it is an estimate in the same way: a setting that is cheaper per call can still cost more per right answer if it gets fewer right.";

/** Why a setting's estimated cost reads unknown. */
export type CostGap = "unpriced" | "no_counts";

/*
 * lib/prices.ts gives no price to a Multipath or full call, or to a model on neither price list,
 * even when SERV sent every token count. Only a setting whose counts are really missing gets the
 * token-count reason. Null when the cost is known.
 */
export function costGap(config: RunConfig | undefined, t: ConfigTotals | undefined): CostGap | null {
  if (t === undefined || t.estCostUsd !== null) return null;
  if (config?.mode === "multipath" || config?.mode === "full") return "unpriced";
  return t.inputTokens === null || t.outputTokens === null ? "no_counts" : "unpriced";
}

export const UNPRICED_REASON = "Urai does not price Multipath, full, or a model missing from the price list";

function joinWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One or two sentences naming each setting whose cost is unknown and the real reason. Null when every cost is known. */
export function costGapText(configs: RunConfig[], totals: ConfigTotals[], labels: string[]): string | null {
  const unpriced: string[] = [];
  const noCounts: string[] = [];
  totals.forEach((t, i) => {
    const gap = costGap(configs[i], t);
    if (gap === "unpriced") unpriced.push(labels[i] ?? `Setting ${i + 1}`);
    else if (gap === "no_counts") noCounts.push(labels[i] ?? `Setting ${i + 1}`);
  });
  const reads = (n: number): string => (n === 1 ? "reads" : "read");
  const parts = [
    ...(unpriced.length > 0 ? [`${joinWords(unpriced)} ${reads(unpriced.length)} unknown: ${UNPRICED_REASON}.`] : []),
    ...(noCounts.length > 0
      ? [`${joinWords(noCounts)} ${reads(noCounts.length)} unknown because SERV did not send token counts for every call.`]
      : []),
  ];
  return parts.length === 0 ? null : parts.join(" ");
}

/** True when a run has a setting Urai never prices, whatever its token counts. */
export function hasUnpricedMode(configs: RunConfig[]): boolean {
  return configs.some((c) => c.mode === "multipath" || c.mode === "full");
}

/** A run's cost from SERV's token counts: the sum over its settings, or null when any setting's cost is unknown. */
export function tokenCost(totals: ConfigTotals[]): number | null {
  let sum = 0;
  for (const t of totals) {
    if (t.estCostUsd === null) return null;
    sum += t.estCostUsd;
  }
  return sum;
}

/*
 * The measured drop for a run that stored two real readings, taken before SERV stopped offering a
 * free balance read on 25 Sep. Null when a reading is missing or the balance rose, as a top-up
 * during the run would make the difference meaningless.
 */
export function measuredDrop(balance: Report["balance"]): number | null {
  if (balance === null || balance.before === null || balance.after === null) return null;
  const drop = balance.before - balance.after;
  return drop < 0 ? null : drop;
}

export type StatusTone = "right" | "wrong" | "other" | "pending";

export interface StatusView {
  tone: StatusTone;
  word: string;
}

const STATUS_WORDS: Record<ReportCaseResult["status"], string> = {
  scored: "Wrong",
  failed: "Failed",
  refused: "Refused",
  filtered: "Filtered",
  timeout: "Timed out",
  upstream_error: "No response",
};

/** How one answer reads on the page. Anything that is not a right answer counts as wrong in the accuracy. */
export function statusView(result: ReportCaseResult | null): StatusView {
  if (result === null) return { tone: "pending", word: "Not run yet" };
  if (result.correct) return { tone: "right", word: "Right" };
  return { tone: result.status === "scored" ? "wrong" : "other", word: STATUS_WORDS[result.status] ?? result.status };
}

const ELLIPSIS = "...";

// Drops a word cut in half at either end, as long as that keeps most of the quote.
function trimEnd(text: string): string {
  const at = text.search(/\s+\S*$/);
  return at > text.length / 2 ? text.slice(0, at).replace(/[\s,;:]+$/, "") : text;
}

function trimStart(text: string): string {
  const m = /^\S*\s+/.exec(text);
  return m !== null && m[0].length < text.length / 2 ? text.slice(m[0].length) : text;
}

/*
 * A setup finding's evidence as a reader sees it. The setup check cuts long evidence with "..."
 * and quotes a prompt template from a fixed number of characters either side, so both can end, or
 * start, halfway through a word. This cuts back to whole words and marks each cut with "...".
 */
export function evidenceText(finding: { id: string; evidence: string | null }): string | null {
  const raw = finding.evidence;
  if (raw === null) return null;
  const cutEnd = raw.endsWith(ELLIPSIS);
  let text = cutEnd ? raw.slice(0, -ELLIPSIS.length) : raw;
  if (finding.id === "templated-system-prompt") return snippetText(text);
  // The quoting finding ends with a prompt snippet in quotes: `...; prompt: "<snippet>"`.
  const at = finding.id === "quotes-instructions" ? text.indexOf(PROMPT_QUOTE) : -1;
  if (at !== -1) {
    const head = text.slice(0, at + PROMPT_QUOTE.length);
    const body = text.slice(at + PROMPT_QUOTE.length).replace(/"$/, "");
    return `${head}${snippetText(body)}"`;
  }
  if (!cutEnd) return raw;
  text = trimEnd(text);
  return `${text}${ELLIPSIS}`;
}

const PROMPT_QUOTE = 'prompt: "';

// A prompt snippet is taken a fixed number of characters either side of a match, so both ends can fall mid-word.
function snippetText(text: string): string {
  const start = trimStart(text);
  const end = trimEnd(start);
  return `${start !== text ? ELLIPSIS : ""}${end}${ELLIPSIS}`;
}

/*
 * The operator samples the builder can load by slug, as /new?sample=bad. A report is matched by
 * its name and its full system prompt length, so a team's own agent that borrowed a sample's name
 * is not taken for it. test/report-render.test.tsx checks these against packages/engine/workloads.
 */
export const SAMPLE_WORKLOADS = [
  { slug: "bad", name: "Invoice approvals: supplier book inside the system prompt", promptChars: 21_337 },
  { slug: "good", name: "Invoice approvals: rules in the system prompt, data in the user message", promptChars: 13_979 },
  { slug: "hard", name: "Invoice approvals, hard set: four layered rule sources, data in the user message", promptChars: 42_695 },
] as const;

/** Where a report's "Open the builder" link goes: the builder with that sample loaded, or the empty builder. */
export function builderHref(report: Pick<Report, "name" | "systemPrompt">): string {
  const chars = isTruncated(report.systemPrompt) ? report.systemPrompt.chars : report.systemPrompt.length;
  const sample = SAMPLE_WORKLOADS.find((x) => x.name === report.name && x.promptChars === chars);
  return sample === undefined ? "/new" : `/new?sample=${sample.slug}`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

export function expectedText(value: ExpectedValue): string {
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  return value === null ? "null" : String(value);
}

/** Any answer field as short text. Objects go through JSON.stringify, so nothing is ever read as markup. */
export function valueText(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return value.length === 0 ? "none" : value.join(", ");
  }
  return JSON.stringify(value) ?? "unreadable";
}

export function isTruncated(text: string | TruncatedText): text is TruncatedText {
  return typeof text === "object" && text !== null && text.truncated === true;
}

export interface SummaryPart {
  text: string;
  strong?: boolean;
}

/** Input plus output tokens, the same basis the landing page uses. Null when either count is missing. */
export function totalTokens(t: ConfigTotals | undefined): number | null {
  if (t === undefined || t.inputTokens === null || t.outputTokens === null) return null;
  return t.inputTokens + t.outputTokens;
}

function tokensClause(a: number | null, b: number | null): SummaryPart[] {
  if (a === null || b === null) return [{ text: "token use is " }, { text: "unknown", strong: true }];
  if (a === b) return [{ text: "using the same number of tokens" }];
  if (b === 0) return [{ text: "using " }, { text: count(a), strong: true }, { text: " tokens against none" }];
  const change = Math.round(Math.abs(1 - a / b) * 100);
  if (change === 0) return [{ text: "using about the same number of tokens" }];
  return [{ text: "using " }, { text: `${change}% ${a < b ? "fewer" : "more"}`, strong: true }, { text: " tokens" }];
}

/*
 * The two settings the one-line verdict compares: a SERV setting against SERV off when the run has
 * both, otherwise the first two. On a run over several models it prefers a pair on two different
 * models, so the sentence names both models instead of hiding the second one.
 */
function summaryPair(configs: RunConfig[]): [number, number] {
  const idx = configs.map((_, i) => i);
  const ons = idx.filter((i) => configs[i]!.mode !== "raw");
  const offs = idx.filter((i) => configs[i]!.mode === "raw");
  const many = hasManyModels(configs);
  const differ = (i: number, j: number): boolean => configs[i]!.model.trim().toLowerCase() !== configs[j]!.model.trim().toLowerCase();
  if (ons.length > 0 && offs.length > 0) {
    if (many) {
      for (const on of ons) for (const off of offs) if (differ(on, off)) return [on, off];
    }
    return [ons[0]!, offs[0]!];
  }
  const other = many ? idx.find((j) => j > 0 && differ(0, j)) : undefined;
  return [0, other ?? 1];
}

/*
 * The one-line verdict at the top of the page, built only from the report's own numbers. It
 * compares the pair summaryPair picks, or describes the one setting. A null total reads as "unknown".
 */
export function summarize(report: Report): SummaryPart[] {
  const { configs, totals } = report;
  const labels = configLabels(configs);
  const cases = report.cases.length;

  if (configs.length === 1) {
    const t = totals[0];
    return [
      { text: `${labels[0]} with ${configs[0]!.model} scored ` },
      { text: percent(t?.accuracy ?? null), strong: true },
      { text: ` across ${cases} ${cases === 1 ? "case" : "cases"}` },
      ...(t === undefined || t.calls === 0
        ? [{ text: ", with no finished answers yet." }]
        : [
            { text: `, ${t.correct} of ${t.calls} right, using ` },
            { text: count(totalTokens(t)), strong: true },
            { text: " tokens, input and output." },
          ]),
    ];
  }

  const [a, b] = summaryPair(configs);
  const ta: ConfigTotals | undefined = totals[a];
  const tb: ConfigTotals | undefined = totals[b];

  return [
    { text: `${labels[a]} scored ` },
    { text: percent(ta?.accuracy ?? null), strong: true },
    { text: " against " },
    { text: percent(tb?.accuracy ?? null), strong: true },
    { text: ` with ${labels[b]}, ` },
    ...tokensClause(totalTokens(ta), totalTokens(tb)),
    { text: "." },
  ];
}

/*
 * Stored run names can name the mode ("..., SERV plain"). When plain is the run's one SERV mode the
 * page calls it "SERV on", so the name is read the same way.
 */
export function servTerms(text: string, configs: RunConfig[]): string {
  const modes = onModes(configs);
  return modes.size === 1 && modes.has("plain") ? text.replace(/\bSERV plain\b/g, "SERV on") : text;
}

export function summaryText(parts: SummaryPart[]): string {
  return parts.map((p) => p.text).join("");
}

/*
 * Splits "Invoice approvals: rules in the prompt" into a short title and a deck line, the way a
 * poster sets the name large and the tagline small. A name with no colon stays whole.
 */
export function splitName(name: string): { title: string; deck: string | null } {
  const at = name.indexOf(": ");
  if (at < 3 || at > 60 || at + 2 >= name.length) return { title: name, deck: null };
  return { title: name.slice(0, at), deck: name.slice(at + 2) };
}
