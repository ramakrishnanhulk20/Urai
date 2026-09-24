import { randomBytes } from "node:crypto";
import { CONFIG } from "../../lib/config";
import { ipHash } from "../../lib/ip";
import { brief, claimCount, Client, type Ctx, field, LUNA_RAW, ownerHeaders, type Reply, type RunMade, SAMPLE_GOOD, testWorkload } from "./shared";

const ID_CHARS = 22;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomId(): string {
  return randomBytes(16).toString("base64url");
}

// Changes one character near the end, so the id looks like the next or previous one in a series.
function neighbours(id: string, count: number): string[] {
  const at = id.length - 2;
  const out: string[] = [];
  for (const ch of ALPHABET) {
    if (out.length === count) break;
    if (ch !== id[at]) out.push(`${id.slice(0, at)}${ch}${id.slice(at + 1)}`);
  }
  return out;
}

/** 20 random, 10 zero-padded counters, 10 letter counters, 5 neighbours of a real run id, 5 of a real report id. */
function madeUpIds(runId: string, reportId: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push(randomId());
  for (let i = 1; i <= 10; i++) ids.push(String(i).padStart(ID_CHARS, "0"));
  for (let i = 0; i < 10; i++) ids.push(`${"A".repeat(ID_CHARS - 1)}${ALPHABET[i]}`);
  ids.push(...neighbours(runId, 5), ...neighbours(reportId, 5));
  return ids;
}

function tally(replies: Reply[], want: number): string {
  const off = replies.filter((r) => r.status !== want).map(brief);
  return `${replies.length - off.length} of ${replies.length} answered ${want}${off.length > 0 ? `; others: ${off.join(", ")}` : ""}`;
}

/**
 * C8 to C11: ids cannot be guessed, a report id opens nothing else, a case id works only in its own
 * run, sharing needs the owner token. Then C29 to C31: response caps, unshare, and the public
 * report rate limit.
 */
