import { LIMITS } from "./limits.js";
import { normaliseModelId } from "./model-id.js";
import type { ModelList, RunConfig, Workload } from "./types.js";

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
  id:
    | "data-in-system-prompt"
    | "quotes-instructions"
    | "strict-schema"
    | "model-unknown"
    | "model-unverified"
    | "templated-system-prompt"
    | "first-sight-cost"
    | "full-mode-cost"
    | "large-system-prompt";
  severity: LintSeverity;
  title: string;
  detail: string;
  evidence: string | null;
  fixable: boolean;
  /** Character ranges in systemPrompt, empty if none. */
  spans: { start: number; end: number }[];
}

export type DataBlockKind = "json" | "table" | "csv" | "records";

export interface DataBlock {
  start: number;
  end: number;
  heading: string | null;
  kind: DataBlockKind;
}

/** A line of the prompt without its "\n". Lines keep any "\r", so joining them with "\n" rebuilds the text exactly. */
export interface PromptLine {
  start: number;
  text: string;
}

/** A data block with the line numbers the layout fix needs to cut it out cleanly. */
export interface ScannedBlock extends DataBlock {
  first: number;
  last: number;
  headingLine: number | null;
}

const JSON_MIN_CHARS = 200;
const TABLE_MIN_ROWS = 3;
const CSV_MIN_LINES = 4;
const CSV_MIN_DELIMITERS = 2;
const RECORDS_MIN_LINES = 5;
const RECORDS_MIN_KINDS = 2;
const LARGE_PROMPT_CHARS = 20_000;

/*
 * Every regular expression in the lint and the layout fix. Each one is either anchored at both
 * ends and run on a single token, or is one character class under one quantifier, or is a fixed
 * alternation of words. None has a nested or overlapping quantifier, so each runs in linear time
 * (C13). The token splitter below keeps email and number checks off whole lines.
 */
const TOKEN_SPLIT = /[\s,;|]+/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EMAIL_LOCAL = /^[A-Za-z0-9._%+-]+$/;
const EMAIL_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}(?:T\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z?)?$/;
const SLASH_DATE = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
const MARKDOWN_HEADING = /^#{1,6}\s/;
const CITE_OR_QUOTE = /\b(?:cite|cites|cited|citing|quote|quotes|quoted|quoting)\b/gi;
const WHITESPACE_RUN = /\s+/g;

const TEMPLATE_MARKERS = ["{{", "{%", "${"] as const;

const QUOTING_WORDS = new Set([
  "clause",
  "clauses",
  "rule",
  "rules",
  "policy",
  "policies",
  "citation",
  "citations",
  "cite",
  "cites",
  "quote",
  "quotes",
  "section",
  "sections",
  "article",
  "articles",
  "reference",
  "references",
]);

const DETAIL = {
  data:
    "SERV rewrites the system prompt into its own compressed reasoning graph and drops data it finds there. In our runs a 6,600-token prompt became about 2,100 tokens and accuracy fell from 94% to 66-72% until the data moved to the user message.",
  quotes:
    "SERV's default output filter cuts answers that restate the instructions (10 of 17 in our first run); Urai tests with serv_disable_content_filter; add it in production too.",
  strict:
    "OpenAI strict structured outputs reject such schemas with a 400: every object must set additionalProperties to false and list every property in required.",
  unknown: "These model ids are not in SERV's live model list, so SERV has no model to send these calls to.",
  unverified: "SERV's model list could not be read just now, so these model ids were not checked against it.",
  templated:
    "If it changes per request, SERV rebuilds its reasoning graph each time, and each build cost about 0.60 USD in our runs.",
  firstSight:
    "The first request with a new system prompt makes SERV build its reasoning graph, about 0.60 USD in our runs; any change, even one character, builds a new one, and a built graph is cached for 30 days.",
  fullMode:
    "Full mode (Multipath, PromptGuard and Shadow Agent) cost about 0.25 USD and took about 60 s per call in our runs, against about 0.003 USD for plain SERV.",
  large:
    "SERV compresses the system prompt into its own graph (about 6,600 tokens became about 2,100 in our runs), so a long prompt has the most detail to lose.",
  couldNotRun: "The check stopped before it finished, so nothing in this test set was checked. Treat it as unchecked, not as clean.",
} as const;

