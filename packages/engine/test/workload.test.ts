// Not covered here: the schema keyword rules themselves (schema.test.ts), scoring (score.test.ts), request bodies, and body-size caps at the HTTP layer.
import { describe, expect, it } from "vitest";
import { LIMITS, parseWorkload } from "../src/index.js";

type Raw = Record<string, unknown> & { cases: Record<string, unknown>[]; scoring: Record<string, unknown>[] };

function valid(): Raw {
  return {
    name: "Invoice approvals",
    systemPrompt: "Decide pay, hold or reject.",
    context: "supplier book",
    answerSchema: {
      type: "object",
      properties: { verdict: { type: "string" }, amount: { type: "number" } },
      required: ["verdict", "amount"],
      additionalProperties: false,
    },
    shadowHint: null,
    scoring: [
      { field: "verdict", rule: "oneOf" },
      { field: "amount", rule: "number", tolerance: 0.5 },
    ],
    cases: [{ id: "case-1", input: "invoice text", expected: { verdict: ["pay"], amount: 1200 } }],
  };
}

function manyCases(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, input: "x", expected: { verdict: ["pay"], amount: 1 } }));
}

function manyRules(n: number): Raw {
  const w = valid();
  const fields = Array.from({ length: n }, (_, i) => `f${i}`);
  w.answerSchema = { type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])) };
  w.scoring = fields.map((field) => ({ field, rule: "exact" }));
  w.cases = [{ id: "c1", input: "x", expected: Object.fromEntries(fields.map((f) => [f, "v"])) }];
  return w;
}

function errorsOf(input: unknown): string {
  const r = parseWorkload(input);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.errors.join("; ");
}

describe("parseWorkload caps", () => {
  it("accepts the baseline workload", () => {
    expect(parseWorkload(valid()).ok).toBe(true);
  });

  const withField = (set: (w: Raw) => void): Raw => {
    const w = valid();
    set(w);
    return w;
  };

  it.each([
    ["name", LIMITS.nameMaxChars, (w: Raw, n: number) => (w.name = "n".repeat(n))],
    ["systemPrompt", LIMITS.systemPromptMaxChars, (w: Raw, n: number) => (w.systemPrompt = "s".repeat(n))],
    ["context", LIMITS.contextMaxChars, (w: Raw, n: number) => (w.context = "c".repeat(n))],
    ["cases[0].input", LIMITS.caseInputMaxChars, (w: Raw, n: number) => (w.cases[0]!.input = "i".repeat(n))],
    ["cases[0].id", LIMITS.caseIdMaxChars, (w: Raw, n: number) => (w.cases[0]!.id = "a".repeat(n))],
  ])("%s passes at %i characters and fails one over", (field, max, set) => {
    expect(parseWorkload(withField((w) => set(w, max))).ok).toBe(true);
    expect(errorsOf(withField((w) => set(w, max + 1)))).toContain(field);
  });

  it("rejects an empty name, a blank system prompt, an empty case id and a case id with other characters", () => {
    expect(errorsOf(withField((w) => (w.name = "")))).toContain("name");
    expect(errorsOf(withField((w) => (w.systemPrompt = "  ")))).toContain("systemPrompt");
    expect(errorsOf(withField((w) => (w.cases[0]!.id = "")))).toContain("cases[0].id");
    expect(errorsOf(withField((w) => (w.cases[0]!.id = "a b")))).toContain("cases[0].id");
  });

  it(`accepts ${LIMITS.casesMin} and ${LIMITS.casesMax} cases, rejects ${LIMITS.casesMin - 1} and ${LIMITS.casesMax + 1}`, () => {
    expect(parseWorkload(withField((w) => (w.cases = manyCases(LIMITS.casesMin)))).ok).toBe(true);
    expect(parseWorkload(withField((w) => (w.cases = manyCases(LIMITS.casesMax)))).ok).toBe(true);
    expect(errorsOf(withField((w) => (w.cases = manyCases(LIMITS.casesMin - 1))))).toContain("cases");
    expect(errorsOf(withField((w) => (w.cases = manyCases(LIMITS.casesMax + 1))))).toContain(`limit is ${LIMITS.casesMax}`);
  });

  it(`accepts ${LIMITS.scoringRulesMin} and ${LIMITS.scoringRulesMax} scoring rules, rejects ${LIMITS.scoringRulesMin - 1} and ${LIMITS.scoringRulesMax + 1}`, () => {
    expect(parseWorkload(manyRules(LIMITS.scoringRulesMin)).ok).toBe(true);
    expect(parseWorkload(manyRules(LIMITS.scoringRulesMax)).ok).toBe(true);
    expect(errorsOf(withField((w) => (w.scoring = [])))).toContain("scoring");
    expect(errorsOf(manyRules(LIMITS.scoringRulesMax + 1))).toContain(`limit is ${LIMITS.scoringRulesMax}`);
  });

  it("rejects an over-cap schema through parseWorkload", () => {
    const w = withField((x) => ((x.answerSchema as Record<string, unknown>).description = "d".repeat(LIMITS.schemaMaxBytes)));
    expect(errorsOf(w)).toContain("bytes");
  });
});

describe("parseWorkload consistency", () => {
  it("rejects duplicate case ids", () => {
    const w = valid();
    w.cases = [...manyCases(1), ...manyCases(1)];
    expect(errorsOf(w)).toContain("used by an earlier case");
  });

  it("rejects a scoring field that is not in the schema's properties", () => {
    const w = valid();
    w.scoring = [{ field: "missing", rule: "exact" }];
    w.cases = [{ id: "c1", input: "x", expected: { missing: "v" } }];
    expect(errorsOf(w)).toContain('"missing" is not a property in answerSchema');
  });

  it("rejects a oneOf rule whose expected value is not a list", () => {
    const w = valid();
    w.cases[0]!.expected = { verdict: "pay", amount: 1200 };
    expect(errorsOf(w)).toContain("oneOf rule expects a non-empty list");
  });

  it("rejects unknown keys and wrong types instead of guessing", () => {
    expect(errorsOf({ ...valid(), extra: true })).toContain("extra");
    expect(errorsOf({ ...valid(), context: 5 })).toContain("context");
    expect(errorsOf("not a workload")).toContain("workload");
  });
});
