import { z } from "zod";
import { LIMITS } from "./limits.js";
import { isPlausibleKey } from "./scrub.js";
import { readCapped, sendWithConnectRetry } from "./serv.js";
import type { ModelList } from "./types.js";

/** Same host as SERV_CHAT_URL (C2). Not configurable on purpose. */
export const SERV_MODELS_URL = "https://inference-api.openserv.ai/v1/models" as const;

const MODEL_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${LIMITS.modelIdMaxChars - 1}}$`);

// SERV prices in US cents per million tokens (claude-fable-5 input 1300 is 13.00 USD).
const centsPerM = z.number().nonnegative().finite();

const LIST_SHAPE = z.object({
  items: z
    .array(z.object({ modelId: z.string().regex(MODEL_ID), pricing: z.object({ input: centsPerM, output: centsPerM }) }))
    .min(1)
    .max(LIMITS.modelsMax),
});

/**
 * Lists SERV's live models with prices in USD per million tokens.
 * Returns { ok:false } with no network call when the key fails isPlausibleKey, and on any
 * non-200, timeout, network failure, oversized body, empty list, more than LIMITS.modelsMax
 * models, or any item that is not the expected shape. A failed list must read as "could not
 * verify" to its caller, never as "unknown model" (C18). Never throws.
 */
export async function listModels(apiKey: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<ModelList> {
  if (!isPlausibleKey(apiKey)) return { ok: false };
  const timeoutSignal = AbortSignal.timeout(LIMITS.modelsTimeoutMs);
  const sent = await sendWithConnectRetry(
    opts.fetchImpl ?? fetch,
    SERV_MODELS_URL,
    { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
    timeoutSignal,
    timeoutSignal,
  );
  if (!sent.ok) return { ok: false };
  if (sent.res.status !== 200) {
    await sent.res.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  const body = await readCapped(sent.res, LIMITS.modelsResponseMaxBytes);
  if (!body.ok) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return { ok: false };
  }
  // Counted before zod walks the array, so an oversized list is refused without processing it (C14).
  const items = typeof json === "object" && json !== null ? (json as { items?: unknown }).items : undefined;
  if (Array.isArray(items) && items.length > LIMITS.modelsMax) return { ok: false };
  const shaped = LIST_SHAPE.safeParse(json);
  if (!shaped.success) return { ok: false };
  return {
    ok: true,
    models: shaped.data.items.map((m) => ({ id: m.modelId, inputUsdPerM: m.pricing.input / 100, outputUsdPerM: m.pricing.output / 100 })),
  };
}