/** Thrown for input the lint refuses to inspect. Its message is our own words, safe to show. */
class LintInputError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export { normaliseModelId };

function cap(text: string): string {
  return text.length > LIMITS.lintEvidenceMaxChars ? `${text.slice(0, LIMITS.lintEvidenceMaxChars - 3)}...` : text;
}

function isBlank(line: PromptLine): boolean {
  return line.text.trim() === "";
}

export function splitLines(text: string): PromptLine[] {
  const lines: PromptLine[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ start, text: text.slice(start) });
      return lines;
    }
    lines.push({ start, text: text.slice(start, nl) });
    start = nl + 1;
  }
}

function lineEnd(line: PromptLine): number {
  return line.start + line.text.length - (line.text.endsWith("\r") ? 1 : 0);
}

interface Candidate {
  open: number;
  close: number;
  openLine: number;
  closeLine: number;
}

/*
 * One linear pass that pairs every bracket that starts a line with its closing bracket. A JSON
 * string never spans a newline, so string state resets at each line end. That makes the state at
 * any line-leading bracket the same whichever earlier bracket a scan began from, so one shared
 * stack gives exactly the pairs that a separate scan per candidate would, without rescanning.
 */
function bracketCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const stack: { pos: number; close: "}" | "]"; leading: boolean; line: number }[] = [];
  let inString = false;
  let escaped = false;
  let lineHasContent = false;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      inString = false;
      escaped = false;
      lineHasContent = false;
      line++;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    const leading = !lineHasContent;
    if (ch !== " " && ch !== "\t" && ch !== "\r") lineHasContent = true;
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push({ pos: i, close: ch === "{" ? "}" : "]", leading, line });
    } else if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if (top === undefined) continue;
      if (top.close === ch) {
        stack.pop();
        if (top.leading) out.push({ open: top.pos, close: i, openLine: top.line, closeLine: line });
      } else {
        // A mismatched bracket breaks every span still open, exactly as it would break each one's own scan.
        stack.length = 0;
      }
    }
  }
  return out.sort((a, b) => a.open - b.open);
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonBlocks(text: string, lines: PromptLine[]): ScannedBlock[] {
  const blocks: ScannedBlock[] = [];
  let budget = LIMITS.lintJsonParseBudgetChars;
  let skipUntil = 0;
  for (const c of bracketCandidates(text)) {
    if (c.open < skipUntil) continue;
    const length = c.close + 1 - c.open;
    if (length < JSON_MIN_CHARS) {
      // Every span nested inside this one is shorter still.
      skipUntil = c.close + 1;
      continue;
    }
    const closing = lines[c.closeLine]!;
    if (text.slice(c.close + 1, closing.start + closing.text.length).trim() !== "") continue;
    budget -= length;
    if (budget < 0) throw new LintInputError("The prompt has more nested brackets than the check will parse.");
    if (!parsesAsJson(text.slice(c.open, c.close + 1))) continue;
    blocks.push({ start: c.open, end: c.close + 1, heading: null, kind: "json", first: c.openLine, last: c.closeLine, headingLine: null });
    skipUntil = c.close + 1;
  }
  return blocks;
}

/** Runs of at least minLen consecutive unclaimed lines that share the same non-null key. */
function lineRuns(lines: PromptLine[], claimed: boolean[], keyOf: (text: string) => string | null, minLen: number): [number, number][] {
  const runs: [number, number][] = [];
  let first = -1;
  let key: string | null = null;
  for (let i = 0; i <= lines.length; i++) {
    const k = i < lines.length && !claimed[i] ? keyOf(lines[i]!.text) : null;
    if (k !== null && k === key) continue;
    if (first >= 0 && i - first >= minLen) runs.push([first, i - 1]);
    first = k === null ? -1 : i;
    key = k;
  }
  return runs;
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) n++;
  return n;
}

