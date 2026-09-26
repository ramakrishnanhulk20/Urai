import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { RunConfig } from "@urai/engine";
import { OWNER_HEADER } from "../../lib/config";
import { SERV_KEY_HEADER } from "../../lib/http";
import { ipHash } from "../../lib/ip";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Names only: the values are read into memory for the database helper and redaction, never printed.
const SECRET_VARS = ["DATABASE_URL", "SERV_API_KEY", "CRON_SECRET", "URAI_IP_SALT"] as const;
let secrets: string[] = [];

/** Loads the repo root .env read-only. Throws naming DATABASE_URL, never its value, when it is missing. */
export function loadEnv(): string {
  process.loadEnvFile(`${REPO_ROOT}.env`);
  secrets = SECRET_VARS.map((k) => process.env[k] ?? "").filter((v) => v.length >= 8);
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("DATABASE_URL is missing from the root .env");
  return url;
}

/** Every printed or written string passes through here, so an .env value can never reach the console or the run record. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

export type Sql = NeonQueryFunction<false, false>;

export function database(url: string): Sql {
  return neon(url);
}

export type Group = "keys" | "access" | "input" | "surface" | "budget";

/*
 * The server buckets rate limits by x-real-ip. Each group gets its own address from the
 * 203.0.113.0/24 documentation range, which no real client can have, so groups never share a
 * bucket with each other or with anyone else.
 */
const GROUP_IP: Record<Exclude<Group, FreshGroup>, string> = {
  access: "203.0.113.22",
  input: "203.0.113.23",
  surface: "203.0.113.24",
};

/*
 * Two groups spend hourly per-address budgets that a clean-up cannot give back in the same hour:
 * the keys group makes SERV refuse keys (C33), and the budget group makes demo calls (72 an hour
 * per address). A fixed address would carry one run's count into the next run in the same hour,
 * so a few runs in a row would be refused for the wrong reason. Each run gives them a fresh /64
 * from the 2001:db8::/32 documentation range instead; the server buckets IPv6 by /64.
 */
type FreshGroup = "keys" | "budget";

function freshGroupIp(): string {
  const [a, b] = randomBytes(4).toString("hex").match(/.{4}/g) ?? [];
  return `2001:db8:${a}:${b}::21`;
}

export const RATE_KINDS = ["workloads", "runs", "lint", "report", "key_refusals", "demo_calls", "models", "serv_unavailable"] as const;

/** The rate-limit bucket names the server writes for one client address, from the server's own ipHash. */
export function bucketsFor(ip: string): string[] {
  const hash = ipHash(new Request("http://localhost/", { headers: { "x-real-ip": ip } }));
  return RATE_KINDS.map((k) => `${k}:${hash}`);
}

/** Every row the suite makes, so the clean-up deletes exactly those and nothing else. */
export interface Created {
  workloads: Set<string>;
  runs: Set<string>;
  ips: Set<string>;
}

export interface Reply {
  status: number;
  code: string | null;
  body: unknown;
  text: string;
  headers: Headers;
  ms: number;
}

export interface SendOpts {
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  timeoutMs?: number;
}

export interface WorkloadMade {
  workloadId: string;
  ownerToken: string;
}

export interface RunMade {
  runId: string;
  reportId: string;
  ownerToken: string;
  cases: string[];
}

// A case call may wait out the engine's 120 s upstream timeout plus the connect retries.
export const CASE_TIMEOUT_MS = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const LUNA_RAW: RunConfig = { model: "gpt-6-luna", mode: "raw" };
export const SAMPLE_GOOD = "sample-invoices-good";
export const SAMPLE_BAD = "sample-invoices-bad";

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** One client address talking to the server. Keeps every reply's headers and body text for the key scan (C1). */
export class Client {
  readonly transcript: string[] = [];

  constructor(
    readonly base: string,
    readonly ip: string,
    private readonly created: Created,
  ) {}

  async send(method: string, path: string, opts: SendOpts = {}): Promise<Reply> {
    const headers: Record<string, string> = { "x-real-ip": this.ip, ...opts.headers };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = opts.body;
    }
    const started = performance.now();
    const res = await fetch(new URL(path, this.base), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    // A 200 case result carries its own "error" field (SERV's words); only a refusal's error is a server code.
    const code = res.status >= 400 ? record(parsed).error : undefined;
    this.transcript.push(`${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${text}`);
    return { status: res.status, code: typeof code === "string" ? code : null, body: parsed, text, headers: res.headers, ms };
  }

  /** POST /api/workloads. Throws unless 201, because every later check depends on it. */
  async createWorkload(workload: unknown): Promise<WorkloadMade> {
    const r = await this.send("POST", "/api/workloads", { json: { workload } });
    const b = record(r.body);
    if (r.status !== 201 || typeof b.workloadId !== "string" || typeof b.ownerToken !== "string") {
      throw new Error(`setup: creating a workload returned ${brief(r)}`);
    }
    this.created.workloads.add(b.workloadId);
    return { workloadId: b.workloadId, ownerToken: b.ownerToken };
  }