export async function access(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("access");

  const wa = await api.createWorkload(testWorkload("Access check A", ["a1", "a2", "a3"]));
  const wb = await api.createWorkload(testWorkload("Access check B", ["b1", "b2", "b3"]));
  const runA = await api.createRun({ workloadId: wa.workloadId, configs: [LUNA_RAW], payer: "team" }, wa.ownerToken);
  const runB = await api.createRun({ workloadId: wb.workloadId, configs: [LUNA_RAW], payer: "team" }, wb.ownerToken);

  // Positive controls: without them a wall of 404s could just mean the routes are broken.
  const ownRead = await api.send("GET", `/api/runs/${runA.runId}`, { headers: ownerHeaders(runA.ownerToken) });
  const shareA = await api.send("POST", `/api/runs/${runA.runId}/share`, { headers: ownerHeaders(runA.ownerToken) });
  const sharedA = await api.send("GET", `/api/reports/${runA.reportId}`);
  if (ownRead.status !== 200 || shareA.status !== 200 || sharedA.status !== 200) {
    throw new Error(`setup: owner read ${brief(ownRead)}, share ${brief(shareA)}, shared report ${brief(sharedA)}`);
  }

  const ids = madeUpIds(runA.runId, runA.reportId);
  const runReads: Reply[] = [];
  const reportReads: Reply[] = [];
  for (const id of ids) {
    // Run A's real owner token rides along, so a match on a neighbour id would not be stopped by a missing token.
    runReads.push(await api.send("GET", `/api/runs/${encodeURIComponent(id)}`, { headers: ownerHeaders(runA.ownerToken) }));
    reportReads.push(await api.send("GET", `/api/reports/${encodeURIComponent(id)}`));
  }
  rec.add(
    "C8",
    `${ids.length} made-up run ids`,
    "GET /api/runs/:id with random, counter-like and neighbour-of-real ids, carrying a real owner token",
    tally(runReads, 404),
    runReads.every((r) => r.status === 404),
  );
  rec.add(
    "C8",
    `${ids.length} made-up report ids`,
    "GET /api/reports/:id with the same ids, the real report shared",
    tally(reportReads, 404),
    reportReads.every((r) => r.status === 404),
  );

  const rep = encodeURIComponent(runA.reportId);
  const owner = ownerHeaders(runA.ownerToken);
  const asRun: [string, Reply][] = [
    ["GET run", await api.send("GET", `/api/runs/${rep}`, { headers: owner })],
    ["POST balance", await api.send("POST", `/api/runs/${rep}/balance`, { headers: owner })],
    ["GET report", await api.send("GET", `/api/runs/${rep}/report`, { headers: owner })],
    ["POST share", await api.send("POST", `/api/runs/${rep}/share`, { headers: owner })],
    ["POST case", await api.caseCall(runA.reportId, runA.cases[0]!, "0", owner)],
  ];
  rec.add(
    "C9",
    "real report id used as a run id on every run endpoint",
    "report id of run A in place of the run id, with run A's real owner token",
    asRun.map(([label, r]) => `${label} ${brief(r)}`).join("; "),
    asRun.every(([, r]) => r.status === 404),
  );
  const unshared = await api.send("GET", `/api/reports/${encodeURIComponent(runB.reportId)}`);
  rec.add("C9", "unshared report by its report id", "GET /api/reports/:reportId for run B, never shared", brief(unshared), unshared.status === 404);
  const runAsReport = await api.send("GET", `/api/reports/${encodeURIComponent(runA.runId)}`);
  rec.add("C9", "run id used as a report id", "GET /api/reports/:id with run A's run id (run A is shared)", brief(runAsReport), runAsReport.status === 404);
  const secretsInReport = [runA.runId, wa.workloadId, runA.ownerToken, wa.ownerToken].filter((s) => sharedA.text.includes(s)).length;
  rec.add(
    "C9",
    "shared report reveals no run id, workload id or token",
    "search the public report body of run A",
    `${secretsInReport} of 4 found`,
    secretsInReport === 0,
  );

  const foreign = await api.caseCall(runA.runId, runB.cases[0]!, "0", owner);
  rec.add("C10", "case id from another run", "POST case on run A with a case id of run B", brief(foreign), foreign.status === 404);
  for (const bad of ["-1", "99", "1.5", "0x1"]) {
    const r = await api.caseCall(runA.runId, runA.cases[0]!, bad, owner);
    rec.add("C10", `config index ${bad}`, `POST case on run A with config=${bad}`, brief(r), r.status === 400);
  }
  const demo = await api.createRun({ workloadId: SAMPLE_GOOD, configs: [LUNA_RAW], payer: "demo" });
  const extra = (await sql`SELECT data->'cases'->(${CONFIG.demoCasesMax}::int)->>'id' AS id FROM workloads WHERE id = ${SAMPLE_GOOD}`)[0]?.id;
  if (typeof extra !== "string" || demo.cases.includes(extra)) throw new Error("setup: the sample has no case past the demo limit");
  const outside = await api.caseCall(demo.runId, extra, "0", ownerHeaders(demo.ownerToken));
  rec.add(
    "C10",
    `case outside a demo run's first ${CONFIG.demoCasesMax}`,
    `POST case ${CONFIG.demoCasesMax + 1} of the sample on a demo run, no key`,
    brief(outside),
    outside.status === 404,
  );
  const claims = await claimCount(sql, [runA.runId, demo.runId]);
  rec.add("C10", "refused case calls claimed nothing", "count case_results rows for run A and the demo run", `${claims} rows`, claims === 0);

  const shareTries: [string, Reply][] = [
    ["no token", await api.send("POST", `/api/runs/${runB.runId}/share`)],
    ["run A's token", await api.send("POST", `/api/runs/${runB.runId}/share`, { headers: ownerHeaders(runA.ownerToken) })],
    ["workload B's token", await api.send("POST", `/api/runs/${runB.runId}/share`, { headers: ownerHeaders(wb.ownerToken) })],
  ];
  const sharedB = (await sql`SELECT shared FROM runs WHERE id = ${runB.runId}`)[0]?.shared;
  rec.add(
    "C11",
    "share without the run's own owner token",
    "POST /api/runs/:id/share on run B with no token, another run's token, and its workload's token",
    `${shareTries.map(([label, r]) => `${label} ${brief(r)}`).join("; ")}; run B shared in the database: ${String(sharedB)}`,
    shareTries.every(([, r]) => r.status === 404) && sharedB === false,
  );

  await responseCaps(ctx, runA);
  await unshare(ctx, runA, runB);
  await reportRateLimit(ctx);
}

// A stored result in the shape the report reads; written straight to the database so nothing is spent.
function storedResult(answer: Record<string, unknown>, answerText: string): string {
  return JSON.stringify({ status: "scored", correct: true, answer, answerText, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } });
}

