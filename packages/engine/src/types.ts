export type ServMode = "raw" | "plain" | "guard" | "multipath" | "full";

export interface RunConfig {
  model: string;
  mode: ServMode;
  keepContentFilter?: boolean;
}

export type ExpectedValue = string | number | boolean | null | string[];

export interface ScoreRule {
  field: string;
  rule: "exact" | "number" | "oneOf";
  tolerance?: number;
}

export interface WorkloadCase {
  id: string;
  input: string;
  expected: Record<string, ExpectedValue>;
}

export interface Workload {
  name: string;
  /** The agent's rules. Sent as the system message, byte for byte. */
  systemPrompt: string;
  /** Shared data for every case. Sent inside the user message, because SERV drops data it finds in the system prompt. */
  context: string | null;
  /** JSON Schema object for the agent's answer. */
  answerSchema: Record<string, unknown>;
  /** Used only in mode "full". */
  shadowHint: string | null;
  scoring: ScoreRule[];
  cases: WorkloadCase[];
}

export type ParseResult = { ok: true; workload: Workload } | { ok: false; errors: string[] };

export type CompileResult = { ok: true; validate: (v: unknown) => boolean } | { ok: false; errors: string[] };

export interface FieldScore {
  field: string;
  expected: ExpectedValue;
  got: unknown;
  match: boolean;
}

export interface BuiltRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * scored: a schema-valid answer was scored. failed: the model answered but the answer was empty,
 * not JSON, too large or off-schema. refused: PromptGuard refused before the model ran.
 * filtered: SERV's output filter cut the answer. upstream_error: no usable response.
 * timeout: the upstream timeout fired.
 */
export type CaseStatus = "scored" | "failed" | "refused" | "filtered" | "upstream_error" | "timeout";

export interface CaseResult {
  caseId: string;
  config: RunConfig;
  status: CaseStatus;
  /** Parsed and schema-valid answer, else null. */
  answer: Record<string, unknown> | null;
  /** Raw content or refusal text, capped at LIMITS.answerMaxChars. */
  answerText: string | null;
  fieldScores: FieldScore[];
  correct: boolean;
  /** A count SERV did not report is null, never 0. */
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null };
  latencyMs: number;
  finishReason: string | null;
  servRequestId: string | null;
  httpStatus: number | null;
  /** Short and scrubbed: never contains the API key. */
  error: string | null;
}

export type Balance = { ok: true; usd: number } | { ok: false; reason: "unavailable" | "probe_ran" };

export type ModelList = { ok: true; models: { id: string; inputUsdPerM: number; outputUsdPerM: number }[] } | { ok: false };
