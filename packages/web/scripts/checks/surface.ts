import { randomBytes } from "node:crypto";
import { CONFIG } from "../../lib/config";
import { ipHash } from "../../lib/ip";
import { brief, bucketsFor, Client, type Ctx, field, type Reply, testWorkload } from "./shared";

const EVIL = "https://evil.example";

function corsHeaders(r: Reply): string[] {
  return [...r.headers.keys()].filter((k) => k.toLowerCase().startsWith("access-control-allow"));
}

function noStore(r: Reply): boolean {
  return (r.headers.get("cache-control") ?? "").toLowerCase().includes("no-store");
}

/**
 * C22 and the unauthenticated edges: cross-origin requests, the cron route, the model list limit,
 * the team storage cap, and the per-address workload limit (run last).
 */
export async function surface(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("surface");
  const id = randomBytes(16).toString("base64url");
  const routes = [
    "/api/lint",
    "/api/models",
    "/api/workloads",
    "/api/runs",
    `/api/runs/${id}`,
    `/api/runs/${id}/report`,
    `/api/runs/${id}/share`,
    `/api/runs/${id}/unshare`,
    `/api/runs/${id}/cases/c1?config=0`,
    `/api/reports/${id}`,
    "/api/cron/cleanup",
    "/api/search?query=serv",
  ];
  for (const path of routes) {
    const pre = await api.send("OPTIONS", path, {
      headers: {
        origin: EVIL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-serv-key, x-urai-owner",
      },
    });
    const get = await api.send("GET", path, { headers: { origin: EVIL } });
    const allow = [...corsHeaders(pre), ...corsHeaders(get)];
    const label = path.replace(id, ":id");
    rec.add(
      "C22",
      `cross-origin preflight and GET on ${label}`,
      `OPTIONS and GET with Origin ${EVIL}`,
      `OPTIONS ${brief(pre)}, GET ${brief(get)}; Access-Control-Allow headers: ${allow.length === 0 ? "none" : allow.join(", ")}; no-store on both: ${noStore(pre) && noStore(get)}`,
      allow.length === 0 && noStore(pre) && noStore(get),
    );
  }

  const bare = await api.send("GET", "/api/cron/cleanup");
  const wrong = await api.send("GET", "/api/cron/cleanup", { headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` } });
  rec.add("C26", "clean-up route with no Authorization", "GET /api/cron/cleanup", brief(bare), bare.status === 401);
  rec.add("C26", "clean-up route with a wrong secret", "GET /api/cron/cleanup with a random 64-character bearer secret", brief(wrong), wrong.status === 401);

  await modelsRateLimit(ctx);
  await storageFull(ctx);

  /*
   * Reads what this address has already used in the current window, so a leftover count from an
   * interrupted earlier run cannot shift where the refusal lands.
   */
  const bucket = bucketsFor(api.ip).find((b) => b.startsWith("workloads:"))!;
  const used = Number(
    (
      await sql`
        SELECT COALESCE(max(count), 0)::int AS n FROM rate_limits
        WHERE bucket = ${bucket}
          AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${CONFIG.rateWindowSeconds}) * ${CONFIG.rateWindowSeconds})`
    )[0]?.n,
  );
  const allowed = Math.max(0, CONFIG.workloadsPerIpPerWindow - used);
  const replies: Reply[] = [];
  for (let i = 0; i <= allowed; i++) {
    const r = await api.send("POST", "/api/workloads", { json: { workload: testWorkload("Rate check", ["r1"]) } });
    const wid = typeof r.body === "object" && r.body !== null ? (r.body as Record<string, unknown>).workloadId : undefined;
    if (r.status === 201 && typeof wid === "string") ctx.created.workloads.add(wid);
    replies.push(r);
  }
  const last = replies[replies.length - 1]!;
  const accepted = replies.slice(0, -1).filter((r) => r.status === 201).length;
  rec.add(
    "C26",
    `workload number ${CONFIG.workloadsPerIpPerWindow + 1} from one address within the hour`,
    `${replies.length} POST /api/workloads from one address (${used} already counted this window)`,
    `${accepted} of ${allowed} accepted, then ${brief(last)}`,
    accepted === allowed && last.status === 429 && last.code === "rate_limited",
  );

  const longQuery = await api.send("GET", `/api/search?query=${"a".repeat(201)}`);
  rec.add("C14", "docs search with a 201-character query", "GET /api/search with a 201-character query", brief(longQuery), longQuery.status === 400 && longQuery.code === "query_too_long");
}

// Their own documentation-range addresses, so each count starts from nothing and no other check shares it.
const MODELS_IP = "203.0.113.33";
const STORAGE_IP = "203.0.113.34";

/** C31: the model list refuses the read past the per-address limit, since a stale cache makes a read call SERV. */
async function modelsRateLimit(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = new Client(ctx.base, MODELS_IP, ctx.created);
  const bucket = `models:${ipHash(new Request("http://localhost/", { headers: { "x-real-ip": MODELS_IP } }))}`;
  try {
    await sql`DELETE FROM rate_limits WHERE bucket = ${bucket}`;
    const replies: Reply[] = [];
    for (let batch = 0; batch < CONFIG.modelsPerIpPerWindow; batch += 20) {
      const size = Math.min(20, CONFIG.modelsPerIpPerWindow - batch);
      replies.push(...(await Promise.all(Array.from({ length: size }, () => api.send("GET", "/api/models")))));
    }
    const last = await api.send("GET", "/api/models");
    const within = replies.filter((r) => r.status === 200).length;
    rec.add(
      "C31",
      `model list read number ${CONFIG.modelsPerIpPerWindow + 1} from one address within the hour`,
      `${CONFIG.modelsPerIpPerWindow + 1} GET /api/models from one address`,
      `${within} of ${CONFIG.modelsPerIpPerWindow} answered 200, then ${brief(last)}`,
      within === CONFIG.modelsPerIpPerWindow && last.status === 429 && last.code === "rate_limited",
    );
  } finally {
    await sql`DELETE FROM rate_limits WHERE bucket = ${bucket}`;
  }
}

/*
 * C14 and C26: the team storage cap, without filling the database. One stand-in row claims the whole
 * cap in size_bytes and holds two bytes of data. Real visitors are refused too while it exists, which
 * is about a second; it expires after two minutes, and the cap only counts unexpired rows, so even a
 * crash before the delete below cannot block the site for longer than that.
 */
async function storageFull(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  ctx.created.ips.add(STORAGE_IP);
  const api = new Client(ctx.base, STORAGE_IP, ctx.created);
  const tag = randomBytes(8).toString("hex");
  const filler = `verify-storage-${tag}`;
  const name = `Storage check ${tag}`;
  ctx.created.workloads.add(filler);
  let full: Reply;
  let stored: number;
  try {
    await sql`
      INSERT INTO workloads (id, owner_hash, data, expires_at, size_bytes)
      VALUES (${filler}, 'x', '{}'::json, now() + interval '2 minutes', ${CONFIG.workloadStoreMaxBytes})`;
    full = await api.send("POST", "/api/workloads", { json: { workload: testWorkload(name, ["s1"]) } });
    const wid = field(full.body, "workloadId");
    if (typeof wid === "string") ctx.created.workloads.add(wid);
    stored = Number((await sql`SELECT count(*)::int AS n FROM workloads WHERE NOT is_sample AND data->>'name' = ${name}`)[0]?.n);
  } finally {
    await sql`DELETE FROM workloads WHERE id = ${filler} AND NOT is_sample`;
  }
  const after = await api.send("POST", "/api/workloads", { json: { workload: testWorkload(name, ["s1"]) } });
  const wid = field(after.body, "workloadId");
  if (typeof wid === "string") ctx.created.workloads.add(wid);
  rec.add(
    "C26",
    "a workload that would pass the team storage cap",
    `POST /api/workloads while a stand-in row fills the ${CONFIG.workloadStoreMaxBytes}-byte cap, then again once it is gone`,
    `while full ${brief(full)}, rows stored ${stored}; after ${brief(after)}`,
    full.status === 503 && full.code === "storage_full" && stored === 0 && after.status === 201,
  );
}
