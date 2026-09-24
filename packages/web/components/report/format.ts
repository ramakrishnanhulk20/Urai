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

/** Labels for every setting, with the model added only where two labels would otherwise match. */
export function configLabels(configs: RunConfig[]): string[] {
  const plain = configs.map(configLabel);
  return plain.map((label, i) =>
    plain.filter((other) => other === label).length > 1 ? `${label} on ${configs[i]!.model}` : label,
  );
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

function tokensClause(a: number | null, b: number | null): SummaryPart[] {
  if (a === null || b === null) return [{ text: "input token use is " }, { text: "unknown", strong: true }];
  if (a === b) return [{ text: "using the same number of input tokens" }];
  if (b === 0) return [{ text: "using " }, { text: count(a), strong: true }, { text: " input tokens against none" }];
  const change = Math.round(Math.abs(1 - a / b) * 100);
  if (change === 0) return [{ text: "using about the same number of input tokens" }];
  return [{ text: "using " }, { text: `${change}% ${a < b ? "fewer" : "more"}`, strong: true }, { text: " input tokens" }];
}

/*
 * The one-line verdict at the top of the page, built only from the report's own numbers. When
 * SERV was run both on and off it compares the first SERV setting with SERV off; otherwise it
 * compares the first two settings, or describes the one. A null total reads as "unknown".
 */
export function summarize(report: Report): SummaryPart[] {
  const { configs, totals } = report;
  const labels = configLabels(configs);
  const cases = report.cases.length;

  if (configs.length === 1) {
    const t = totals[0];
    return [
      { text: `${labels[0]} on ${configs[0]!.model} scored ` },
      { text: percent(t?.accuracy ?? null), strong: true },
      { text: ` across ${cases} ${cases === 1 ? "case" : "cases"}` },
      ...(t === undefined || t.calls === 0
        ? [{ text: ", with no finished answers yet." }]
        : [
            { text: `, ${t.correct} of ${t.calls} right, using ` },
            { text: count(t.inputTokens), strong: true },
            { text: " input tokens." },
          ]),
    ];
  }

  const off = configs.findIndex((c) => c.mode === "raw");
  const on = configs.findIndex((c) => c.mode !== "raw");
  const [a, b] = off !== -1 && on !== -1 ? [on, off] : [0, 1];
  const ta: ConfigTotals | undefined = totals[a];
  const tb: ConfigTotals | undefined = totals[b];

  return [
    { text: `${labels[a]} scored ` },
    { text: percent(ta?.accuracy ?? null), strong: true },
    { text: " against " },
    { text: percent(tb?.accuracy ?? null), strong: true },
    { text: ` with ${labels[b]}, ` },
    ...tokensClause(ta?.inputTokens ?? null, tb?.inputTokens ?? null),
    { text: "." },
  ];
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
