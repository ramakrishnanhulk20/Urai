import { normaliseModelId, type RunConfig } from "@urai/engine";
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
 * logged; the operator balance check (C28) still catches real spend the table misses.
 */
export async function settledCostUsd(cfg: RunConfig, usage: Usage): Promise<number | null> {
  let live: ModelEntry[] | null;
  try {
    live = await readCachedModels();
  } catch {
    console.warn("[urai] model cache unreadable while pricing a call; using the table price only");
    live = null;
  }
  return callCostUsd(cfg, usage, live);
}
