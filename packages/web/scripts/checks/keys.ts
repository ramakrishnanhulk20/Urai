import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { CONFIG } from "../../lib/config";
import { brief, bucketsFor, claimCount, type Ctx, LUNA_RAW, ownerHeaders, type Reply, SAMPLE_GOOD, SERV_KEY_HEADER, sleep, testWorkload } from "./shared";

const SHOWN_KEY = "serv_testkey_<40 random characters>";
const WINDOW = 16;

/*
 * The full key, its random part, and every 16-character slice of the random part. A slice match
 * catches an upstream error that echoes part of the key, which a full-key search would miss.
 */
function needles(key: string, tail: string): string[] {
  const out = [key, tail];
  for (let i = 0; i + WINDOW <= tail.length; i++) out.push(tail.slice(i, i + WINDOW));
  return out;
}

function leaks(text: string, list: string[]): number {
  return list.filter((n) => text.includes(n)).length;
}

async function settle(call: () => Promise<Reply>): Promise<Reply> {
  let r = await call();
  for (let i = 0; i < 60 && (r.status === 202 || (r.status === 429 && r.code === "run_busy")); i++) {
    await sleep(1_500);
    r = await call();
  }
  return r;
}

/**
 * C1, C3, C4, C7 and C33: a made-up key of the right shape never leaves memory, the payer is fixed
 * at run creation, the balance route is gone, and an address that has used its key refusal budget
 * is refused before SERV.
 */
