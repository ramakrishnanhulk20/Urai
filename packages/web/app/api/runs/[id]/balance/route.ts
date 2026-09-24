import { type Balance, isPlausibleKey, readBalance } from "@urai/engine";
import { CONFIG } from "../../../../../lib/config";
import { db } from "../../../../../lib/db";
import { isSet, setFlag } from "../../../../../lib/flags";
import { HttpError, errorResponse, handle, json, requireOwnedRun, teamKeyHeader } from "../../../../../lib/http";

const ROUTE = "POST /api/runs/[id]/balance";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Reads the team's SERV balance with the engine's free probe and records it on the run: the first
 * reading as balance_before, the latest as balance_after.
 * Headers: x-urai-owner (the run's owner token) and x-serv-key (the team's key). No body is read.
 * Team runs only: a demo run, or a missing, blank or implausible key, is 400 payer_mismatch. The
 * operator key is never probed here.
 * While the global probe_ran stop is set, every probe is refused with 503 probe_disabled (C7).
 * At most CONFIG.probesPerRunMax probes per run, counted by one atomic UPDATE before the probe
 * (429 probe_limit after that). A probe that SERV actually ran is a fault (C7): the run is
 * flagged probe_ran, the global probe_ran stop is set, 502 probe_ran is returned and the run takes
 * no further probes (409 run_flagged).
 * Returns 200 { usd } or 200 { unavailable: true } when the balance could not be read (C19).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(ROUTE, async () => {
    const { id } = await params;
    const run = await requireOwnedRun(req, id, ROUTE);
    const key = teamKeyHeader(req);
    if (run.payer !== "team" || !isPlausibleKey(key)) {
      console.warn(`[urai] ${ROUTE}: payer_mismatch on a ${run.payer} run`);
      throw new HttpError(400, "payer_mismatch");
    }
    if (run.flagged !== null) throw new HttpError(409, "run_flagged");
    if (await isSet("probe_ran")) {
      console.warn(`[urai] ${ROUTE}: refused, the probe_ran stop is set`);
      throw new HttpError(503, "probe_disabled");
    }

    const sql = db();
    const counted = await sql`
      UPDATE runs SET probes = probes + 1
      WHERE id = ${run.id} AND probes < ${CONFIG.probesPerRunMax} AND flagged IS NULL
      RETURNING probes`;
    if (counted[0] === undefined) {
      console.warn(`[urai] ${ROUTE}: probe limit reached`);
      throw new HttpError(429, "probe_limit");
    }

    let balance: Balance;
    try {
      balance = await readBalance(key);
    } catch {
      // readBalance is documented never to throw; if it does, no number is guessed (C19).
      balance = { ok: false, reason: "unavailable" };
    }

    if (balance.ok) {
      await sql`
        UPDATE runs SET balance_before = COALESCE(balance_before, ${balance.usd}::numeric), balance_after = ${balance.usd}::numeric
        WHERE id = ${run.id}`;
      return json(200, { usd: balance.usd });
    }
    if (balance.reason === "probe_ran") {
      await sql`UPDATE runs SET flagged = 'probe_ran' WHERE id = ${run.id}`;
      await setFlag("probe_ran", "a team balance probe was billed as a real call");
      console.error(`[urai] ${ROUTE}: the balance probe ran as a paid call; run flagged, every probe and demo call stopped`);
      return errorResponse(502, "probe_ran");
    }
    return json(200, { unavailable: true });
  });
}
