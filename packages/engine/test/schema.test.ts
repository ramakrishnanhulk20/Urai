// Not covered here: compile time on a hostile but in-cap schema, Ajv bugs, and whether SERV or the upstream provider accepts every schema this allows.
import { describe, expect, it } from "vitest";
import { compileAnswerSchema, LIMITS } from "../src/index.js";

// Copied from RESPONSE_FORMAT in packages/bench/src/prompt.ts, the schema the bench ran live against SERV.
const nullableString = { type: ["string", "null"] };
const invoiceSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pay", "hold", "reject"] },
    supplierId: nullableString,
    invoiceNumber: nullableString,
    amountUsd: { type: ["number", "null"] },
    dueDate: nullableString,
    clauses: { type: "array", items: { type: "string" } },
    flags: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["verdict", "supplierId", "invoiceNumber", "amountUsd", "dueDate", "clauses", "flags", "reason"],
  additionalProperties: false,
};

function nested(depth: number): Record<string, unknown> {
  return depth <= 1 ? { type: "string" } : { type: "object", properties: { a: nested(depth - 1) } };
}

function ofBytes(bytes: number): Record<string, unknown> {
  const base = JSON.stringify({ type: "object", description: "" }).length;
  return { type: "object", description: "a".repeat(bytes - base) };
}

function rejected(schema: unknown): string {
  const r = compileAnswerSchema(schema);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.errors.join("; ");
}

describe("compileAnswerSchema", () => {
  it("accepts the bench invoice schema, type arrays included, and validates with it", () => {
    const r = compileAnswerSchema(invoiceSchema);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const answer = { verdict: "pay", supplierId: null, invoiceNumber: "INV-1", amountUsd: 12.5, dueDate: null, clauses: ["R1"], flags: [], reason: "ok" };
    expect(r.validate(answer)).toBe(true);
    expect(r.validate({ ...answer, verdict: "maybe" })).toBe(false);
    expect(r.validate({ ...answer, extra: 1 })).toBe(false);
  });

  it.each([
    ["pattern", { type: "object", properties: { a: { type: "string", pattern: "^(a+)+$" } } }],
    ["$ref", { type: "object", properties: { a: { $ref: "https://example.com/s.json" } } }],
    ["format", { type: "object", properties: { a: { type: "string", format: "email" } } }],
    ["patternProperties", { type: "object", patternProperties: { "^(a+)+$": { type: "string" } } }],
    ["x-unknown", { type: "object", properties: { a: { type: "string", "x-unknown": true } } }],
  ])("rejects the %s keyword", (keyword, schema) => {
    expect(rejected(schema)).toContain(`keyword "${keyword}" is not allowed`);
  });

  it("rejects a keyword hidden inside anyOf, items and additionalProperties", () => {
    expect(rejected({ type: "object", properties: { a: { anyOf: [{ type: "string", pattern: "x" }] } } })).toContain('"pattern"');
    expect(rejected({ type: "object", properties: { a: { type: "array", items: { $ref: "#" } } } })).toContain('"$ref"');
    expect(rejected({ type: "object", additionalProperties: { type: "string", format: "uri" } })).toContain('"format"');
  });

  it(`accepts depth ${LIMITS.schemaMaxDepth} and rejects depth ${LIMITS.schemaMaxDepth + 1}`, () => {
    expect(compileAnswerSchema(nested(LIMITS.schemaMaxDepth)).ok).toBe(true);
    expect(rejected(nested(LIMITS.schemaMaxDepth + 1))).toContain("nested deeper");
  });

  it(`accepts ${LIMITS.schemaMaxBytes} bytes and rejects ${LIMITS.schemaMaxBytes + 1}`, () => {
    expect(compileAnswerSchema(ofBytes(LIMITS.schemaMaxBytes)).ok).toBe(true);
    expect(rejected(ofBytes(LIMITS.schemaMaxBytes + 1))).toContain(`is ${LIMITS.schemaMaxBytes + 1} bytes`);
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "object"],
    ["a boolean schema", true],
    ["an array-typed root", { type: "array", items: { type: "string" } }],
    ["a root with no type", { properties: { a: { type: "string" } } }],
  ])("rejects %s as the root", (_label, schema) => {
    expect(rejected(schema)).toContain("root");
  });

  it("rejects enum and const values that hide nesting outside the walk", () => {
    expect(rejected({ type: "object", properties: { a: { enum: [{ deep: { deeper: 1 } }] } } })).toContain("enum");
    expect(rejected({ type: "object", properties: { a: { const: [1, [2]] } } })).toContain("const");
  });
});