function tableKey(text: string): string | null {
  const t = text.trim();
  return t.startsWith("|") && countChar(t, "|") >= 2 ? "table" : null;
}

// A CSV row has short cells and no list marker; prose bullets full of commas (the hard sample
// rulebook's "- Source N, ..., ..." lines) were read as data and moved out of the rules.
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s/;
const CSV_MAX_CELL_CHARS = 60;

function delimiterKey(ch: string): (text: string) => string | null {
  return (text) => {
    if (LIST_MARKER.test(text) || text.split(ch).some((cell) => cell.trim().length > CSV_MAX_CELL_CHARS)) return null;
    const n = countChar(text, ch);
    return n >= CSV_MIN_DELIMITERS ? String(n) : null;
  };
}

const LEADING_PUNCT = new Set(['"', "'", "(", "[", "{", "<", "`", "*", "_"]);
const TRAILING_PUNCT = new Set(['"', "'", ")", "]", "}", ">", "`", "*", "_", ".", ":", "!", "?"]);

function trimPunct(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && LEADING_PUNCT.has(token[a]!)) a++;
  while (b > a && TRAILING_PUNCT.has(token[b - 1]!)) b--;
  return token.slice(a, b);
}

function countDigits(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i]! >= "0" && text[i]! <= "9") n++;
  return n;
}

type RecordKind = "email" | "address" | "url" | "number" | "date";

function recordKind(raw: string): RecordKind | null {
  const t = trimPunct(raw);
  if (t === "") return null;
  const at = t.indexOf("@");
  if (at > 0) return EMAIL_LOCAL.test(t.slice(0, at)) && EMAIL_DOMAIN.test(t.slice(at + 1)) ? "email" : null;
  if (ADDRESS.test(t)) return "address";
  const lower = t.slice(0, 8).toLowerCase();
  if ((lower.startsWith("http://") && t.length > 7) || (lower.startsWith("https://") && t.length > 8)) return "url";
  if (ISO_DATE.test(t) || SLASH_DATE.test(t)) return "date";
  let n = t;
  if (n.startsWith("$") || n.startsWith("€") || n.startsWith("£")) n = n.slice(1);
  if (n.endsWith("%")) n = n.slice(0, -1);
  return PLAIN_NUMBER.test(n) && countDigits(n) >= 3 ? "number" : null;
}

function recordKey(text: string): string | null {
  const kinds = new Set<RecordKind>();
  for (const token of text.split(TOKEN_SPLIT)) {
    const k = recordKind(token);
    if (k !== null) kinds.add(k);
    if (kinds.size >= RECORDS_MIN_KINDS) return "record";
  }
  return null;
}

function headingAbove(lines: PromptLine[], claimed: boolean[], first: number): string | null {
  const i = first - 1;
  if (i < 0 || claimed[i]) return null;
  const t = lines[i]!.text.trim();
  if (t === "" || t.length > LIMITS.lintHeadingMaxChars) return null;
  const allCaps = t === t.toUpperCase() && t !== t.toLowerCase();
  return MARKDOWN_HEADING.test(t) || t.endsWith(":") || allCaps ? t : null;
}

/**
 * Finds every data block in a system prompt, with the line numbers the layout fix uses.
 * Throws when the input is not a string, is over LIMITS.systemPromptMaxChars, or would take more
 * JSON parsing than LIMITS.lintJsonParseBudgetChars allows. It never returns an empty list for a
 * prompt it did not finish checking (C26).
 */
