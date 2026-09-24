import type { RunConfig } from "@urai/engine";
import { z } from "zod";
import { CONFIG, OWNER_HEADER } from "./config";
import { db } from "./db";
import { serverEnv } from "./env";
import { isGeneratedId, tokenMatches } from "./ids";
import { canonicalConfigs } from "./run-config";

/** A refusal with a fixed code. The code is the only thing the caller ever sees. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const BASE_HEADERS = { "cache-control": "no-store" } as const;

/**
 * A JSON response with Cache-Control: no-store. No Access-Control-Allow-* header is ever set,
 * so browsers keep the default same-origin policy (C22).
 */
export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: BASE_HEADERS });
}

/** The one error shape: { error: code }. No stack, no message, no part of the input. */
export function errorResponse(status: number, code: string): Response {
  return json(status, { error: code });
}

async function readCappedBody(req: Request): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > CONFIG.bodyMaxBytes) throw new HttpError(413, "body_too_large");
  if (req.body === null) return new Uint8Array();

  // Content-Length can be absent or wrong, so the stream is counted too and cut at the cap.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CONFIG.bodyMaxBytes) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Reads the body under CONFIG.bodyMaxBytes (413 over it, C14), requires a JSON content type
 * (415 otherwise, so a cross-site form post cannot reach the handler without a preflight),
 * decodes strict UTF-8 and parses JSON (400 invalid_json), then validates with schema
 * (400 invalid_body). Nothing is parsed until the whole body is known to be under the cap.
 */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "unsupported_media_type");
  const bytes = await readCappedBody(req);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "invalid_body");
  return parsed.data;
}

/**
 * Runs a route body. Validates the environment first, so a missing variable denies every request
 * instead of half-working (C26). An HttpError becomes its own status and code; anything else is
 * logged by class and Postgres code only (never a message, which can quote user data) and
 * returned as 500 internal.
 */
export async function handle(route: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    serverEnv();
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.code);
    const name = err instanceof Error ? err.name : typeof err;
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code).slice(0, 16) : "";
    console.error(`[urai] ${route} failed: ${name} ${code}`.trim());
    return errorResponse(500, "internal");
  }
}

/** A custom header, so a cross-site page cannot send it without a CORS preflight we refuse (C22). */
export const SERV_KEY_HEADER = "x-serv-key";

/**
 * The team's SERV key exactly as sent, or null when the header is missing, empty or only
 * whitespace, which all count as absent (C3). The caller uses it for one upstream call and
 * never stores, logs or returns it (C1).
 */
export function teamKeyHeader(req: Request): string | null {
  const value = req.headers.get(SERV_KEY_HEADER);
  return value === null || value.trim() === "" ? null : value;
}

/** A run as the case, balance, share and report handlers use it. Never sent to a caller as is. */
export interface RunRecord {
  id: string;
  workloadId: string;
  reportId: string;
  payer: "team" | "demo";
  configs: RunConfig[];
  /** Null for runs created before case ids were stored; such runs can call no case (C10). */
  caseIds: string[] | null;
  flagged: string | null;
  isSample: boolean;
  workloadLive: boolean;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

const storedNumber = z
  .union([z.string(), z.number()])
  .nullable()
  .transform((v, ctx) => {
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: "not a finite number" });
      return z.NEVER;
    }
    return n;
  });

const runRowSchema = z.object({
  id: z.string(),
  workload_id: z.string(),
  report_id: z.string(),
  owner_hash: z.string(),
  payer: z.enum(["team", "demo"]),
  configs: z.unknown(),
  case_ids: z.array(z.string()).max(CONFIG.casesPerWorkloadMax).nullable(),
  flagged: z.string().nullable(),
  is_sample: z.boolean(),
  workload_live: z.boolean(),
  balance_before: storedNumber,
  balance_after: storedNumber,
});

/* A stored row that fails any check throws, and handle() turns that into 500: an unknown payer or
 * a malformed settings list never falls through to a default (C26). */
function toRunRecord(row: unknown): RunRecord & { ownerHash: string } {
  const r = runRowSchema.parse(row);
  const configs = canonicalConfigs(r.configs);
  if (configs === null || configs.length === 0) throw new Error("stored run configs failed validation");
  return {
    id: r.id,
    workloadId: r.workload_id,
    reportId: r.report_id,
    ownerHash: r.owner_hash,
    payer: r.payer,
    configs,
    caseIds: r.case_ids,
    flagged: r.flagged,
    isSample: r.is_sample,
    workloadLive: r.workload_live,
    balanceBefore: r.balance_before,
    balanceAfter: r.balance_after,
  };
}

/**
 * Loads a run for its owner (C10, C11). Throws 404 not_found, the same answer every time, for an
 * id that newId() could not have produced, an unknown run, and a missing or wrong x-urai-owner
 * token, so a stranger cannot even learn that the run exists.
 */
export async function requireOwnedRun(req: Request, id: string, route: string): Promise<RunRecord> {
  if (!isGeneratedId(id)) throw new HttpError(404, "not_found");
  const rows = await db()`
    SELECT r.id, r.workload_id, r.report_id, r.owner_hash, r.payer, r.configs, r.case_ids, r.flagged,
           r.balance_before, r.balance_after, w.is_sample, w.expires_at > now() AS workload_live
    FROM runs r JOIN workloads w ON w.id = r.workload_id
    WHERE r.id = ${id}`;
  if (rows[0] === undefined) throw new HttpError(404, "not_found");
  const { ownerHash, ...run } = toRunRecord(rows[0]);
  if (!tokenMatches(req.headers.get(OWNER_HEADER), ownerHash)) {
    console.warn(`[urai] ${route}: run owner token missing or wrong`);
    throw new HttpError(404, "not_found");
  }
  return run;
}

/** Loads a run by its report id, only when the owner has shared it (C9). Anything else is 404. */
export async function requireSharedRun(reportId: string): Promise<RunRecord> {
  if (!isGeneratedId(reportId)) throw new HttpError(404, "not_found");
  const rows = await db()`
    SELECT r.id, r.workload_id, r.report_id, r.owner_hash, r.payer, r.configs, r.case_ids, r.flagged,
           r.balance_before, r.balance_after, w.is_sample, w.expires_at > now() AS workload_live
    FROM runs r JOIN workloads w ON w.id = r.workload_id
    WHERE r.report_id = ${reportId} AND r.shared = true`;
  if (rows[0] === undefined) throw new HttpError(404, "not_found");
  const { ownerHash: _ownerHash, ...run } = toRunRecord(rows[0]);
  return run;
}
