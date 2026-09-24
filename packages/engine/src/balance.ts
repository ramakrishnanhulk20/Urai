import { z } from "zod";
import { LIMITS } from "./limits.js";
import { isPlausibleKey } from "./scrub.js";
import { readCapped, sendWithConnectRetry, SERV_CHAT_URL } from "./serv.js";
import type { Balance } from "./types.js";

/*
 * SERV refuses up front, with a 402 that states the balance, any request whose estimated
 * ceiling the balance cannot cover. The probe asks for the most expensive model and the
 * largest token cap SERV still accepts, so the ceiling is out of reach of any real balance (C7).
 * Probed live on 23 Sep 2026: 1,000,000 tokens estimated 60.02 USD, which a well-funded key
 * could cover and so run for real; 1,000,000,000 still returned the 402 billing_error and
 * estimated 60,000.02 USD. The larger one is kept.
 */
const PROBE_MAX_COMPLETION_TOKENS = 1_000_000_000;

const PROBE_BODY = JSON.stringify({
  model: "gpt-6-astra",
  max_completion_tokens: PROBE_MAX_COMPLETION_TOKENS,
  messages: [
    { role: "system", content: "Reply ok." },
    { role: "user", content: "ok" },
  ],
});

const BILLING_SHAPE = z.object({ error: z.object({ type: z.literal("billing_error"), message: z.string() }) });

/*
 * The shape given in the work order plus (?!\d) at the end. Without it, "$3.77 Reduce" (no
 * full stop) backtracks to read "$3" followed by "." and returns 3 instead of refusing.
 */
const BILLING_MESSAGE = /^Insufficient credits for this request: estimated maximum cost is \$\d+(\.\d+)? but your balance is \$(\d+(\.\d+)?)\.(?!\d)/;

const UNAVAILABLE: Balance = { ok: false, reason: "unavailable" };

/** The one 402 shape we trust (C19). Anything else is null, never a guessed number. */
function parseBilling(text: string): number | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const shaped = BILLING_SHAPE.safeParse(json);
  if (!shaped.success) return null;
  const m = BILLING_MESSAGE.exec(shaped.data.error.message);
  if (m === null || m[2] === undefined) return null;
  const usd = Number(m[2]);
  return Number.isFinite(usd) ? usd : null;
}

/**
 * Reads a key's credit balance for free by sending a request SERV must refuse before any model
 * runs, then parsing the balance out of the 402 billing error.
 * Returns { ok:false, reason:"unavailable" } with no network call when the key fails
 * isPlausibleKey, and on any timeout, network failure, other status or unexpected 402 body.
 * Returns { ok:false, reason:"probe_ran" } on a 200: the probe was billed as a real call and the
 * caller must treat that as a fault (C7). Never throws; the key goes only to SERV_CHAT_URL.
 */
export async function readBalance(apiKey: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<Balance> {
  if (!isPlausibleKey(apiKey)) return UNAVAILABLE;
  const timeoutSignal = AbortSignal.timeout(LIMITS.probeTimeoutMs);
  const sent = await sendWithConnectRetry(
    opts.fetchImpl ?? fetch,
    SERV_CHAT_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: PROBE_BODY,
    },
    timeoutSignal,
    timeoutSignal,
  );
  if (!sent.ok) return UNAVAILABLE;
  const res = sent.res;
  if (res.status === 200) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "probe_ran" };
  }
  if (res.status !== 402) {
    await res.body?.cancel().catch(() => undefined);
    return UNAVAILABLE;
  }
  const body = await readCapped(res, LIMITS.probeResponseMaxBytes);
  if (!body.ok) return UNAVAILABLE;
  const usd = parseBilling(body.text);
  return usd === null ? UNAVAILABLE : { ok: true, usd };
}