export function scanDataBlocks(systemPrompt: string): { lines: PromptLine[]; blocks: ScannedBlock[] } {
  if (typeof systemPrompt !== "string") throw new LintInputError("The system prompt is not text.");
  if (systemPrompt.length > LIMITS.systemPromptMaxChars) {
    throw new LintInputError(`The system prompt is over the ${LIMITS.systemPromptMaxChars} character limit.`);
  }
  const lines = splitLines(systemPrompt);
  const claimed = new Array<boolean>(lines.length).fill(false);
  const blocks: ScannedBlock[] = [];
  const claim = (b: ScannedBlock) => {
    for (let i = b.first; i <= b.last; i++) claimed[i] = true;
    blocks.push(b);
  };
  const lineBlock = (kind: DataBlockKind) => ([first, last]: [number, number]) =>
    claim({ start: lines[first]!.start, end: lineEnd(lines[last]!), heading: null, kind, first, last, headingLine: null });

  jsonBlocks(systemPrompt, lines).forEach(claim);
  lineRuns(lines, claimed, tableKey, TABLE_MIN_ROWS).forEach(lineBlock("table"));
  lineRuns(lines, claimed, delimiterKey(","), CSV_MIN_LINES).forEach(lineBlock("csv"));
  lineRuns(lines, claimed, delimiterKey("\t"), CSV_MIN_LINES).forEach(lineBlock("csv"));
  lineRuns(lines, claimed, recordKey, RECORDS_MIN_LINES).forEach(lineBlock("records"));

  // Headings are chosen only once every block is known, so a line inside any block is never a heading.
  for (const b of blocks) {
    b.heading = headingAbove(lines, claimed, b.first);
    b.headingLine = b.heading === null ? null : b.first - 1;
  }
  for (const b of blocks) if (b.headingLine !== null) claimed[b.headingLine] = true;
  return { lines, blocks: blocks.sort((a, b) => a.start - b.start) };
}

/**
 * Finds the data blocks in a system prompt: JSON objects or arrays of 200 or more characters that
 * parse, markdown tables of 3 or more rows, CSV-like runs of 4 or more lines with the same count
 * (2 or more) of commas or of tabs, and runs of 5 or more lines that each hold two or more of an
 * email, a 0x address, a URL, a 3-digit number and a date. start and end cover the block itself;
 * heading is the line directly above it when that line is all caps, a markdown heading or ends
 * with a colon. Sorted by start.
 * Throws, rather than returning an empty list, when the check cannot run: input that is not a
 * string, over LIMITS.systemPromptMaxChars, or past the JSON parse budget (C13, C26).
 */
export function findDataBlocks(systemPrompt: string): DataBlock[] {
  return scanDataBlocks(systemPrompt).blocks.map(({ start, end, heading, kind }) => ({ start, end, heading, kind }));
}

function nameParts(name: string): string[] {
  const parts: string[] = [];
  let cur = "";
  const isUpper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
  const isLower = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
  for (const ch of name) {
    if (!isUpper(ch) && !isLower(ch)) {
      if (cur !== "") parts.push(cur);
      cur = "";
      continue;
    }
    if (isUpper(ch) && cur !== "" && !isUpper(cur[cur.length - 1])) {
      parts.push(cur);
      cur = "";
    } else if (isLower(ch) && cur.length >= 2 && isUpper(cur[cur.length - 1]) && isUpper(cur[cur.length - 2])) {
      // "HTTPReference" splits as "HTTP" and "Reference".
      parts.push(cur.slice(0, -1));
      cur = cur.slice(-1);
    }
    cur += ch;
  }
  if (cur !== "") parts.push(cur);
  return parts.map((p) => p.toLowerCase());
}

