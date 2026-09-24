import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One .env at the repo root serves every package. Only imported by next.config, the scripts and
// the test config; never by route code, where a bundled path would point somewhere else.
const ROOT_ENV = fileURLToPath(new URL("../../../.env", import.meta.url));

/**
 * Loads the repo root .env for local runs. Values already in the environment win, so Vercel's
 * own settings are never overwritten, and on Vercel there is no file to read at all.
 */
export function loadRootEnv(): void {
  if (process.env.VERCEL) return;
  if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
}
