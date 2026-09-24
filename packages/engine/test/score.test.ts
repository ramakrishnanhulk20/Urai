// Not covered here: answer JSON parsing and schema validation of the answer (done before scoring), and whether a team picked sensible rules.
import { describe, expect, it } from "vitest";
import { normaliseNumber, normaliseText, scoreAnswer, type ScoreRule, type Workload, type WorkloadCase } from "../src/index.js";

function setup(rule: ScoreRule, expected: WorkloadCase["expected"][string]): { w: Workload; c: WorkloadCase } {
  const c: WorkloadCase = { id: "c1", input: "x", expected: { [rule.field]: expected } };
  const w: Workload = {
    name: "t",
    systemPrompt: "s",
    context: null,
    answerSchema: { type: "object", properties: { [rule.field]: {} } },
    shadowHint: null,
    scoring: [rule],
    cases: [c],
  };
  return { w, c };
}

function matches(rule: ScoreRule, expected: WorkloadCase["expected"][string], got: unknown): boolean {
  const { w, c } = setup(rule, expected);
  return scoreAnswer(w, c, { [rule.field]: got }).correct;
}

describe("normalisers", () => {
  it("normaliseText applies NFKC, trim, whitespace collapse and lowercase, and refuses non-primitives", () => {
    expect(normaliseText("  Pay \t Now ")).toBe("pay now");
    expect(normaliseText("Ｐａｙ")).toBe("pay");
    expect(normaliseText(12)).toBe("12");
    expect(normaliseText(true)).toBe("true");
    for (const v of [null, undefined, NaN, Infinity, {}, [], ["pay"]]) expect(normaliseText(v)).toBeNull();
  });

  it("normaliseNumber reads finite numbers and numeric strings with thousands commas only", () => {
    expect(normaliseNumber(" 1,200.50 ")).toBe(1200.5);
    expect(normaliseNumber("-3")).toBe(-3);
    for (const v of ["1,2,3", "12,00", "$1200", "1e3", "", "abc", true, null, NaN, Infinity, "9".repeat(400), [1]]) {
      expect(normaliseNumber(v)).toBeNull();
    }
  });
});

describe("scoreAnswer", () => {
  it("normalises both sides for exact", () => {
    expect(matches({ field: "v", rule: "exact" }, " Pay ", "pay")).toBe(true);
    expect(matches({ field: "v", rule: "exact" }, "pay", " PAY ")).toBe(true);
    expect(matches({ field: "v", rule: "exact" }, "pay", "hold")).toBe(false);
  });

  it("reads a numeric string and a number the same way with tolerance 0", () => {
    expect(matches({ field: "n", rule: "number" }, "1,200", 1200)).toBe(true);
    expect(matches({ field: "n", rule: "number" }, 1200, "1,200")).toBe(true);
  });

  it("applies tolerance as an inclusive absolute difference", () => {
    expect(matches({ field: "n", rule: "number", tolerance: 0.5 }, 1200, 1200.4)).toBe(true);
    expect(matches({ field: "n", rule: "number", tolerance: 0.3 }, 1200, 1200.4)).toBe(false);
  });

  it("never matches null, objects or NaN, on either side", () => {
    expect(matches({ field: "v", rule: "exact" }, null, null)).toBe(false);
    expect(matches({ field: "v", rule: "exact" }, "null", null)).toBe(false);
    expect(matches({ field: "v", rule: "exact" }, "[object Object]", {})).toBe(false);
    expect(matches({ field: "n", rule: "number" }, null, null)).toBe(false);
    expect(matches({ field: "n", rule: "number", tolerance: 1e9 }, 5, NaN)).toBe(false);
    expect(matches({ field: "n", rule: "number" }, 0, { n: 0 })).toBe(false);
    expect(matches({ field: "o", rule: "oneOf" }, ["pay"], ["pay"])).toBe(false);
  });

  it("matches oneOf against any option after normalising both sides", () => {
    expect(matches({ field: "o", rule: "oneOf" }, ["pay", "Hold "], " HOLD")).toBe(true);
    expect(matches({ field: "o", rule: "oneOf" }, ["pay", "hold"], "reject")).toBe(false);
    expect(matches({ field: "o", rule: "oneOf" }, "hold", "hold")).toBe(false);
  });

  it("scores every field as a miss for a non-object answer", () => {
    const { w, c } = setup({ field: "v", rule: "exact" }, "pay");
    for (const answer of ["pay", 42, null, undefined, ["pay"], true]) {
      const r = scoreAnswer(w, c, answer);
      expect(r.correct).toBe(false);
      expect(r.fieldScores).toStrictEqual([{ field: "v", expected: "pay", got: undefined, match: false }]);
    }
  });

  it("is correct only when every rule matches, and never reads inherited properties", () => {
    const c: WorkloadCase = { id: "c1", input: "x", expected: { a: "x", b: 2 } };
    const w: Workload = {
      name: "t",
      systemPrompt: "s",
      context: null,
      answerSchema: { type: "object" },
      shadowHint: null,
      scoring: [
        { field: "a", rule: "exact" },
        { field: "b", rule: "number" },
      ],
      cases: [c],
    };
    expect(scoreAnswer(w, c, { a: "X", b: 2 }).correct).toBe(true);
    expect(scoreAnswer(w, c, { a: "X", b: 3 }).correct).toBe(false);
    expect(scoreAnswer(w, c, Object.create({ a: "x", b: 2 })).correct).toBe(false);
  });
});
