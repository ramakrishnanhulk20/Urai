import type { ExpectedValue, FieldScore, Workload, WorkloadCase } from "./types.js";

// Strict comma grouping, so "1,2,3" is not read as 123. No exponents, currency signs or units.
const NUMERIC = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/**
 * The one text normaliser, used on both sides of every exact and oneOf comparison (C15, C24).
 * Strings, finite numbers and booleans become their String form after NFKC, trim, inner
 * whitespace collapsed to one space, and lowercase. Everything else returns null: null,
 * undefined, NaN, infinities, objects and arrays.
 */
export function normaliseText(v: unknown): string | null {
  const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  if (!ok) return null;
  return String(v).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The one number normaliser, used on both sides of every number comparison (C15, C24).
 * Accepts finite numbers and numeric strings with optional thousands commas ("1,200.50").
 * Everything else returns null, including booleans, empty strings and values too large to be finite.
 */
export function normaliseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!NUMERIC.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Scores one parsed answer against one case, one FieldScore per scoring rule in order.
 * The answer is data only (C16): a non-object answer scores every field as a miss, and only
 * the answer's own properties are read. A value either normaliser cannot read is a miss, never
 * a match. correct is true only when there is at least one rule and every rule matches.
 */
export function scoreAnswer(w: Workload, c: WorkloadCase, answer: unknown): { fieldScores: FieldScore[]; correct: boolean } {
  const obj = isPlainObject(answer) ? answer : null;
  const fieldScores = w.scoring.map((r): FieldScore => {
    const expected: ExpectedValue = Object.hasOwn(c.expected, r.field) ? (c.expected[r.field] ?? null) : null;
    const got = obj !== null && Object.hasOwn(obj, r.field) ? obj[r.field] : undefined;
    let match = false;
    if (r.rule === "exact") {
      const e = normaliseText(expected);
      match = e !== null && e === normaliseText(got);
    } else if (r.rule === "number") {
      const e = normaliseNumber(expected);
      const g = normaliseNumber(got);
      match = e !== null && g !== null && Math.abs(e - g) <= (r.tolerance ?? 0);
    } else if (r.rule === "oneOf") {
      const g = normaliseText(got);
      match = g !== null && Array.isArray(expected) && expected.some((option) => normaliseText(option) === g);
    }
    return { field: r.field, expected, got, match };
  });
  return { fieldScores, correct: fieldScores.length > 0 && fieldScores.every((f) => f.match) };
}
