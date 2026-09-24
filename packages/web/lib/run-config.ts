import { LIMITS, normaliseModelId, type RunConfig } from "@urai/engine";
import { z } from "zod";

// Printable ASCII with no spaces: no control character or NUL can reach a header, a log or Postgres.
const MODEL_ID = new RegExp(`^[\\x21-\\x7E]{1,${LIMITS.modelIdMaxChars}}$`);

/** One run setting as a caller sends it. Unknown keys and unknown modes are refused. */
export const runConfigSchema = z.strictObject({
  model: z.string().max(LIMITS.modelIdMaxChars),
  mode: z.enum(["raw", "plain", "guard", "multipath", "full"]),
  keepContentFilter: z.boolean().optional(),
});

/**
 * The one normaliser for run settings (C24, C32). The model id goes through the engine's
 * normaliseModelId, the same policy the lint, the prices and buildRequest use, so "GPT-6-LUNA"
 * and "gpt-6-luna" are one setting everywhere, including the duplicate check and the demo
 * allowlist. keepContentFilter is fixed to a boolean. In raw mode SERV is off, so the filter flag
 * changes nothing and is forced to false: two spellings of the same request must compare equal.
 * Returns null for a model id that is blank or not printable ASCII.
 */
export function canonicalConfig(c: z.infer<typeof runConfigSchema>): RunConfig | null {
  const model = normaliseModelId(c.model);
  if (!MODEL_ID.test(model)) return null;
  return { model, mode: c.mode, keepContentFilter: c.mode === "raw" ? false : (c.keepContentFilter ?? false) };
}

/** A comparable key for a canonical setting. Only ever called on canonicalConfig output. */
export function configKey(c: RunConfig): string {
  return JSON.stringify([c.model, c.mode, c.keepContentFilter === true]);
}

/**
 * Parses and canonicalises a stored or submitted list of settings. Null when anything in it
 * fails, so a malformed sample allowlist denies every demo run instead of allowing one (C26).
 */
export function canonicalConfigs(value: unknown): RunConfig[] | null {
  const parsed = z.array(runConfigSchema).safeParse(value);
  if (!parsed.success) return null;
  const out: RunConfig[] = [];
  for (const c of parsed.data) {
    const canon = canonicalConfig(c);
    if (canon === null) return null;
    out.push(canon);
  }
  return out;
}
