import net from "node:net";
import tls from "node:tls";
import { LIMITS } from "@urai/engine";
import { CONFIG } from "../../lib/config";
import { brief, type Ctx, field, LUNA_RAW, ownerHeaders, SAMPLE_BAD, testWorkload } from "./shared";

const SLOW_LINT_MS = 2_000;
const MARKUP = "<img src=x onerror=alert(1)>";

function schemaWith(verdict: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties: { verdict }, required: ["verdict"], additionalProperties: false };
}

function nestedSchema(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "string" };
  for (let d = depth; d > 2; d--) node = { type: "object", properties: { inner: node } };
  return schemaWith(node);
}

/** Pads or cuts to exactly n characters, so every prompt sits right at the lint's input cap. */
function exactly(n: number, text: string): string {
  return text.length >= n ? text.slice(0, n) : text + " ".repeat(n - text.length);
}

function lintPrompts(n: number): [string, string][] {
  const k = Math.floor((n - 1) / 4);
  const longLine = `${"[{,|".repeat(Math.ceil(1_999 / 4)).slice(0, 1_999)}\n`;
  return [
    ["nested brackets that never parse", exactly(n, `${"[\n".repeat(k)}x${"\n]".repeat(k)}`)],
    ["unclosed brackets", exactly(n, "[{".repeat(n / 2))],
    ["pipe table rows", exactly(n, "|a|b|c|\n".repeat(Math.ceil(n / 8)))],
    ["comma lines", exactly(n, ",,,,,\n".repeat(Math.ceil(n / 6)))],
    ["2,000-character lines of brackets, commas and pipes", exactly(n, longLine.repeat(Math.ceil(n / longLine.length)))],
  ];
}

function jsonOfSize(bytes: number): string {
  const open = '{"workload":{"name":"';
  const close = '"}}';
  return `${open}${"a".repeat(bytes - open.length - close.length)}${close}`;
}

/*
 * fetch always sends a correct Content-Length, so a lying header and an unannounced chunked body
 * need a raw socket. Resolves with the first status line and error code the server wrote.
 */
function rawPost(base: string, path: string, ip: string, head: string[], body: string[]): Promise<{ status: number; code: string | null }> {
  const url = new URL(base);
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const sock = secure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
  const lines = [`POST ${path} HTTP/1.1`, `Host: ${url.host}`, "Content-Type: application/json", `x-real-ip: ${ip}`, "Connection: close", ...head];
  return new Promise((resolve) => {
    let data = "";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      const code = /"error":"([a-z_]+)"/.exec(data);
      resolve({ status: status ? Number(status[1]) : 0, code: code?.[1] ?? null });
    };
    const timer = setTimeout(finish, 20_000);
    sock.on("data", (d: Buffer) => {
      data += d.toString("latin1");
    });
    // The server may close while the body is still going out; that is the refusal, not a failure.
    sock.on("error", () => undefined);
    sock.on("close", finish);
    sock.once(secure ? "secureConnect" : "connect", async () => {
      sock.write(`${lines.join("\r\n")}\r\n\r\n`);
      for (const chunk of body) {
        if (sock.destroyed) return;
        if (!sock.write(chunk)) {
          await new Promise((r) => {
            sock.once("drain", r);
            sock.once("close", r);
          });
        }
      }
    });
  });
}

