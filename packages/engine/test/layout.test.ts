// Not covered here: which blocks count as data (lint.test.ts), and whether SERV scores the rewritten workload better (scripts/prove-fix.ts runs that live).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyLayoutFix, findDataBlocks, LIMITS, lintWorkload, parseWorkload, type Workload } from "../src/index.js";

const WORKLOADS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workloads");

function sample(name: string): Workload {
  const parsed = parseWorkload(JSON.parse(readFileSync(path.join(WORKLOADS, name), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.workload;
}

function workload(systemPrompt: string, context: string | null): Workload {
  return {
    name: "layout test",
    systemPrompt,
    context,
    answerSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false },
    shadowHint: null,
    scoring: [{ field: "verdict", rule: "exact" }],
    cases: [{ id: "c1", input: "x", expected: { verdict: "pay" } }],
  };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const TABLE = "| supplier | rate |\n| --- | --- |\n| Acme | 120 |";
const RECORDS = Array.from({ length: 5 }, (_, i) => `ann${i}@example.com 0x${String(i).repeat(40)}`).join("\n");

describe("applyLayoutFix", () => {
  it("turns invoices-bad's system prompt into invoices-good's, byte for byte, by moving the supplier book", () => {
    const bad = sample("invoices-bad.json");
    const { workload: fixed, moved } = applyLayoutFix(bad);
    expect(sha256(fixed.systemPrompt)).toBe(sha256(sample("invoices-good.json").systemPrompt));

    const book = bad.systemPrompt.slice(findDataBlocks(bad.systemPrompt)[0]!.start);
    expect(moved).toStrictEqual([{ heading: "SUPPLIER BOOK", kind: "json", chars: book.length }]);
    expect(fixed.context).toBe(`${bad.context}\n\nSUPPLIER BOOK\n${book}`);
    expect(JSON.parse(book).map((s: { id: string }) => s.id)).toContain("sup_08");
    expect(lintWorkload(fixed).map((f) => f.id)).not.toContain("data-in-system-prompt");
  });

  it("never mutates its input and returns a new workload (C21)", () => {
    const bad = sample("invoices-bad.json");
    const before = JSON.stringify(bad);
    deepFreeze(bad);
    const { workload: fixed } = applyLayoutFix(bad);
    expect(JSON.stringify(bad)).toBe(before);
    expect(fixed).not.toBe(bad);
    expect(fixed.cases).not.toBe(bad.cases);
    expect(fixed.answerSchema).not.toBe(bad.answerSchema);
  });

  it("returns a workload that passes parseWorkload (C21)", () => {
    const { workload: fixed } = applyLayoutFix(sample("invoices-bad.json"));
    const reparsed = parseWorkload(JSON.parse(JSON.stringify(fixed)));
    expect(reparsed.ok && reparsed.workload).toStrictEqual(fixed);
  });

  it("moves two blocks with their headings and the blank line before each, and labels a block with no heading DATA", () => {
    const prompt = `Rules A.\n\nRATES:\n${TABLE}\n\nMore rules.\n\n${RECORDS}\n\nEnd.`;
    const { workload: fixed, moved } = applyLayoutFix(workload(prompt, "today is 2026-09-23"));
    expect(fixed.systemPrompt).toBe("Rules A.\n\nMore rules.\n\nEnd.");
    expect(fixed.context).toBe(`today is 2026-09-23\n\nRATES:\n${TABLE}\n\nDATA\n${RECORDS}`);
    expect(moved).toStrictEqual([
      { heading: "RATES:", kind: "table", chars: TABLE.length },
      { heading: null, kind: "records", chars: RECORDS.length },
    ]);
  });

  it("uses the blank line after a block when there is none before it, and starts context fresh when it was null", () => {
    const { workload: fixed } = applyLayoutFix(workload(`## Rates\n${TABLE}\n\nDecide pay or hold.`, null));
    expect(fixed.systemPrompt).toBe("Decide pay or hold.");
    expect(fixed.context).toBe(`## Rates\n${TABLE}`);
  });

  it("returns an equal copy and moves nothing when the prompt holds no data", () => {
    const good = sample("invoices-good.json");
    const { workload: fixed, moved } = applyLayoutFix(good);
    expect(moved).toStrictEqual([]);
    expect(fixed).toStrictEqual(good);
    expect(fixed).not.toBe(good);
  });

  it("throws rather than return a workload that would fail parseWorkload", () => {
    const tooMuch = workload(`Decide.\n\nRATES:\n${TABLE}`, "c".repeat(LIMITS.contextMaxChars));
    expect(() => applyLayoutFix(tooMuch)).toThrow(/not valid/);
    expect(() => applyLayoutFix(workload(TABLE, null))).toThrow(/systemPrompt/);
  });
});