/** C29: the status route carries no answers, and the report drops an oversized answer and records its length. */
async function responseCaps(ctx: Ctx, run: RunMade): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("access");
  const marker = `answer-${randomBytes(8).toString("hex")}`;
  const wide = { verdict: "x".repeat(CONFIG.reportAnswerMaxChars + 500) };
  await sql`
    INSERT INTO case_results (run_id, case_id, config_idx, status, result, finished_at) VALUES
      (${run.runId}, ${run.cases[0]!}, 0, 'scored', ${storedResult({ verdict: marker }, marker)}::jsonb, now()),
      (${run.runId}, ${run.cases[1]!}, 0, 'scored', ${storedResult(wide, "wide")}::jsonb, now())`;

  const status = await api.send("GET", `/api/runs/${run.runId}`, { headers: ownerHeaders(run.ownerToken) });
  const results = field(status.body, "results");
  const keys = Array.isArray(results) ? [...new Set(results.flatMap((r) => Object.keys(r as object)))].sort().join(",") : "none";
  rec.add(
    "C29",
    "run status carries no answers",
    "GET /api/runs/:id on a run with a finished case whose answer holds a marker",
    `${brief(status)}; result fields: ${keys}; marker in body: ${status.text.includes(marker)}`,
    status.status === 200 && keys === "caseId,configIdx,finishedAt,status" && !status.text.includes(marker),
  );

  const report = await api.send("GET", `/api/runs/${run.runId}/report`, { headers: ownerHeaders(run.ownerToken) });
  const cases = field(report.body, "cases");
  const slot = Array.isArray(cases) ? (cases.find((c) => field(c, "id") === run.cases[1]) as unknown) : undefined;
  const results2 = field(slot, "results");
  const first = Array.isArray(results2) ? results2[0] : undefined;
  const answer = field(first, "answer");
  // The cut is marked in its own field, so no model answer can pass for it (the head-chef change after web-review-fixes).
  const cutChars = field(first, "answerTruncatedChars");
  rec.add(
    "C29",
    "report drops an oversized answer and says how long it was",
    `GET /api/runs/:id/report with an answer of ${JSON.stringify(wide).length} characters serialised, cap ${CONFIG.reportAnswerMaxChars}`,
    `${brief(report)}; answer ${JSON.stringify(answer)?.slice(0, 40) ?? "missing"}, answerTruncatedChars ${String(cutChars)}; body ${report.text.length} characters`,
    report.status === 200 && answer === null && cutChars === JSON.stringify(wide).length && !report.text.includes(wide.verdict),
  );
}

/** C30: only the run's owner token takes a shared report back, and the public route is 404 after it. */
async function unshare(ctx: Ctx, runA: RunMade, runB: RunMade): Promise<void> {
  const { rec } = ctx;
  const api = ctx.client("access");
  const path = `/api/runs/${runA.runId}/unshare`;
  const tries: [string, Reply][] = [
    ["no token", await api.send("POST", path)],
    ["run B's token", await api.send("POST", path, { headers: ownerHeaders(runB.ownerToken) })],
    ["report id as run id", await api.send("POST", `/api/runs/${encodeURIComponent(runA.reportId)}/unshare`, { headers: ownerHeaders(runA.ownerToken) })],
  ];
  const still = await api.send("GET", `/api/reports/${runA.reportId}`);
  rec.add(
    "C30",
    "unshare without the run's own owner token",
    "POST /api/runs/:id/unshare on shared run A with no token, run B's token, and A's report id as the run id",
    `${tries.map(([label, r]) => `${label} ${brief(r)}`).join("; ")}; public report after: ${brief(still)}`,
    tries.every(([, r]) => r.status === 404) && still.status === 200,
  );
  const done = await api.send("POST", path, { headers: ownerHeaders(runA.ownerToken) });
  const after = await api.send("GET", `/api/reports/${runA.reportId}`);
  rec.add(
    "C30",
    "owner takes a shared report back",
    "POST /api/runs/:id/unshare with run A's owner token, then GET /api/reports/:reportId",
    `unshare ${brief(done)} ${done.text}; public report after: ${brief(after)}`,
    done.status === 200 && field(done.body, "shared") === false && after.status === 404,
  );
}

// Its own documentation-range address, so the count starts from nothing and no other check shares it.
const RATE_IP = "203.0.113.31";

/** C31: the public report route refuses the read past the per-address limit. */
async function reportRateLimit(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = new Client(ctx.base, RATE_IP, ctx.created);
  const hashOf = (ip: string) => ipHash(new Request("http://localhost/", { headers: { "x-real-ip": ip } }));
  const buckets = [RATE_IP, ctx.client("access").ip].map((ip) => `report:${hashOf(ip)}`);
  try {
    await sql`DELETE FROM rate_limits WHERE bucket = ${buckets[0]!}`;
    const replies: Reply[] = [];
    for (let batch = 0; batch < CONFIG.reportPerIpPerWindow; batch += 20) {
      const size = Math.min(20, CONFIG.reportPerIpPerWindow - batch);
      replies.push(...(await Promise.all(Array.from({ length: size }, () => api.send("GET", `/api/reports/${randomId()}`)))));
    }
    const last = await api.send("GET", `/api/reports/${randomId()}`);
    const within = replies.filter((r) => r.status === 404).length;
    rec.add(
      "C31",
      `public report read number ${CONFIG.reportPerIpPerWindow + 1} from one address within the hour`,
      `${CONFIG.reportPerIpPerWindow + 1} GET /api/reports/:id with made-up ids from one address`,
      `${within} of ${CONFIG.reportPerIpPerWindow} answered 404, then ${brief(last)}`,
      within === CONFIG.reportPerIpPerWindow && last.status === 429 && last.code === "rate_limited",
    );
  } finally {
    // The suite's shared clean-up only knows the write buckets, so the report buckets it made are removed here.
    await sql`DELETE FROM rate_limits WHERE bucket = ANY(${buckets})`;
  }
}
