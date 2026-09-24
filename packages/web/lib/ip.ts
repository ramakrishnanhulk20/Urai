import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { serverEnv } from "./env";

// Every caller whose address cannot be read shares one bucket, so hiding it buys no extra quota.
const UNKNOWN = "unknown";

/**
 * The caller's address as Vercel reports it: x-real-ip, else the first x-forwarded-for entry.
 * Vercel overwrites both headers at its edge, so a client cannot choose them in production.
 * Anything that is not a valid IPv4 or IPv6 address (checked by node:net, not a pattern) counts
 * as unknown. Lowercased so one IPv6 address never lands in two buckets.
 */
export function clientIp(headers: Headers): string {
  const candidates = [headers.get("x-real-ip"), headers.get("x-forwarded-for")?.split(",")[0]];
  for (const c of candidates) {
    const ip = c?.trim().toLowerCase();
    if (ip && isIP(ip) === 4) return ip;
    if (ip && isIP(ip) === 6) return ipv6Bucket(ip);
  }
  return UNKNOWN;
}

/*
 * One IPv6 user is normally handed a whole /64 (2^64 addresses), so per-address limits would be
 * meaningless: the bucket is the /64 prefix. An IPv4-mapped address is bucketed as its IPv4 form.
 * The input has already passed isIP, so the expansion below only has to handle valid forms.
 */
function ipv6Bucket(ip: string): string {
  const bare = ip.split("%")[0]!;
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  let text = bare;
  const dotted = text.lastIndexOf(".") > -1 ? text.slice(text.lastIndexOf(":") + 1) : null;
  if (dotted !== null) {
    const [a, b, c, d] = dotted.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, text.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const zeros = Array<string>(8 - headParts.length - tailParts.length).fill("0");
  const full = tail === null ? headParts : [...headParts, ...zeros, ...tailParts];
  return `${full.slice(0, 4).map((p) => p.padStart(4, "0")).join(":")}::/64`;
}

/** HMAC-SHA256 of the caller's address with URAI_IP_SALT, as hex. The raw address is never stored or logged. */
export function ipHash(req: Request): string {
  return createHmac("sha256", serverEnv().ipSalt).update(clientIp(req.headers)).digest("hex");
}
