import type { RunConfig } from "@urai/engine";
import { z } from "zod";
import { CONFIG, OWNER_HEADER } from "../../../lib/config";
import { db, toJsonb } from "../../../lib/db";
import { HttpError, handle, json, readJson, requireJsonRequest } from "../../../lib/http";
import { hashToken, isWorkloadId, newId, newOwnerToken, tokenMatches } from "../../../lib/ids";
import { ipHash } from "../../../lib/ip";
import { enforceRateLimit } from "../../../lib/rate";
import { assertStorageRoom } from "../../../lib/storage";
import { canonicalConfigs, configKey, runConfigSchema } from "../../../lib/run-config";

const bodySchema = z.strictObject({
  workloadId: z.string().refine(isWorkloadId),
  configs: z.array(runConfigSchema).min(1).max(CONFIG.configsPerRunMax),
  payer: z.enum(["team", "demo"]),
});

const caseIdsSchema = z.array(z.string()).min(1).max(CONFIG.casesPerWorkloadMax);

/*
 * The payer is decided here, once, and stored on the run (C3). Demo runs spend the operator's
 * key, so they are refused unless the workload is an operator sample and every setting is on
 * that sample's allowlist (C4). Both sides of that check go through canonicalConfigs (C24).
 */
function checkDemo(isSample: boolean, sampleConfigs: unknown, requested: RunConfig[]): void {
  if (!isSample) throw new HttpError(403, "demo_not_allowed");
  const allowed = canonicalConfigs(sampleConfigs);
  if (allowed === null) throw new HttpError(403, "demo_not_allowed");
  const keys = new Set(allowed.map(configKey));
  if (!requested.every((c) => keys.has(configKey(c)))) throw new HttpError(403, "config_not_allowed");
}

/**
 * Creates a run for a stored workload.
 * Body: { workloadId, configs: RunConfig[] (1 to 6, no duplicates), payer: "team" | "demo" }.
 * A team run needs the workload's owner token in the x-urai-owner header; a demo run needs none
 * and is only allowed on a sample with its allowed settings.
 * Returns 201 { runId, reportId, ownerToken, cases, configs }. runId and reportId are drawn
 * separately, and the run's own owner token is shown once and only its hash is kept (C9, C11).
 * cases is the list this run may call, stored on the run (C10): every case for a team run, the
 * first CONFIG.demoCasesMax for a demo run, which caps what one demo run can spend.
 * Refuses with 429, 413, 415, 400 invalid_json, invalid_body or invalid_configs, 404 not_found
 * (unknown workload or wrong owner token, indistinguishable), 403 demo_not_allowed or
 * config_not_allowed.
 */
export async function POST(req: Request): Promise<Response> {
  return handle("POST /api/runs", async () => {
    requireJsonRequest(req);
    await enforceRateLimit("runs", ipHash(req));
    await assertStorageRoom();
    const body = await readJson(req, bodySchema);

    const configs = canonicalConfigs(body.configs);
    if (configs === null || new Set(configs.map(configKey)).size !== configs.length) {
      throw new HttpError(400, "invalid_configs");
    }

    const sql = db();
    const rows = await sql`
      SELECT owner_hash, is_sample, sample_configs, jsonb_path_query_array(data::jsonb, '$.cases[*].id') AS case_ids
      FROM workloads
      WHERE id = ${body.workloadId} AND expires_at > now()`;
    const workload = rows[0];
    if (workload === undefined) throw new HttpError(404, "not_found");

    if (body.payer === "demo") {
      checkDemo(workload.is_sample === true, workload.sample_configs, configs);
    } else if (!tokenMatches(req.headers.get(OWNER_HEADER), String(workload.owner_hash))) {
      console.warn("[urai] POST /api/runs: workload owner token missing or wrong");
      throw new HttpError(404, "not_found");
    }

    const allCases = caseIdsSchema.parse(workload.case_ids);
    const cases = body.payer === "demo" ? allCases.slice(0, CONFIG.demoCasesMax) : allCases;
    const configsJson = toJsonb(configs);
    if (configsJson === null) throw new HttpError(400, "invalid_configs");
    const casesJson = toJsonb(cases);
    if (casesJson === null) throw new HttpError(400, "invalid_workload");

    const runId = newId();
    const reportId = newId();
    const ownerToken = newOwnerToken();
    await sql`
      INSERT INTO runs (id, workload_id, report_id, owner_hash, payer, configs, case_ids)
      VALUES (${runId}, ${body.workloadId}, ${reportId}, ${hashToken(ownerToken)}, ${body.payer}, ${configsJson}::jsonb, ${casesJson}::jsonb)`;
    return json(201, { runId, reportId, ownerToken, cases, configs });
  });
}
