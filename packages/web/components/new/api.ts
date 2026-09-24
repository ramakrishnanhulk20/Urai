import type { LintFinding, RunConfig, Workload } from "@urai/engine";

// Must match OWNER_HEADER in lib/config.ts. Copied, not imported, because that file pulls the engine into the browser.
const OWNER_HEADER = "x-urai-owner";

const SEVERITIES = ["error", "warning", "info"] as const;
// Ids are 16 random bytes in base64url, owner tokens 32. Anything else is not a server answer we trust.
const ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface ModelEntry {
  id: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
}

export interface ModelListView {
  models: ModelEntry[];
  fetchedAt: string | null;
  verified: boolean;
}

export interface LayoutFix {
  systemPrompt: string;
  context: string | null;
  moved: { heading: string | null; kind: string; chars: number }[];
}

export type LintOutcome =
  | { kind: "checked"; findings: LintFinding[]; fix: LayoutFix | null }
  | { kind: "invalid"; reasons: string[] }
  | { kind: "rate_limited" }
  | { kind: "too_large" }
  | { kind: "refused"; code: string }
  | { kind: "network" };

export type ModelsOutcome = { kind: "loaded"; list: ModelListView } | { kind: "failed" };

export type SaveOutcome =
  | { kind: "saved"; workloadId: string; ownerToken: string }
  | { kind: "invalid" }
  | { kind: "too_large" }
  | { kind: "rate_limited" }
  | { kind: "refused"; code: string }
  | { kind: "network" };

export type StartOutcome =
  | { kind: "started"; runId: string; ownerToken: string }
  | { kind: "not_found" }
  | { kind: "invalid_configs" }
  | { kind: "rate_limited" }
  | { kind: "refused"; code: string }
  | { kind: "network" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error.slice(0, 40) : "unknown";
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/*
 * Every finding is rebuilt from checked fields, so a response in an unexpected shape can only
 * drop a finding, never put anything but plain strings in front of the reader.
 */
function toFinding(v: unknown): LintFinding | null {
  if (!isRecord(v)) return null;
  const severity = SEVERITIES.find((s) => s === v.severity);
  if (severity === undefined || typeof v.id !== "string" || typeof v.title !== "string" || typeof v.detail !== "string") return null;
  return {
    id: v.id as LintFinding["id"],
    severity,
    title: v.title,
    detail: v.detail,
    evidence: typeof v.evidence === "string" ? v.evidence : null,
    fixable: v.fixable === true,
    spans: [],
  };
}

function toFix(v: unknown): LayoutFix | null {
  if (!isRecord(v) || !isRecord(v.workload) || !Array.isArray(v.moved)) return null;
  const { systemPrompt, context } = v.workload;
  if (typeof systemPrompt !== "string" || (context !== null && typeof context !== "string")) return null;
  const moved = v.moved.flatMap((m) =>
    isRecord(m) && typeof m.kind === "string" && typeof m.chars === "number"
      ? [{ heading: typeof m.heading === "string" ? m.heading : null, kind: m.kind, chars: m.chars }]
      : [],
  );
  return { systemPrompt, context, moved };
}

/** The setup check. Nothing is stored and nothing is spent; the fix is only a suggestion to apply here. */
export async function lintSetup(workload: Workload, configs: RunConfig[]): Promise<LintOutcome> {
  const res = await post("/api/lint", configs.length > 0 ? { workload, configs } : { workload });
  if (res === null) return { kind: "network" };
  const body = await readBody(res);
  if (res.status === 200 && isRecord(body) && Array.isArray(body.findings)) {
    const findings = body.findings.map(toFinding).filter((f): f is LintFinding => f !== null);
    return { kind: "checked", findings, fix: body.fix === null ? null : toFix(body.fix) };
  }
  if (res.status === 400 && isRecord(body) && body.error === "invalid_workload" && Array.isArray(body.reasons)) {
    return { kind: "invalid", reasons: body.reasons.filter((r): r is string => typeof r === "string") };
  }
  if (res.status === 429) return { kind: "rate_limited" };
  if (res.status === 413) return { kind: "too_large" };
  return { kind: "refused", code: errorCode(body) };
}

function toModel(v: unknown): ModelEntry | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.inputUsdPerM !== "number" || typeof v.outputUsdPerM !== "number") {
    return null;
  }
  return { id: v.id, inputUsdPerM: v.inputUsdPerM, outputUsdPerM: v.outputUsdPerM };
}

export async function loadModels(): Promise<ModelsOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/models");
  } catch {
    return { kind: "failed" };
  }
  const body = await readBody(res);
  if (res.status !== 200 || !isRecord(body) || !Array.isArray(body.models)) return { kind: "failed" };
  return {
    kind: "loaded",
    list: {
      models: body.models.map(toModel).filter((m): m is ModelEntry => m !== null),
      fetchedAt: typeof body.fetchedAt === "string" ? body.fetchedAt : null,
      verified: body.verified === true,
    },
  };
}

/** Stores the test set. The owner token comes back once and is the only way to start a run on it. */
export async function saveWorkload(workload: Workload): Promise<SaveOutcome> {
  const res = await post("/api/workloads", { workload });
  if (res === null) return { kind: "network" };
  const body = await readBody(res);
  if (res.status === 201 && isRecord(body)) {
    const { workloadId, ownerToken } = body;
    if (typeof workloadId === "string" && ID_SHAPE.test(workloadId) && typeof ownerToken === "string" && TOKEN_SHAPE.test(ownerToken)) {
      return { kind: "saved", workloadId, ownerToken };
    }
    return { kind: "refused", code: "bad_response" };
  }
  if (res.status === 400 && errorCode(body) === "invalid_workload") return { kind: "invalid" };
  if (res.status === 413) return { kind: "too_large" };
  if (res.status === 429) return { kind: "rate_limited" };
  return { kind: "refused", code: errorCode(body) };
}

/** Starts a run the team pays for. The run id is checked before it ever becomes part of a URL. */
export async function startRun(workloadId: string, workloadToken: string, configs: RunConfig[]): Promise<StartOutcome> {
  const res = await post("/api/runs", { workloadId, configs, payer: "team" }, { [OWNER_HEADER]: workloadToken });
  if (res === null) return { kind: "network" };
  const body = await readBody(res);
  if (res.status === 201 && isRecord(body)) {
    const { runId, ownerToken } = body;
    if (typeof runId === "string" && ID_SHAPE.test(runId) && typeof ownerToken === "string" && TOKEN_SHAPE.test(ownerToken)) {
      return { kind: "started", runId, ownerToken };
    }
    return { kind: "refused", code: "bad_response" };
  }
  if (res.status === 404) return { kind: "not_found" };
  const code = errorCode(body);
  if (res.status === 400 && code === "invalid_configs") return { kind: "invalid_configs" };
  if (res.status === 429) return { kind: "rate_limited" };
  return { kind: "refused", code };
}
