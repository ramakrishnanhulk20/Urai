import { neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { CONFIG } from "./config";
import { databaseUrl } from "./env";

/*
 * Every query goes over HTTP through this fetch, so a hung Neon ends in an error the route turns
 * into a denial (C26), instead of holding the request open until the function's time limit, by
 * which point a case claim could already be taken over by another request.
 */
neonConfig.fetchFunction = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const timeout = AbortSignal.timeout(CONFIG.dbQueryTimeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

let client: NeonQueryFunction<false, false> | undefined;

/**
 * The shared Neon client, used only as a tagged template so every value is sent as a query
 * parameter and never spliced into SQL text. Each query is cut off after CONFIG.dbQueryTimeoutMs.
 */
export function db(): NeonQueryFunction<false, false> {
  client ??= neon(databaseUrl());
  return client;
}

/**
 * s with every lone surrogate (half of an emoji, say) replaced by U+FFFD. Postgres jsonb refuses
 * a lone surrogate, so without this a paid answer would fail to store and a retry would pay twice.
 */
export function wellFormed(s: string): string {
  // String.prototype.toWellFormed is ES2024, in Node since 20; the web tsconfig's lib stops at ES2023.
  return (s as unknown as { toWellFormed(): string }).toWellFormed();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * JSON text for a jsonb parameter. Every string and every object key is made well formed first
 * (see wellFormed), so the text never carries a lone surrogate escape that jsonb would refuse at
 * insert. Returns null when any key or string holds a NUL character, which jsonb cannot store
 * either, so it is refused as bad input rather than a server error; callers that must store
 * model output replace NUL themselves first.
 */
export function toJsonb(value: unknown): string | null {
  let hasNul = false;
  const text = JSON.stringify(value, (key, v: unknown) => {
    if (key.includes("\0")) hasNul = true;
    if (typeof v === "string") {
      if (v.includes("\0")) hasNul = true;
      return wellFormed(v);
    }
    if (!isPlainObject(v)) return v;
    // Rebuilt so its keys are well formed too; stringify then walks the rebuilt object, calling back here for each value.
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, wellFormed(k), { value: x, enumerable: true, writable: true, configurable: true });
    }
    return out;
  });
  return hasNul || text === undefined ? null : text;
}
