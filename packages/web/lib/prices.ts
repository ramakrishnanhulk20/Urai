import { normaliseModelId, type RunConfig } from "@urai/engine";
import { CONFIG } from "./config";
import { type ModelEntry, readCachedModels } from "./models";

type Price = { inputUsdPerM: number; outputUsdPerM: number };
type Usage = { inputTokens: number | null; outputTokens: number | null };

/*
 * USD per million tokens with SERV included, from docs.openserv.ai/serv-reasoning/models as read
 * on 23 Sep 2026. Only the models the samples allow are listed. A Map, so an id like
 * "constructor" can never hit a prototype key.
 */
const PRICES = new Map<string, Price>([["gpt-6-luna", { inputUsdPerM: 0.13, outputUsdPerM: 0.65 }]]);

const PER_MILLION = 1_000_000;

function costAt(price: Price, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputUsdPerM + outputTokens * price.outputUsdPerM) / PER_MILLION;
}

/**
 * The cost of one call from the token counts SERV reported: the higher of the configured table
 * price and the live price in `live` (SERV's cached model list) for that model (C28), so a price
 * rise on SERV's side is never settled at the old figure. Null when it cannot be known: a null
 * count, a model in neither list, or a multipath or full call (billed under a different model id
 * with extra parts); the caller then settles the full estimate. Every model id on both sides goes
 * through the engine's normaliseModelId (C32).
 */
export function callCostUsd(cfg: RunConfig, usage: Usage, live: readonly ModelEntry[] | null = null): number | null {
  if (cfg.mode === "multipath" || cfg.mode === "full") return null;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === null || outputTokens === null) return null;
  const id = normaliseModelId(cfg.model);
  const table = PRICES.get(id);
  const listed = live?.find((m) => normaliseModelId(m.id) === id);
  const costs = [table, listed].filter((p): p is Price => p !== undefined).map((p) => costAt(p, inputTokens, outputTokens));
  return costs.length === 0 ? null : Math.max(...costs);
}

/**
 * callCostUsd with the live price read from the model cache in the database. No network call is
 * made from here. When the cache cannot be read, the table price alone is used and the gap is
 * logged. This settled cost is the demo's money limit (C28): demo runs only use pre-warmed sample
 * prompts on the allowlisted model, so SERV's one-off graph build, which token counts cannot see,
 * never happens on them.
 */
export async function settledCostUsd(cfg: RunConfig, usage: Usage): Promise<number | null> {
  return callCostUsd(cfg, usage, await readLivePrices());
}

/**
 * SERV's live prices from the model cache in the database, or null when the cache cannot be read
 * (the gap is logged and callers fall back to the table price). No network call is made. A demo
 * call reads this once and passes the same list to demoReservationUsd and callCostUsd, so its
 * reservation and its settle are priced alike even if the cache is refreshed mid-call (C28).
 */
export async function readLivePrices(): Promise<ModelEntry[] | null> {
  try {
    return await readCachedModels();
  } catch {
    console.warn("[urai] model cache unreadable while pricing a call; using the table price only");
    return null;
  }
}

/**
 * What one demo call reserves from the day's budget before it runs (C6, C28): the larger of
 * CONFIG.demoCallEstimateUsd and the cost of CONFIG.demoMaxCompletionTokens output tokens at the
 * higher of the table and live price, so a live price rise can never let a call that hits its
 * output cap settle above what it reserved. live is the list from readLivePrices, the same one
 * the call's settle uses. Input tokens are not in the ceiling: the sample prompts are fixed by the
 * operator and cost far less than the estimate. A setting with no known price (multipath, full,
 * an unlisted model) reserves the estimate.
 */
export function demoReservationUsd(cfg: RunConfig, live: readonly ModelEntry[] | null): number {
  const cap = callCostUsd(cfg, { inputTokens: 0, outputTokens: CONFIG.demoMaxCompletionTokens }, live);
  return Math.max(CONFIG.demoCallEstimateUsd, cap ?? 0);
}
