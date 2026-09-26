import type { RunConfig, ScoreRule, ServMode, Workload, WorkloadCase } from "@urai/engine";
import type { ModelEntry } from "./api";
import { jsonErrorAt } from "./json-error";

/** The engine caps the form needs, handed down from the server page so the engine never ships to the browser. */
export interface FormLimits {
  nameMaxChars: number;
  systemPromptMaxChars: number;
  contextMaxChars: number;
  caseInputMaxChars: number;
  casesMax: number;
  caseIdMaxChars: number;
  scoringRulesMax: number;
  configsPerRunMax: number;
  keyMinChars: number;
  keyMaxChars: number;
  bodyMaxBytes: number;
}

export interface SampleEntry {
  slug: "bad" | "good" | "hard";
  title: string;
  line: string;
  workload: Workload;
}

export interface ScoreRow {
  key: number;
  field: string;
  rule: ScoreRule["rule"];
  /** Kept as typed, so a half-written number is not rewritten under the cursor. */
  tolerance: string;
}

export interface Draft {
  name: string;
  systemPrompt: string;
  context: string;
  schemaText: string;
  scoring: ScoreRow[];
  casesText: string;
  /** Only the samples carry one; the form has no field for it, so a hand-written agent sends null. */
  shadowHint: string | null;
}

export const EMPTY_DRAFT: Draft = {
  name: "",
  systemPrompt: "",
  context: "",
  schemaText: "",
  scoring: [],
  casesText: "",
  shadowHint: null,
};

export const MODES: { mode: ServMode; label: string; line: string }[] = [
  { mode: "raw", label: "SERV off", line: "The model on its own, with SERV's reasoning switched off. The baseline." },
  { mode: "plain", label: "SERV plain", line: "SERV's reasoning on, with its output filter off (Urai always switches it off so answers that quote the rules are not cut), nothing else added." },
  { mode: "guard", label: "SERV with PromptGuard", line: "SERV plus PromptGuard, which can refuse an input before the model runs." },
  {
    mode: "multipath",
    label: "SERV Multipath",
    line: "SERV rewrites your system prompt with a separate reasoning pass built for prompts with many branches, exceptions or competing rules.",
  },
  {
    mode: "full",
    label: "SERV full",
    line: "Multipath and PromptGuard, plus Shadow Agent, which checks each answer and asks the model to revise it, up to 3 rounds.",
  },
];

let rowKey = 0;
export function nextRowKey(): number {
  rowKey += 1;
  return rowKey;
}

export function draftFromWorkload(w: Workload): Draft {
  return {
    name: w.name,
    systemPrompt: w.systemPrompt,
    context: w.context ?? "",
    schemaText: JSON.stringify(w.answerSchema, null, 2),
    scoring: w.scoring.map((r) => ({
      key: nextRowKey(),
      field: r.field,
      rule: r.rule,
      tolerance: r.tolerance === undefined ? "" : String(r.tolerance),
    })),
    casesText: JSON.stringify(w.cases, null, 2),
    shadowHint: w.shadowHint,
  };
}

export type SchemaRead =
  | { ok: true; schema: Record<string, unknown>; fields: string[] }
  | { ok: false; empty: boolean; message: string };

