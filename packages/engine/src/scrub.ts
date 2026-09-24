import { LIMITS } from "./limits.js";

// Printable ASCII without space, so a key can never carry a newline into an HTTP header.
const KEY_SHAPE = new RegExp(`^[\\x21-\\x7E]{${LIMITS.keyMinChars},${LIMITS.keyMaxChars}}$`);

/**
 * True when k could be a SERV key: a string of LIMITS.keyMinChars to LIMITS.keyMaxChars
 * printable ASCII characters with no whitespace. Says nothing about whether SERV accepts it.
 */
export function isPlausibleKey(k: unknown): k is string {
  return typeof k === "string" && KEY_SHAPE.test(k);
}

// An upstream error that echoes only part of the key (a prefix, a tail) must lose that part too.
// 16 characters of a random key are still far too long to turn up in ordinary text by chance.
const KEY_WINDOW = 16;

/**
 * Removes the key from text, in its raw form and in its JSON-escaped form (a body that quotes the
 * key inside a JSON string escapes " and \). The second layer behind building every message from
 * our own words (C1). For a key of 16 characters or more, every stretch of text that contains any
 * 16-character piece of either form is found, and each maximal stretch those pieces cover becomes
 * "[key]", so a message that echoes a prefix, a tail or a middle slice keeps none of it. A key
 * shorter than 16 characters only has its whole-key occurrences replaced. Returns text unchanged
 * for an empty key.
 */
export function scrub(text: string, key: string): string {
  if (key === "") return text;
  const escaped = JSON.stringify(key).slice(1, -1);
  if (key.length < KEY_WINDOW) {
    const out = text.split(key).join("[key]");
    return escaped === key ? out : out.split(escaped).join("[key]");
  }

  const pieces = new Set<string>();
  for (const form of [key, escaped]) {
    for (let i = 0; i + KEY_WINDOW <= form.length; i++) pieces.add(form.slice(i, i + KEY_WINDOW));
  }
  // Pieces that overlap or touch belong to one stretch, which becomes a single "[key]".
  let out = "";
  let at = 0;
  let stretchStart = -1;
  let stretchEnd = -1;
  for (let i = 0; i + KEY_WINDOW <= text.length; i++) {
    if (!pieces.has(text.slice(i, i + KEY_WINDOW))) continue;
    if (stretchStart !== -1 && i <= stretchEnd) {
      stretchEnd = Math.max(stretchEnd, i + KEY_WINDOW);
      continue;
    }
    if (stretchStart !== -1) {
      out += `${text.slice(at, stretchStart)}[key]`;
      at = stretchEnd;
    }
    stretchStart = i;
    stretchEnd = i + KEY_WINDOW;
  }
  if (stretchStart !== -1) {
    out += `${text.slice(at, stretchStart)}[key]`;
    at = stretchEnd;
  }
  return out + text.slice(at);
}

/** Scrubs first, then caps, so a cut can never leave a piece of the key behind the cap. */
export function shortMessage(text: string, key: string): string {
  return scrub(text, key).slice(0, LIMITS.errorMaxChars);
}

/** Returns a copy of v with every string, including object keys, scrubbed. Only plain JSON-like data is walked. */
export function scrubDeep<T>(v: T, key: string): T {
  if (typeof v === "string") return scrub(v, key) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, key)) as T;
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    // defineProperty, so a "__proto__" key parsed from JSON stays an own property instead of swapping the prototype.
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, scrub(k, key), { value: scrubDeep(x, key), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return v;
}
