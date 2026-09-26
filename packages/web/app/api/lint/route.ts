import { applyLayoutFix, lintWorkload, parseWorkload, type LintFinding, type ModelList, type Workload } from "@urai/engine";
import { z } from "zod";
import { CONFIG } from "../../../lib/config";
import { HttpError, handle, json, readJson, requireJsonRequest } from "../../../lib/http";
import { ipHash } from "../../../lib/ip";
import { getModelList, toModelList } from "../../../lib/models";
import { enforceRateLimit } from "../../../lib/rate";
import { canonicalConfigs, runConfigSchema } from "../../../lib/run-config";

const ROUTE = "POST /api/lint";

export const maxDuration = 60;
export const runtime = "nodejs";

const bodySchema = z.strictObject({
  workload: z.unknown(),
  configs: z.array(runConfigSchema).max(CONFIG.configsPerRunMax).optional(),
});

/*
 * The engine's reasons are mostly our own words, but some quote the sender's own key names, field
 * names or schema text. They go back only to the sender, as JSON, and are never stored; capped in
 * count and length (C14), and the frontend renders them as text (C20).
 */
function capReasons(errors: string[]): string[] {
  return errors.slice(0, CONFIG.lintReasonsMax).map((r) => {
    const cut = r.slice(0, CONFIG.lintReasonMaxChars);
    const last = cut.charCodeAt(cut.length - 1);
    // A cut through a surrogate pair would leave half a character.
    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  });
}

function layoutFix(workload: Workload): ReturnType<typeof applyLayoutFix> | null {
  try {
    return applyLayoutFix(workload);
  } catch {
    // Its message can quote the rewritten workload's parse errors, so it is dropped unread.
    console.warn(`[urai] ${ROUTE}: a fixable finding had no valid rewrite`);
    return null;
  }
}

/**
 * The setup check on a test set, before anything is stored or spent.
 * Body: { workload, configs?: RunConfig[] (at most CONFIG.configsPerRunMax) }, capped at
 * CONFIG.bodyMaxBytes. Rate-limited per IP hash in the "lint" bucket.
 * Returns 200 { findings, fix } where fix is the one-click rewrite { workload, moved } when a
 * finding is fixable and the rewrite is valid, else null. The fix is data to show and copy;
 * nothing is stored or applied (C21). Model ids are checked against the cached SERV list only
 * when configs are given, and an unverified list reads as "could not verify" (C18).
 * Refuses with 429 rate_limited, 413, 415, 400 invalid_json, invalid_body or invalid_configs,
 * and 400 { error: "invalid_workload", reasons } with the engine's reasons, capped (C14).
 */
export async function POST(req: Request): Promise<Response> {
  return handle(ROUTE, async () => {
    requireJsonRequest(req);
    await enforceRateLimit("lint", ipHash(req));
    const body = await readJson(req, bodySchema);
    const configs = canonicalConfigs(body.configs ?? []);
    if (configs === null) throw new HttpError(400, "invalid_configs");

    const parsed = parseWorkload(body.workload);
    if (!parsed.ok) return json(400, { error: "invalid_workload", reasons: capReasons(parsed.errors) });

    // No settings means no model ids to check, so neither the cache nor SERV is touched.
    const models: ModelList | undefined = configs.length > 0 ? toModelList(await getModelList()) : undefined;
    const findings: LintFinding[] = lintWorkload(parsed.workload, { configs, models });
    const fix = findings.some((f) => f.fixable) ? layoutFix(parsed.workload) : null;
    return json(200, { findings, fix });
  });
}
