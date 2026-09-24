/**
 * USD per million tokens, SERV included, from docs.openserv.ai/serv-reasoning/models
 * read 2026-09-23. These cover upstream inference only. SERV's separate charges for
 * reasoning-prompt generation, Prompt Guard and Shadow Agent validation are not in
 * the API response and only show in the console Usage page, so serv-mode costs here
 * are a floor, not the bill.
 */
export const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "gpt-6-luna": { input: 0.13, output: 0.65 },
  "gpt-5.4-nano": { input: 0.25, output: 1.6 },
  "gpt-5.4-mini": { input: 1.0, output: 6.0 },
  "claude-haiku-4.5": { input: 1.25, output: 6.5 },
  "claude-sonnet-5": { input: 2.6, output: 13.0 },
  "gpt-5.4": { input: 3.25, output: 20.0 },
};

/** Returns null when the model has no price entry, so a missing price never reads as free. */
export function callCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
