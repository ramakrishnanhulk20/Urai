import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CONFIG } from "./config";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

export const ID_CHARS = base64urlLength(CONFIG.idBytes);
export const OWNER_TOKEN_CHARS = base64urlLength(CONFIG.ownerTokenBytes);

/** A public id for a workload, run or report: 16 bytes from the OS CSPRNG, 22 base64url characters (C8). */
export function newId(): string {
  return randomBytes(CONFIG.idBytes).toString("base64url");
}

/**
 * A 32-byte owner token, 43 base64url characters. Twice the length of an id, so a token can
 * never be mistaken for a record id. Returned to the caller once; only its hash is stored (C11).
 */
export function newOwnerToken(): string {
  return randomBytes(CONFIG.ownerTokenBytes).toString("base64url");
}

/** sha256 of the token, as lowercase hex. The token itself is never written anywhere. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * True only when token has the exact owner token shape and hashes to storedHash. Compared in
 * constant time. A missing, malformed or wrong-length value on either side is false.
 */
export function tokenMatches(token: string | null | undefined, storedHash: string): boolean {
  if (typeof token !== "string" || token.length !== OWNER_TOKEN_CHARS || !BASE64URL.test(token)) return false;
  if (!SHA256_HEX.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), "hex"), Buffer.from(storedHash, "hex"));
}

/** True when s has the exact shape newId() produces. Anything else can never name a run or report. */
export function isGeneratedId(s: string): boolean {
  return s.length === ID_CHARS && BASE64URL.test(s);
}

/** True when s could be a workload id: a generated id, or an operator-chosen sample id with the same alphabet. */
export function isWorkloadId(s: string): boolean {
  return s.length >= 1 && s.length <= CONFIG.workloadIdMaxChars && BASE64URL.test(s);
}