/** C12, C13, C14, C20 groundwork and C21: hostile schemas, slow-parse prompts, oversized bodies, markup, and the lint rewrite. */
export async function input(ctx: Ctx): Promise<void> {
  const { rec, sql } = ctx;
  const api = ctx.client("input");

  const schemas: [string, Record<string, unknown>][] = [
    ["pattern", schemaWith({ type: "string", pattern: "^(a+)+$" })],
    ["$ref to a URL", schemaWith({ $ref: "https://evil.example/schema.json" })],
    ["format", schemaWith({ type: "string", format: "email" })],
    [`nesting depth ${LIMITS.schemaMaxDepth + 1}`, nestedSchema(LIMITS.schemaMaxDepth + 1)],
  ];
  for (const [label, answerSchema] of schemas) {
    const workload = testWorkload("Schema check", ["s1"], { answerSchema });
    const r = await api.send("POST", "/api/workloads", { json: { workload } });
    // The workload route never echoes reasons; the lint route returns them for the same body, which shows why it was refused.
    const why = await api.send("POST", "/api/lint", { json: { workload } });
    const reasons = field(why.body, "reasons");
    const reason = Array.isArray(reasons) && typeof reasons[0] === "string" ? reasons[0] : "no reason given";
    rec.add("C12", `answer schema using ${label}`, `POST /api/workloads with an answer schema using ${label}`, `${brief(r)} (reason: ${reason})`, r.status === 400);
  }

  const n = LIMITS.systemPromptMaxChars;
  for (const [label, prompt] of lintPrompts(n)) {
    if (prompt.length !== n) throw new Error(`setup: the ${label} prompt is ${prompt.length} characters, not ${n}`);
    const workload = { ...testWorkload("Lint timing", ["t1"]), systemPrompt: prompt };
    const r = await api.send("POST", "/api/lint", { json: { workload } });
    const findings = field(r.body, "findings");
    rec.add(
      "C13",
      `lint on a ${n.toLocaleString("en-US")}-character prompt of ${label}`,
      "POST /api/lint",
      `${brief(r)} in ${r.ms} ms${Array.isArray(findings) ? `, ${findings.length} findings` : ""}`,
      r.status === 200 && r.ms < SLOW_LINT_MS,
    );
  }

  const bigBytes = 301 * 1024;
  const big = await api.send("POST", "/api/workloads", { body: jsonOfSize(bigBytes) });
  rec.add("C14", "301 KB body", `POST /api/workloads with a ${bigBytes}-byte JSON body, true Content-Length`, brief(big), big.status === 413);

  const hidden = jsonOfSize(CONFIG.bodyMaxBytes + 10 * 1024);
  const lying = await rawPost(ctx.base, "/api/workloads", api.ip, ["Content-Length: 100"], [hidden]);
  rec.add(
    "C14",
    "Content-Length that understates the body",
    `raw POST /api/workloads declaring Content-Length 100 and sending ${hidden.length} bytes`,
    `${lying.status === 0 ? "connection reset by the server, no response" : `${lying.status}${lying.code === null ? "" : ` ${lying.code}`}`}`,
    // A reset is also a refusal: the body under test is not a valid workload, so nothing can be stored
    // whether the server answers 400 or drops the socket first (which it does when the extra bytes
    // arrive before it has replied; the run on 23 Sep 17:49 saw ECONNRESET in the route's log).
    (lying.status >= 400 && lying.status < 500) || lying.status === 0,
  );

  const pieces: string[] = [];
  for (let at = 0; at < hidden.length; at += 16 * 1024) {
    const part = hidden.slice(at, at + 16 * 1024);
    pieces.push(`${part.length.toString(16)}\r\n${part}\r\n`);
  }
  pieces.push("0\r\n\r\n");
  const chunked = await rawPost(ctx.base, "/api/workloads", api.ip, ["Transfer-Encoding: chunked"], pieces);
  rec.add(
    "C14",
    "chunked body over the cap with no Content-Length",
    `raw POST /api/workloads sending ${hidden.length} bytes chunked`,
    `${chunked.status}${chunked.code === null ? "" : ` ${chunked.code}`}`,
    chunked.status === 413,
  );

  const noteInput = `Supplier note: ${MARKUP}`;
  const mw = await api.createWorkload(testWorkload(`Markup check ${MARKUP}`, ["m1"], { input: noteInput, expected: MARKUP }));
  const mr = await api.createRun({ workloadId: mw.workloadId, configs: [LUNA_RAW], payer: "team" }, mw.ownerToken);
  const rep = await api.send("GET", `/api/runs/${mr.runId}/report`, { headers: ownerHeaders(mr.ownerToken) });
  const cases = field(rep.body, "cases");
  const first: unknown = Array.isArray(cases) ? cases[0] : null;
  const gotInput = field(first, "input");
  const gotExpected = field(field(first, "expected"), "verdict");
  const type = rep.headers.get("content-type") ?? "";
  rec.add(
    "C20",
    "markup in a case comes back from the owner report API as a plain JSON string",
    `team workload with ${MARKUP} in the case input and expected value; GET /api/runs/:id/report`,
    `${brief(rep)}, ${type}; input is ${typeof gotInput}, expected is ${typeof gotExpected}, both byte-identical: ${gotInput === noteInput && gotExpected === MARKUP}`,
    rep.status === 200 && type.startsWith("application/json") && gotInput === noteInput && gotExpected === MARKUP,
  );
  // The page is where a browser would run the markup: the tag must arrive only in its escaped form,
  // in the HTML and in the page's inline data alike.
  const shared = await api.send("POST", `/api/runs/${mr.runId}/share`, { headers: ownerHeaders(mr.ownerToken) });
  const reportId = field(shared.body, "reportId");
  const page = typeof reportId === "string" ? await api.send("GET", `/r/${reportId}`) : null;
  const html = page?.text ?? "";
  const escaped = html.includes("&lt;img src=x onerror=alert(1)&gt;");
  const raw = html.includes(MARKUP);
  rec.add(
    "C20",
    "markup renders as visible text on the report page",
    `share the markup run (name, case input and expected value hold ${MARKUP}); GET /r/:reportId`,
    `${page === null ? `share ${brief(shared)}, no report id` : brief(page)}; escaped form present: ${escaped}; raw tag present: ${raw}`,
    page !== null && page.status === 200 && escaped && !raw,
  );

  const before = (await sql`SELECT data, md5(data::text) AS h FROM workloads WHERE id = ${SAMPLE_BAD}`)[0];
  if (before === undefined) throw new Error("setup: sample-invoices-bad is not in the database");
  const lint = await api.send("POST", "/api/lint", { json: { workload: before.data } });
  const fix = field(lint.body, "fix");
  const fixedPrompt = field(field(fix, "workload"), "systemPrompt");
  const storedPrompt = field(before.data, "systemPrompt");
  const after = (await sql`SELECT md5(data::text) AS h FROM workloads WHERE id = ${SAMPLE_BAD}`)[0];
  const unchanged = after?.h === before.h;
  rec.add(
    "C21",
    "lint returns a rewrite and leaves the stored workload alone",
    "POST /api/lint with the stored sample-invoices-bad, then compare the stored row's hash",
    `${brief(lint)}; fix returned: ${fix !== null && fix !== undefined}, rewrite differs from stored prompt: ${typeof fixedPrompt === "string" && fixedPrompt !== storedPrompt}; stored row unchanged: ${unchanged}`,
    lint.status === 200 && typeof fixedPrompt === "string" && fixedPrompt !== storedPrompt && unchanged,
  );
}
