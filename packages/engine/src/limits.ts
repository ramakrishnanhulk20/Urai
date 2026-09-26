/**
 * Every size, count and time cap in the engine. Nothing else in the codebase may
 * hardcode one of these numbers. Character counts are JavaScript string lengths
 * (UTF-16 code units), which is never smaller than the count a person would see.
 */
export const LIMITS = {
  nameMinChars: 1,
  nameMaxChars: 120,
  systemPromptMaxChars: 60_000,
  contextMaxChars: 60_000,
  caseInputMaxChars: 30_000,
  casesMin: 1,
  casesMax: 100,
  caseIdMinChars: 1,
  caseIdMaxChars: 64,
  scoringRulesMin: 1,
  scoringRulesMax: 20,
  schemaMaxBytes: 20_000,
  schemaMaxDepth: 6,
  answerMaxChars: 20_000,
  // Must stay below the web app's function time limit so a slow upstream call ends inside our handler (C14).
  upstreamTimeoutMs: 120_000,
  responseMaxBytes: 1_000_000,
  configsPerRunMax: 6,
  shadowHintMaxChars: 2_000,
  expectedStringMaxChars: 2_000,
  oneOfOptionsMax: 50,
  // Upstream error text is untrusted and may quote the team's prompt, so only a short piece of it is kept.
  errorMaxChars: 200,
  // Connect failures only: nothing was sent, so a retry cannot double-bill (C5). Delays double from the base: 1, 2, 4 s.
  connectRetriesMax: 3,
  connectRetryBaseMs: 1_000,
  keyMinChars: 20,
  keyMaxChars: 200,
  finishReasonMaxChars: 64,
  requestIdMaxChars: 128,
  modelsTimeoutMs: 15_000,
  modelsResponseMaxBytes: 500_000,
  modelsMax: 500,
  modelIdMaxChars: 128,
  // The lint runs only on a system prompt at or under systemPromptMaxChars (C13). This budget caps the
  // total characters handed to JSON.parse in one check, because nested bracket spans that fail to parse
  // would otherwise be parsed again at every level, which is quadratic. Four passes over the largest prompt.
  lintJsonParseBudgetChars: 240_000,
  lintHeadingMaxChars: 200,
  lintEvidenceMaxChars: 200,
  lintSpansMax: 50,
} as const satisfies { readonly [k: string]: number };