function walkSchema(node: unknown, path: string, depth: number, visit: (node: Record<string, unknown>, path: string) => void): void {
  if (depth > LIMITS.schemaMaxDepth) throw new LintInputError(`The answer schema is nested deeper than ${LIMITS.schemaMaxDepth} levels.`);
  if (!isPlainObject(node)) return;
  visit(node, path);
  if (isPlainObject(node.properties)) {
    for (const [k, sub] of Object.entries(node.properties)) walkSchema(sub, `${path}.properties.${k}`, depth + 1, visit);
  }
  if (isPlainObject(node.items)) walkSchema(node.items, `${path}.items`, depth + 1, visit);
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((s, i) => walkSchema(s, `${path}.anyOf[${i}]`, depth + 1, visit));
  if (isPlainObject(node.additionalProperties)) walkSchema(node.additionalProperties, `${path}.additionalProperties`, depth + 1, visit);
}

function isObjectSchema(node: Record<string, unknown>): boolean {
  return node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || isPlainObject(node.properties);
}

function isStrictObject(node: Record<string, unknown>): boolean {
  const props = isPlainObject(node.properties) ? Object.keys(node.properties) : [];
  const required = Array.isArray(node.required) ? node.required : [];
  return node.additionalProperties === false && props.every((p) => required.includes(p));
}

function markerSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const m of TEMPLATE_MARKERS) {
    for (let i = text.indexOf(m); i !== -1 && spans.length < LIMITS.lintSpansMax; i = text.indexOf(m, i + m.length)) {
      spans.push({ start: i, end: i + m.length });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function snippet(text: string, start: number, end: number): string {
  return cap(text.slice(Math.max(0, start - 40), end + 80).replace(WHITESPACE_RUN, " ").trim());
}

const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

function runChecks(w: Workload, opts: { models?: ModelList; configs?: RunConfig[] }): LintFinding[] {
  const { blocks } = scanDataBlocks(w.systemPrompt);
  const sp = w.systemPrompt;
  const configs = opts.configs ?? [];
  if (!Array.isArray(configs) || configs.length > LIMITS.configsPerRunMax) {
    throw new LintInputError(`A run takes at most ${LIMITS.configsPerRunMax} configurations.`);
  }
  if (!isPlainObject(w.answerSchema) || JSON.stringify(w.answerSchema).length > LIMITS.schemaMaxBytes) {
    throw new LintInputError("The answer schema is missing or over the size limit.");
  }
  const findings: LintFinding[] = [];

  if (blocks.length > 0) {
    findings.push({
      id: "data-in-system-prompt",
      severity: "error",
      title: "Data sits inside the system prompt",
      detail: DETAIL.data,
      evidence: cap(blocks.map((b) => `${b.heading ?? "unlabelled"} (${b.kind}, ${b.end - b.start} characters)`).join("; ")),
      fixable: true,
      spans: blocks.slice(0, LIMITS.lintSpansMax).map((b) => ({ start: b.start, end: b.end })),
    });
  }

  const quotingNames: string[] = [];
  const looseObjects: string[] = [];
  walkSchema(w.answerSchema, "answerSchema", 1, (node, path) => {
    if (isObjectSchema(node) && !isStrictObject(node)) looseObjects.push(path);
    if (!isPlainObject(node.properties)) return;
    for (const name of Object.keys(node.properties)) {
      if (nameParts(name).some((p) => QUOTING_WORDS.has(p))) quotingNames.push(name);
    }
  });
  const citeSpans: { start: number; end: number }[] = [];
  for (const m of sp.matchAll(CITE_OR_QUOTE)) {
    citeSpans.push({ start: m.index, end: m.index + m[0].length });
    if (citeSpans.length >= LIMITS.lintSpansMax) break;
  }
  if (quotingNames.length > 0 || citeSpans.length > 0) {
    const parts: string[] = [];
    if (quotingNames.length > 0) parts.push(`answer fields: ${quotingNames.join(", ")}`);
    if (citeSpans.length > 0) parts.push(`prompt: "${snippet(sp, citeSpans[0]!.start, citeSpans[0]!.end)}"`);
    findings.push({
      id: "quotes-instructions",
      severity: "warning",
      title: "Answers that quote the instructions get cut",
      detail: DETAIL.quotes,
      evidence: cap(parts.join("; ")),
      fixable: false,
      spans: citeSpans,
    });
  }

  const modelIds = [...new Set(configs.map((c) => normaliseModelId(String(c.model))))];
  if (modelIds.some((id) => id.startsWith("gpt-")) && looseObjects.length > 0) {
    findings.push({
      id: "strict-schema",
      severity: "warning",
      title: "The answer schema is not strict enough for OpenAI models",
      detail: DETAIL.strict,
      evidence: cap(looseObjects.join(", ")),
      fixable: false,
      spans: [],
    });
  }

  if (opts.models !== undefined && modelIds.length > 0) {
    const list = opts.models;
    const listed = list.ok === true && Array.isArray(list.models) && list.models.length <= LIMITS.modelsMax ? list.models : null;
    if (listed === null) {
      findings.push({
        id: "model-unverified",
        severity: "info",
        title: "Model ids could not be checked",
        detail: DETAIL.unverified,
        evidence: cap(modelIds.join(", ")),
        fixable: false,
        spans: [],
      });
    } else {
      const known = new Set(listed.filter((m) => typeof m.id === "string").map((m) => normaliseModelId(m.id)));
      const unknown = modelIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        findings.push({
          id: "model-unknown",
          severity: "error",
          title: "SERV does not offer this model",
          detail: DETAIL.unknown,
          evidence: cap(unknown.map((id) => (id === "" ? '""' : id)).join(", ")),
          fixable: false,
          spans: [],
        });
      }
    }
  }

  const templateSpans = markerSpans(sp);
  if (templateSpans.length > 0) {
    findings.push({
      id: "templated-system-prompt",
      severity: "warning",
      title: "The system prompt looks like a template",
      detail: DETAIL.templated,
      evidence: snippet(sp, templateSpans[0]!.start, templateSpans[0]!.end),
      fixable: false,
      spans: templateSpans,
    });
  }

  findings.push({
    id: "first-sight-cost",
    severity: "info",
    title: "The first call pays for SERV's reasoning graph",
    detail: DETAIL.firstSight,
    evidence: null,
    fixable: false,
    spans: [],
  });

  const fullModels = [...new Set(configs.filter((c) => c.mode === "full").map((c) => normaliseModelId(String(c.model))))];
  if (fullModels.length > 0) {
    findings.push({
      id: "full-mode-cost",
      severity: "info",
      title: "Full mode is slow and costly",
      detail: DETAIL.fullMode,
      evidence: cap(`full mode on: ${fullModels.join(", ")}`),
      fixable: false,
      spans: [],
    });
  }

  if (sp.length > LARGE_PROMPT_CHARS) {
    findings.push({
      id: "large-system-prompt",
      severity: "info",
      title: "The system prompt is long",
      detail: DETAIL.large,
      evidence: `${sp.length} characters, over ${LARGE_PROMPT_CHARS}`,
      fixable: false,
      spans: [],
    });
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * Checks a team's test set for the SERV setup mistakes we measured and returns one finding per
 * rule that fires, errors first. first-sight-cost is always present. Model ids are checked only
 * when opts.models is given: a list that is not ok reads as "model-unverified", never as
 * "model-unknown" (C18). Never throws: if the check cannot finish, the result is one error
 * finding saying so, never an empty or partial list that could read as all clear (C26).
 */
export function lintWorkload(w: Workload, opts: { models?: ModelList; configs?: RunConfig[] } = {}): LintFinding[] {
  try {
    return runChecks(w, opts ?? {});
  } catch (err) {
    // The finding id is the data rule on purpose: a check that did not run must never look like that problem is gone.
    return [
      {
        id: "data-in-system-prompt",
        severity: "error",
        title: "The setup check could not run",
        detail: DETAIL.couldNotRun,
        evidence: err instanceof LintInputError ? err.message : null,
        fixable: false,
        spans: [],
      },
    ];
  }
}