/** Live feedback on the answer schema. The engine does the full keyword check; this catches what can be seen while typing. */
export function readSchema(text: string): SchemaRead {
  if (text.trim() === "") return { ok: false, empty: true, message: "Paste the JSON Schema your agent answers in." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, empty: false, message: `Not valid JSON: ${jsonErrorAt(text, err)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, empty: false, message: "The schema must be a JSON object, starting with {." };
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object") return { ok: false, empty: false, message: 'The top level needs "type": "object".' };
  const props = schema.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props) || Object.keys(props).length === 0) {
    return { ok: false, empty: false, message: 'Add a "properties" object with the fields your agent answers with.' };
  }
  return { ok: true, schema, fields: Object.keys(props) };
}

export function scoreRules(rows: ScoreRow[]): ScoreRule[] {
  return rows.map((r) => {
    const tol = r.tolerance.trim();
    return r.rule === "number" && tol !== "" && Number.isFinite(Number(tol))
      ? { field: r.field, rule: r.rule, tolerance: Number(tol) }
      : { field: r.field, rule: r.rule };
  });
}

/** What still stands between the draft and a test set the server will take, in the order the page asks for it. */
export function draftProblems(d: Draft, schema: SchemaRead, cases: { cases: WorkloadCase[]; problems: unknown[] }, limits: FormLimits): string[] {
  const out: string[] = [];
  if (d.name.trim() === "") out.push("Give your agent a name.");
  else if (d.name.length > limits.nameMaxChars) out.push(`Shorten the name to ${limits.nameMaxChars} characters.`);
  if (d.systemPrompt.trim() === "") out.push("Paste your agent's system prompt.");
  else if (d.systemPrompt.length > limits.systemPromptMaxChars) out.push(`Shorten the system prompt to ${limits.systemPromptMaxChars.toLocaleString("en-US")} characters.`);
  if (d.context.length > limits.contextMaxChars) out.push(`Shorten the shared data to ${limits.contextMaxChars.toLocaleString("en-US")} characters.`);
  if (!schema.ok) out.push("Fix the answer schema.");
  if (d.scoring.length === 0) out.push("Add at least one scoring rule.");
  else if (d.scoring.some((r) => r.field === "")) out.push("Pick a field for every scoring rule.");
  else if (new Set(d.scoring.map((r) => r.field)).size !== d.scoring.length) out.push("Score each field once.");
  else if (d.scoring.some((r) => r.rule === "number" && r.tolerance.trim() !== "" && !(Number(r.tolerance) >= 0))) {
    out.push("Set each tolerance to a number of 0 or more.");
  }
  if (cases.cases.length === 0 && cases.problems.length === 0) out.push("Add your test cases.");
  else if (cases.problems.length > 0) out.push("Fix the problems in your test cases.");
  return out;
}

export function buildWorkload(d: Draft, schema: SchemaRead, cases: WorkloadCase[]): Workload | null {
  if (!schema.ok) return null;
  return {
    name: d.name.trim(),
    systemPrompt: d.systemPrompt,
    context: d.context.trim() === "" ? null : d.context,
    answerSchema: schema.schema,
    shadowHint: d.shadowHint,
    scoring: scoreRules(d.scoring),
    cases,
  };
}

/** The optional second model a team compares against, with the one SERV setting it runs under. An empty model means none. */
export interface Compare {
  model: string;
  mode: ServMode;
}

export const EMPTY_COMPARE: Compare = { model: "", mode: "raw" };

// The server trims and lowercases model ids (C24), so the form compares them the same way.
function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function modeLabel(mode: ServMode): string {
  return MODES.find((m) => m.mode === mode)?.label ?? mode;
}

/** How many SERV settings the first model may take: the run cap, less the one the second model uses. */
export function mainModesMax(compare: Compare, limits: FormLimits): number {
  return Math.min(MODES.length, limits.configsPerRunMax - (compare.model.trim() === "" ? 0 : 1));
}

/**
 * Why the second model cannot join the run as it stands, in plain words, or null when it can (or
 * when there is none). The server refuses a repeated setting and a run over the cap, so both are
 * caught here first and explained.
 */
export function compareProblem(model: string, modes: ServMode[], compare: Compare, limits: FormLimits): string | null {
  if (compare.model.trim() === "") return null;
  if (sameModel(model, compare.model) && modes.includes(compare.mode)) {
    return `${compare.model.trim()} with ${modeLabel(compare.mode)} is already in the run above. Pick another model to compare with, or another setting for it.`;
  }
  if (modes.length + 1 > limits.configsPerRunMax) {
    return `A run takes at most ${limits.configsPerRunMax} settings. Untick one above to make room for the second model.`;
  }
  return null;
}

/** The run's settings: every ticked mode on the first model, then the second model's one setting when it can join. */
export function buildConfigs(model: string, modes: ServMode[], compare: Compare, limits: FormLimits): RunConfig[] {
  const id = model.trim();
  if (id === "") return [];
  const main: RunConfig[] = MODES.filter((m) => modes.includes(m.mode)).map((m) => ({ model: id, mode: m.mode }));
  const second = compare.model.trim();
  if (second === "") return main;
  const repeated = main.some((c) => sameModel(c.model, second) && c.mode === compare.mode);
  return repeated || main.length + 1 > limits.configsPerRunMax ? main : [...main, { model: second, mode: compare.mode }];
}

/** Bytes of the request body POST /api/workloads will receive, measured the way the server counts them. */
export function bodyBytes(w: Workload): number {
  return new TextEncoder().encode(JSON.stringify({ workload: w })).byteLength;
}

// About four characters to a token for English and JSON. A rough rule, which is why the total is labelled an estimate.
const CHARS_PER_TOKEN = 4;
// The mean answer across the 1,944 bench calls in packages/bench/results was 473 output tokens.
export const OUTPUT_TOKENS_GUESS = 475;

export interface Estimate {
  calls: number;
  /** The priced settings only. Null when one of them has no listed price, or when none can be priced. */
  usd: number | null;
  inputTokensPerCall: number;
  /** Multipath and full settings, left out of usd: their extra SERV passes cost more than tokens show. */
  leftOut: number;
}

/**
 * Model token cost only, from SERV's listed prices: every case's system prompt, shared data,
 * input and answer schema as input, and OUTPUT_TOKENS_GUESS as output, each setting priced at its
 * own model. Multipath and full settings are left out and counted in leftOut, the same settings the
 * report never prices (lib/prices.ts). SERV's reasoning graph on first sight is not included and is
 * named on the page. usd is null when any priced setting's model has no listed price, because a
 * partial sum would read as the whole run.
 */
export function estimate(w: Workload | null, configs: RunConfig[], prices: readonly ModelEntry[] | null): Estimate | null {
  if (w === null || configs.length === 0) return null;
  const schemaChars = JSON.stringify(w.answerSchema).length;
  let inputChars = 0;
  for (const c of w.cases) {
    const user = w.context !== null ? JSON.stringify({ context: w.context, input: c.input }) : JSON.stringify({ input: c.input });
    inputChars += w.systemPrompt.length + user.length + schemaChars;
  }
  const inputTokens = inputChars / CHARS_PER_TOKEN;
  const calls = w.cases.length * configs.length;
  const priced = configs.filter((c) => c.mode !== "multipath" && c.mode !== "full");
  let sum = 0;
  let missing = priced.length === 0;
  for (const cfg of priced) {
    const price = prices?.find((m) => sameModel(m.id, cfg.model));
    if (price === undefined) {
      missing = true;
      break;
    }
    sum += (inputTokens * price.inputUsdPerM) / 1e6 + (w.cases.length * OUTPUT_TOKENS_GUESS * price.outputUsdPerM) / 1e6;
  }
  const usd = missing ? null : sum;
  return { calls, usd, inputTokensPerCall: Math.round(inputTokens / Math.max(1, w.cases.length)), leftOut: configs.length - priced.length };
}

/** Printable ASCII with no spaces, the same shape the server checks before a key goes near a header. */
export function keyShapeOk(key: string, limits: FormLimits): boolean {
  const k = key.trim();
  return k.length >= limits.keyMinChars && k.length <= limits.keyMaxChars && /^[\x21-\x7E]+$/.test(k);
}