  /** POST /api/runs, returning the raw reply. A 201 is tracked for clean-up. */
  async tryRun(body: { workloadId: string; configs: RunConfig[]; payer: "team" | "demo" }, workloadOwner?: string): Promise<Reply> {
    const r = await this.send("POST", "/api/runs", { json: body, headers: workloadOwner === undefined ? {} : { [OWNER_HEADER]: workloadOwner } });
    const runId = record(r.body).runId;
    if (r.status === 201 && typeof runId === "string") this.created.runs.add(runId);
    return r;
  }

  /** POST /api/runs. Throws unless 201. */
  async createRun(body: { workloadId: string; configs: RunConfig[]; payer: "team" | "demo" }, workloadOwner?: string): Promise<RunMade> {
    const r = await this.tryRun(body, workloadOwner);
    const b = record(r.body);
    const cases = b.cases;
    if (
      r.status !== 201 ||
      typeof b.runId !== "string" ||
      typeof b.reportId !== "string" ||
      typeof b.ownerToken !== "string" ||
      !Array.isArray(cases) ||
      !cases.every((c): c is string => typeof c === "string")
    ) {
      throw new Error(`setup: creating a ${body.payer} run returned ${brief(r)}`);
    }
    return { runId: b.runId, reportId: b.reportId, ownerToken: b.ownerToken, cases };
  }

  /** POST /api/runs/:id/cases/:caseId?config=<raw>. The config value is sent exactly as given. */
  caseCall(runId: string, caseId: string, config: string, headers: Record<string, string>, extraQuery = ""): Promise<Reply> {
    const path = `/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}?config=${encodeURIComponent(config)}${extraQuery}`;
    return this.send("POST", path, { headers, timeoutMs: CASE_TIMEOUT_MS });
  }
}

export function ownerHeaders(ownerToken: string, servKey?: string): Record<string, string> {
  return servKey === undefined ? { [OWNER_HEADER]: ownerToken } : { [OWNER_HEADER]: ownerToken, [SERV_KEY_HEADER]: servKey };
}

export { OWNER_HEADER, SERV_KEY_HEADER };

/** Status and error code, the only parts of a refusal the record keeps. */
export function brief(r: Reply): string {
  return r.code === null ? String(r.status) : `${r.status} ${r.code}`;
}

export function field(v: unknown, key: string): unknown {
  return record(v)[key];
}

export type Outcome = "OK" | "BROKEN" | "PENDING";

export interface CheckRecord {
  group: string;
  rule: string;
  check: string;
  sent: string;
  got: string;
  outcome: Outcome;
}

export class Recorder {
  readonly records: CheckRecord[] = [];
  group = "";

  /** ok true is OK (the app refused or behaved as the rule says), false is BROKEN, "PENDING" is checked elsewhere later. */
  add(rule: string, check: string, sent: string, got: string, ok: boolean | "PENDING"): void {
    const outcome: Outcome = ok === "PENDING" ? "PENDING" : ok ? "OK" : "BROKEN";
    const r = { group: this.group, rule, check: redact(check), sent: redact(sent), got: redact(got), outcome };
    this.records.push(r);
    console.log(`${outcome.padEnd(7)} ${rule.padEnd(4)} ${r.check}: ${r.got}`);
  }
}

export interface Ctx {
  base: string;
  sql: Sql;
  rec: Recorder;
  created: Created;
  serverLog: string | null;
  client(group: Group): Client;
}

export function makeCtx(base: string, sql: Sql, serverLog: string | null): Ctx {
  const created: Created = { workloads: new Set(), runs: new Set(), ips: new Set() };
  const clients = new Map<Group, Client>();
  return {
    base,
    sql,
    rec: new Recorder(),
    created,
    serverLog,
    client(group) {
      let c = clients.get(group);
      if (c === undefined) {
        const ip = group === "keys" || group === "budget" ? freshGroupIp() : GROUP_IP[group];
        if (isIP(ip) === 0) throw new Error(`group ${group} has an invalid client address`);
        created.ips.add(ip);
        c = new Client(base, ip, created);
        clients.set(group, c);
      }
      return c;
    },
  };
}

/** A small valid team workload with one exact-match field, so every case call has something to score. */
export function testWorkload(name: string, caseIds: string[], opts: { input?: string; expected?: string; answerSchema?: Record<string, unknown> } = {}): Record<string, unknown> {
  return {
    name,
    systemPrompt: "Decide whether an accounts-payable team should pay or hold the invoice. Answer only with JSON.",
    context: null,
    answerSchema: opts.answerSchema ?? {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
    shadowHint: null,
    scoring: [{ field: "verdict", rule: "exact" }],
    cases: caseIds.map((id) => ({ id, input: opts.input ?? `Invoice ${id}: 120 USD from a listed supplier.`, expected: { verdict: opts.expected ?? "pay" } })),
  };
}

/** Rows in case_results for these runs: the evidence that a refused call claimed nothing. */
export async function claimCount(sql: Sql, runIds: string[]): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM case_results WHERE run_id = ANY(${runIds})`;
  return Number(rows[0]?.n);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