export async function keys(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("keys");
  const tail = randomBytes(30).toString("base64url");
  const canary = `serv_testkey_${tail}`;
  const find = needles(canary, tail);

  const wl = await api.createWorkload(testWorkload("Key check", ["k1", "k2", "k3"]));
  const driven = await api.createRun({ workloadId: wl.workloadId, configs: [LUNA_RAW], payer: "team" }, wl.ownerToken);
  const idle = await api.createRun({ workloadId: wl.workloadId, configs: [LUNA_RAW], payer: "team" }, wl.ownerToken);
  const demo = await api.createRun({ workloadId: SAMPLE_GOOD, configs: [LUNA_RAW], payer: "demo" });

  // SERV refuses the made-up key with 401, so this spends nothing; it puts the key through the real request path.
  const outcomes: string[] = [];
  let handled = true;
  let refused = 0;
  for (const caseId of driven.cases) {
    const r = await settle(() => api.caseCall(driven.runId, caseId, "0", ownerHeaders(driven.ownerToken, canary)));
    outcomes.push(`${caseId}: ${brief(r)}`);
    if (r.status === 401 && r.code === "serv_rejected_key") refused++;
    else handled = false;
  }
  rec.add(
    "C1",
    "team run driven with a made-up key (setup for the scans below)",
    `${driven.cases.length} case calls on a team run, x-serv-key ${SHOWN_KEY}`,
    outcomes.join("; "),
    handled,
  );
  const leftBehind = await sql`SELECT count(*)::int AS n FROM case_results WHERE run_id = ${driven.runId}`;
  const leftRows = Number(leftBehind[0]?.n);
  rec.add(
    "C5",
    "a call SERV refused with 401 is released, so a corrected key can run it",
    `count the stored rows on the team run after SERV refused all ${driven.cases.length} calls`,
    `${leftRows} rows`,
    leftRows === 0,
  );

  const params = ["x-serv-key", "key", "servKey", "apiKey", "api_key"];
  const queryResults: string[] = [];
  let queryIgnored = true;
  for (const p of params) {
    const r = await api.caseCall(idle.runId, idle.cases[0]!, "0", ownerHeaders(idle.ownerToken), `&${p}=${encodeURIComponent(canary)}`);
    queryResults.push(`${p}: ${brief(r)}`);
    if (!(r.status === 400 && r.code === "payer_mismatch")) queryIgnored = false;
  }
  const idleClaims = await claimCount(sql, [idle.runId]);
  rec.add(
    "C1",
    "key sent only in the query string is ignored",
    `team run, no key header, key in the query as ${params.join(", ")}`,
    `${queryResults.join("; ")}; case_results rows ${idleClaims}`,
    queryIgnored && idleClaims === 0,
  );

  const variants: [string, Record<string, string>][] = [
    ["no key header", ownerHeaders(idle.ownerToken)],
    ["empty key header", { ...ownerHeaders(idle.ownerToken), [SERV_KEY_HEADER]: "" }],
    ["whitespace key header (HTTP trims it, so it arrives empty)", { ...ownerHeaders(idle.ownerToken), [SERV_KEY_HEADER]: "   " }],
  ];
  for (const [label, headers] of variants) {
    const r = await api.caseCall(idle.runId, idle.cases[0]!, "0", headers);
    rec.add("C3", `team run case call, ${label}`, `POST case on a team run with the run owner token and ${label}`, brief(r), r.status === 400 && r.code === "payer_mismatch");
  }
  const afterC3 = await claimCount(sql, [idle.runId]);
  rec.add("C3", "refused team calls claimed nothing", "count case_results rows for that team run", `${afterC3} rows`, afterC3 === 0);

  const dk = await api.caseCall(demo.runId, demo.cases[0]!, "0", ownerHeaders(demo.ownerToken, canary));
  const demoClaims = await claimCount(sql, [demo.runId]);
  rec.add(
    "C3",
    "demo run case call with a key header",
    `POST case on a demo run with x-serv-key ${SHOWN_KEY}`,
    `${brief(dk)}; case_results rows ${demoClaims}`,
    dk.status === 400 && dk.code === "payer_mismatch" && demoClaims === 0,
  );

  const c4 = await api.tryRun({ workloadId: wl.workloadId, configs: [LUNA_RAW], payer: "demo" });
  const c4cfg = await api.tryRun({ workloadId: SAMPLE_GOOD, configs: [{ model: "gpt-6-astra", mode: "full" }], payer: "demo" });
  const demoOnPublic = Number((await sql`SELECT count(*)::int AS n FROM runs WHERE workload_id = ${wl.workloadId} AND payer = 'demo'`)[0]?.n);
  rec.add(
    "C4",
    "demo run on a workload made through the public API",
    "POST /api/runs payer demo on a workload created by POST /api/workloads",
    `${brief(c4)}; demo runs stored for it ${demoOnPublic}`,
    c4.status === 403 && c4.code === "demo_not_allowed" && demoOnPublic === 0,
  );
  rec.add(
    "C4",
    "demo run on a sample with settings outside its allowlist",
    "POST /api/runs payer demo on sample-invoices-good with gpt-6-astra full",
    brief(c4cfg),
    c4cfg.status === 403 && c4cfg.code === "config_not_allowed",
  );

  // C7: the balance probe was removed on 25 Sep, so the old route must not answer even a fully credentialed call.
  const gone = await api.send("POST", `/api/runs/${driven.runId}/balance`, { headers: ownerHeaders(driven.ownerToken, canary) });
  rec.add(
    "C7",
    "the balance route no longer exists",
    `POST /api/runs/:id/balance on a real team run with its owner token and x-serv-key ${SHOWN_KEY}`,
    brief(gone),
    gone.status === 404,
  );

  // The last case call of this group, because it spends this address's refusal budget for the hour.
  const refusalBucket = bucketsFor(api.ip).find((b) => b.startsWith("key_refusals:"))!;
  const bucketCount = async () => Number((await sql`SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits WHERE bucket = ${refusalBucket}`)[0]?.n);
  const refusalsBefore = await bucketCount();
  await sql`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${refusalBucket},
            to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds}),
            ${CONFIG.keyRefusalsPerIpPerWindow})
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${CONFIG.keyRefusalsPerIpPerWindow}`;
  const blocked = await api.caseCall(idle.runId, idle.cases[0]!, "0", ownerHeaders(idle.ownerToken, canary));
  const blockedClaims = await claimCount(sql, [idle.runId]);
  const refusalsAfter = await bucketCount();
  rec.add(
    "C33",
    "team call from an address that has used its key refusal budget",
    `read this address's key_refusals count, set it to ${CONFIG.keyRefusalsPerIpPerWindow}, then POST case on a team run with x-serv-key ${SHOWN_KEY}`,
    `refusals counted before ${refusalsBefore} (401s seen ${refused}); ${brief(blocked)}; case_results rows ${blockedClaims}; count after ${refusalsAfter}`,
    refusalsBefore === refused &&
      blocked.status === 429 &&
      blocked.code === "rate_limited" &&
      blockedClaims === 0 &&
      refusalsAfter === CONFIG.keyRefusalsPerIpPerWindow,
  );

  // The scans run last so they cover every place this group sent the key.
  const responseHits = api.transcript.reduce((n, t) => n + leaks(t, find), 0);
  rec.add(
    "C1",
    "made-up key absent from every response",
    `search ${api.transcript.length} response bodies and headers for the key, its random part and every ${WINDOW}-character slice`,
    `${responseHits} matches`,
    responseHits === 0,
  );

  const runIds = [driven.runId, idle.runId, demo.runId];
  const rows = [
    ...(await sql`SELECT row_to_json(r)::text AS t FROM runs r WHERE id = ANY(${runIds})`),
    ...(await sql`SELECT row_to_json(c)::text AS t FROM case_results c WHERE run_id = ANY(${runIds})`),
    ...(await sql`SELECT row_to_json(w)::text AS t FROM workloads w WHERE id = ${wl.workloadId}`),
  ].map((r) => String(r.t));
  const dbHits = rows.reduce((n, t) => n + leaks(t, find), 0);
  const resultRows = rows.filter((t) => t.includes('"case_id"')).length;
  rec.add(
    "C1",
    "made-up key absent from the database",
    "search the runs, case_results and workloads rows this group made",
    `${rows.length} rows searched (${resultRows} case results), ${dbHits} matches`,
    dbHits === 0 && rows.length >= runIds.length + 1,
  );

  if (ctx.serverLog === null || !existsSync(ctx.serverLog)) {
    rec.add("C1", "made-up key absent from the server log", "no --server-log file given", "not searched", "PENDING");
    return;
  }
  const log = readFileSync(ctx.serverLog, "utf8");
  const logHits = leaks(log, find);
  // Proves the file really is this server's output: the refusals above each wrote a payer_mismatch line.
  const ownLines = log.split("\n").filter((l) => l.includes("payer_mismatch")).length;
  rec.add(
    "C1",
    "made-up key absent from the server log",
    "search the server's captured stdout and stderr",
    `${log.split("\n").length} lines, ${ownLines} payer_mismatch lines (proof the file is this server's output), ${logHits} key matches`,
    logHits === 0 && ownLines > 0,
  );
}
