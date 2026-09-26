// Not covered here: the layout rewrite (layout.test.ts), the live model list (models.test.ts), and whether SERV really drops data from these prompts (scripts/prove-fix.ts measures that live).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findDataBlocks, LIMITS, lintWorkload, parseWorkload, type LintFinding, type RunConfig, type Workload } from "../src/index.js";

const WORKLOADS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workloads");

function sample(name: string): Workload {
  const parsed = parseWorkload(JSON.parse(readFileSync(path.join(WORKLOADS, name), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.workload;
}

function workload(systemPrompt: string, answerSchema?: Record<string, unknown>): Workload {
  return {
    name: "lint test",
    systemPrompt,
    context: null,
    answerSchema: answerSchema ?? {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
    shadowHint: null,
    scoring: [{ field: "verdict", rule: "exact" }],
    cases: [{ id: "c1", input: "x", expected: { verdict: "pay" } }],
  };
}

const ids = (fs: LintFinding[]) => fs.map((f) => f.id);
const find = (fs: LintFinding[], id: LintFinding["id"]) => fs.find((f) => f.id === id);
const LUNA: RunConfig[] = [{ model: "gpt-6-luna", mode: "plain" }];

const JSON_BLOCK = JSON.stringify(
  Array.from({ length: 4 }, (_, i) => ({ id: `sup_0${i}`, name: `Supplier ${i}`, payout: `0x${String(i).repeat(40)}` })),
  null,
  2,
);
const TABLE = "| supplier | rate |\n| --- | --- |\n| Acme | 120 |";
const CSV = "id,name,rate\n1,Acme,120\n2,Bolt,140\n3,Crane,90";
const TSV = "id\tname\trate\n1\tAcme\t120\n2\tBolt\t140\n3\tCrane\t90";
const RECORDS = Array.from({ length: 5 }, (_, i) => `Person ${i} ann${i}@example.com joined 2026-0${i + 1}-15`).join("\n");

describe("findDataBlocks", () => {
  it.each([
    ["json", `SUPPLIERS:\n${JSON_BLOCK}`, "SUPPLIERS:"],
    ["table", `## Rates\n${TABLE}`, "## Rates"],
    ["csv", `RATE CARD\n${CSV}`, "RATE CARD"],
    ["csv", `Rates:\n${TSV}`, "Rates:"],
    ["records", `Contacts:\n${RECORDS}`, "Contacts:"],
  ])("finds a %s block and its heading", (kind, block, heading) => {
    const prompt = `Decide every invoice by the rules.\n\n${block}\n\nAnswer in JSON.`;
    const found = findDataBlocks(prompt);
    expect(found).toHaveLength(1);
    const b = found[0]!;
    expect(b).toMatchObject({ kind, heading });
    expect(prompt.slice(b.start, b.end)).toBe(block.slice(heading.length + 1));
  });

  it.each([
    ["JSON under 200 characters", '[\n  {"id": "sup_01"}\n]'],
    ["a bracket block that is not JSON", `[\n${"not json, ".repeat(30)}\n]`],
    ["JSON with text after the closing bracket", `${JSON_BLOCK} and more text`],
    ["a table of two rows", "| a | b |\n| - | - |"],
    ["three CSV lines", "a,b,c\n1,2,3\n4,5,6"],
    ["CSV lines with different comma counts", "a,b,c\n1,2\n4,5,6,7\n8,9,0"],
    ["four record lines", RECORDS.split("\n").slice(0, 4).join("\n")],
    ["record lines with one kind of value each", Array.from({ length: 6 }, (_, i) => `Invoice total 1200${i} USD`).join("\n")],
  ])("finds nothing in %s", (_label, text) => {
    expect(findDataBlocks(`Rules.\n\n${text}\n\nMore rules.`)).toStrictEqual([]);
  });

  it("takes no heading from a plain sentence or across a blank line", () => {
    expect(findDataBlocks(`Here is the list\n${CSV}`)[0]!.heading).toBeNull();
    expect(findDataBlocks(`RATES\n\n${CSV}`)[0]!.heading).toBeNull();
  });

  it("finds the supplier book in invoices-bad, with a span covering exactly the book", () => {
    const sp = sample("invoices-bad.json").systemPrompt;
    const found = findDataBlocks(sp);
    expect(found).toHaveLength(1);
    const marker = "\n\nSUPPLIER BOOK\n";
    expect(found[0]).toStrictEqual({ start: sp.indexOf(marker) + marker.length, end: sp.length, heading: "SUPPLIER BOOK", kind: "json" });
    expect(JSON.parse(sp.slice(found[0]!.start, found[0]!.end))).toHaveLength(8);
  });

  it("finds nothing in invoices-good", () => {
    expect(findDataBlocks(sample("invoices-good.json").systemPrompt)).toStrictEqual([]);
  });
});

describe("lintWorkload rules", () => {
  it("data-in-system-prompt fires on invoices-bad as a fixable error with the book's span, and not on invoices-good", () => {
    const bad = sample("invoices-bad.json");
    const f = find(lintWorkload(bad, { configs: LUNA }), "data-in-system-prompt")!;
    expect(f).toMatchObject({ severity: "error", fixable: true, spans: findDataBlocks(bad.systemPrompt).map(({ start, end }) => ({ start, end })) });
    expect(f.detail).toContain("94% to 66-72%");
    expect(ids(lintWorkload(sample("invoices-good.json"), { configs: LUNA }))).not.toContain("data-in-system-prompt");
  });

  it.each([
    ["a snake_case part", { section_id: { type: "string" } }],
    ["a camelCase part", { citedClauses: { type: "array", items: { type: "string" } } }],
    ["an acronym then a word", { HTTPReference: { type: "string" } }],
  ])("quotes-instructions fires on an answer field with %s", (_label, props) => {
    const schema = { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
    expect(find(lintWorkload(workload("Decide.", schema)), "quotes-instructions")).toMatchObject({ severity: "warning", fixable: false });
  });

  it("quotes-instructions fires when the prompt asks to quote, and not for words that only contain the list words", () => {
    const f = find(lintWorkload(workload("Quote the rule you used.")), "quotes-instructions")!;
    expect(f.spans).toStrictEqual([{ start: 0, end: 5 }]);
    const schema = { type: "object", properties: { rulebookName: { type: "string" }, quotation: { type: "string" } }, required: ["rulebookName", "quotation"], additionalProperties: false };
    expect(ids(lintWorkload(workload("Decide pay or hold. Mention the quotation number.", schema)))).not.toContain("quotes-instructions");
  });

  it("strict-schema fires for a gpt- model when a nested object is loose, and not for other models or a strict schema", () => {
    const loose = {
      type: "object",
      properties: { verdict: { type: "string" }, payee: { type: "object", properties: { name: { type: "string" } }, required: [] } },
      required: ["verdict", "payee"],
      additionalProperties: false,
    };
    const f = find(lintWorkload(workload("Decide.", loose), { configs: [{ model: " GPT-6-luna ", mode: "plain" }] }), "strict-schema")!;
    expect(f).toMatchObject({ severity: "warning", evidence: "answerSchema.properties.payee" });
    expect(ids(lintWorkload(workload("Decide.", loose), { configs: [{ model: "claude-haiku-4.5", mode: "plain" }] }))).not.toContain("strict-schema");
    expect(ids(lintWorkload(workload("Decide."), { configs: LUNA }))).not.toContain("strict-schema");
  });

  it("model-unknown fires for an id missing from a good list, after one trim and lowercase on both sides", () => {
    const models = { ok: true as const, models: [{ id: " GPT-6-Luna", inputUsdPerM: 0.13, outputUsdPerM: 0.65 }] };
    const configs: RunConfig[] = [{ model: "gpt-6-luna ", mode: "plain" }, { model: "gpt-9-nope", mode: "raw" }];
    const f = find(lintWorkload(workload("Decide."), { models, configs }), "model-unknown")!;
    expect(f).toMatchObject({ severity: "error", evidence: "gpt-9-nope" });
    expect(ids(lintWorkload(workload("Decide."), { models, configs: LUNA }))).not.toContain("model-unknown");
  });

  it("with a failed model list the check says model-unverified as info, never model-unknown (C18)", () => {
    const fs = lintWorkload(workload("Decide."), { models: { ok: false }, configs: [{ model: "gpt-9-nope", mode: "plain" }] });
    expect(find(fs, "model-unverified")).toMatchObject({ severity: "info", evidence: "gpt-9-nope" });
    expect(ids(fs)).not.toContain("model-unknown");
    expect(ids(lintWorkload(workload("Decide."), { configs: LUNA }))).not.toContain("model-unverified");
  });

  it.each(["Hello {{name}}.", "{% if vip %}Be kind.{% endif %}", "Today is ${today}."])("templated-system-prompt fires on %s", (prompt) => {
    expect(find(lintWorkload(workload(prompt)), "templated-system-prompt")?.severity).toBe("warning");
  });

  it("templated-system-prompt does not fire on single braces or a dollar amount", () => {
    expect(ids(lintWorkload(workload("Answer as {verdict}. Limit is $2,500.")))).not.toContain("templated-system-prompt");
  });

  it("first-sight-cost is always present as info", () => {
    for (const w of [workload("Decide."), sample("invoices-good.json")]) expect(find(lintWorkload(w), "first-sight-cost")?.severity).toBe("info");
  });

  it("full-mode-cost fires only when a config uses full mode", () => {
    expect(find(lintWorkload(workload("Decide."), { configs: [{ model: "gpt-6-luna", mode: "full" }] }), "full-mode-cost")?.severity).toBe("info");
    expect(ids(lintWorkload(workload("Decide."), { configs: [{ model: "gpt-6-luna", mode: "guard" }] }))).not.toContain("full-mode-cost");
  });

  it("large-system-prompt fires over 20,000 characters and not at 20,000", () => {
    expect(ids(lintWorkload(workload("a".repeat(20_001))))).toContain("large-system-prompt");
    expect(ids(lintWorkload(workload("a".repeat(20_000))))).not.toContain("large-system-prompt");
  });

  it("writes every number in evidence with thousands separators", () => {
    expect(find(lintWorkload(workload("a".repeat(21_337))), "large-system-prompt")?.evidence).toBe("21,337 characters, over 20,000");
    const data = `SUPPLIERS:\n${JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: `sup_${i}`, payout: `0x${"a".repeat(40)}` })), null, 2)}`;
    expect(find(lintWorkload(workload(data)), "data-in-system-prompt")?.evidence).toMatch(/^SUPPLIERS: \(json, \d{1,3}(,\d{3})+ characters\)$/);
    const over = lintWorkload(workload("a".repeat(LIMITS.systemPromptMaxChars + 1)));
    expect(over[0]?.evidence).toBe(`The system prompt is over the ${LIMITS.systemPromptMaxChars.toLocaleString("en-US")} character limit.`);
    expect(over[0]?.evidence).toMatch(/\d,\d{3}/);
  });

  it("orders findings errors first, then warnings, then info", () => {
    const fs = lintWorkload(sample("invoices-bad.json"), { configs: LUNA });
    expect(fs.map((f) => f.severity)).toStrictEqual(["error", "warning", "info", "info"]);
  });
});

describe("lint safety", () => {
  const N = LIMITS.systemPromptMaxChars;
  const nested = (k: number) => `${"[\n".repeat(k)}x${"\n]".repeat(k)}`;
  const adversarial: [string, string][] = [
    ["unclosed brackets", "[\n".repeat(N / 2)],
    ["nested brackets that never parse", `${nested(14_999)}   `],
    ["one line of quotes", '"'.repeat(N)],
    ["one line of pipes", "|".repeat(N)],
    ["table rows", "|a|\n".repeat(N / 4)],
    ["comma lines", ",,\n".repeat(N / 3)],
    ["tab lines", "\t\t\n".repeat(N / 3)],
    ["a long email domain", `a@${"a.".repeat(N / 2 - 2)}!!`],
    ["a long local part", `${"a".repeat(N - 2)}@!`],
    ["a long number", `${"1".repeat(N - 1)}x`],
    ["a long address", `0x${"a".repeat(N - 2)}`],
    ["a long date", `2026-01-01T${"1".repeat(N - 11)}`],
    ["trailing punctuation", `x${")".repeat(N - 2)}x`],
    ["cite without word breaks", "cite".repeat(N / 4)],
    ["cite words", "cite ".repeat(N / 5)],
    ["template markers", "{{".repeat(N / 2)],
    ["hashes", "#".repeat(N)],
    ["whitespace", " ".repeat(N)],
    ["newlines", "\n".repeat(N)],
  ];

  it.each(adversarial)("each detector finishes on %s at 60,000 characters in under 200 ms (C13)", (_label, text) => {
    expect(text.length).toBe(N);
    let t = performance.now();
    try {
      findDataBlocks(text);
    } catch {
      // A refusal is an allowed outcome here; only the time is under test.
    }
    expect(performance.now() - t).toBeLessThan(200);
    t = performance.now();
    lintWorkload(workload(text), { configs: LUNA });
    expect(performance.now() - t).toBeLessThan(200);
  });

  const couldNotRun = (fs: LintFinding[]) => {
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ severity: "error", title: "The setup check could not run", fixable: false, spans: [] });
  };

  it("fails closed on a prompt over the cap: findDataBlocks throws and the lint returns one error finding (C26)", () => {
    const over = "a".repeat(LIMITS.systemPromptMaxChars + 1);
    expect(() => findDataBlocks(over)).toThrow();
    couldNotRun(lintWorkload(workload(over)));
  });

  it("fails closed when the JSON parse budget runs out, when the prompt is not text, and on a schema past the depth cap (C26)", () => {
    const budgetBuster = nested(14_999);
    expect(() => findDataBlocks(budgetBuster)).toThrow();
    couldNotRun(lintWorkload(workload(budgetBuster)));
    couldNotRun(lintWorkload({ ...workload("x"), systemPrompt: 42 as unknown as string }));
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < LIMITS.schemaMaxDepth + 1; i++) deep = { type: "object", properties: { a: deep } };
    couldNotRun(lintWorkload(workload("Decide.", deep)));
    couldNotRun(lintWorkload(null as unknown as Workload));
  });
});
