import { isPlausibleKey } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "./config";

const databaseUrlSchema = z.string().regex(/^postgres(ql)?:\/\/\S+$/);

const serverSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  SERV_API_KEY: z.string().refine(isPlausibleKey),
  URAI_IP_SALT: z.string().regex(/^[0-9a-fA-F]{64}$/),
  // numeric(10,4) in demo_budget holds at most 999,999.9999.
  DEMO_DAILY_BUDGET_USD: z.coerce.number().finite().positive().lt(1_000_000),
});

export interface ServerEnv {
  databaseUrl: string;
  ipSalt: string;
  demoDailyBudgetUsd: number;
}

/*
 * Messages name the variable and never its value. zod's own issue text is not used because
 * some issue kinds quote the input.
 */
function envError(names: string[]): Error {
  return new Error(`Environment variable missing or invalid: ${[...new Set(names)].sort().join(", ")}`);
}

let cached: { env: ServerEnv; operatorKey: string } | undefined;

function load(): { env: ServerEnv; operatorKey: string } {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) throw envError(parsed.error.issues.map((i) => String(i.path[0] ?? "unknown")));
  cached = {
    env: {
      databaseUrl: parsed.data.DATABASE_URL,
      ipSalt: parsed.data.URAI_IP_SALT,
      demoDailyBudgetUsd: parsed.data.DEMO_DAILY_BUDGET_USD,
    },
    operatorKey: parsed.data.SERV_API_KEY,
  };
  return cached;
}

/**
 * Validates every server variable on first use and returns the ones any handler may read.
 * Throws an error naming each missing or invalid variable. Called at server boot from
 * instrumentation.ts and again by every route through handle() in lib/http.ts.
 */
export function serverEnv(): ServerEnv {
  return load().env;
}

/**
 * The operator's SERV key. Only the demo case handler and the model list refresh in
 * lib/models.ts may call this (C26), which is why it is not part of serverEnv(). The model list
 * call sends the key and nothing else, so no user text travels with it (C4).
 */
export function operatorServKey(): string {
  return load().operatorKey;
}

// Printable ASCII without spaces, so the value survives an HTTP header byte for byte.
const cronSecretSchema = z.string().regex(new RegExp(`^[\\x21-\\x7E]{${CONFIG.cronSecretMinChars},512}$`));

/**
 * CRON_SECRET, the value Vercel sends as "Authorization: Bearer <secret>" to cron routes, or null
 * when it is missing or shorter than CONFIG.cronSecretMinChars. Kept out of serverEnv() so a
 * missing secret refuses only the cron route (always 401, C26) instead of every route. Read on
 * every call, not cached, so a rotated secret takes effect without a restart.
 */
export function cronSecret(): string | null {
  const parsed = cronSecretSchema.safeParse(process.env.CRON_SECRET);
  return parsed.success ? parsed.data : null;
}

/** DATABASE_URL alone, for the migrate and seed scripts, which never need the other variables. */
export function databaseUrl(): string {
  const parsed = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!parsed.success) throw envError(["DATABASE_URL"]);
  return parsed.data;
}
