/*
 * The words and numbers the UX pass changed, checked as plain functions. Not covered here: how the
 * pages look, the /try hero button and the per-case toggle in a browser, and the beforeunload
 * prompt, which the Playwright pass and a read of the code cover.
 */
import { createRequire } from "node:module";
import type { RunConfig } from "@urai/engine";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCases } from "../components/new/cases";
import { EMPTY_COMPARE, EMPTY_DRAFT, type Draft } from "../components/new/draft";
import { draftHasInput, loadForm, saveForm } from "../components/new/persist";
import { configLabels, evidenceText, modeNote, servTerms, summarize, summaryText } from "../components/report/format";
import { Outcome, verdictSentence } from "../components/try/outcome";
import { configLabels as tryLabels } from "../components/try/types";
import type { ConfigTotals, Report } from "../lib/report";

const off: RunConfig = { model: "gpt-6-luna", mode: "raw" };
const plain: RunConfig = { model: "gpt-6-luna", mode: "plain" };
const full: RunConfig = { model: "gpt-6-luna", mode: "full" };

describe("SERV terms", () => {
  it("calls a single SERV mode SERV on", () => {
    expect(configLabels([off, plain])).toEqual(["SERV off", "SERV on"]);
    expect(configLabels([plain])).toEqual(["SERV on"]);
    expect(tryLabels([off, plain])).toEqual(["SERV off", "SERV on"]);
  });

  it("names the modes and defines plain when two SERV modes sit side by side", () => {
    expect(configLabels([off, plain, full])).toEqual(["SERV off", "SERV plain", "SERV full"]);
    expect(modeNote([off, plain, full])).toBe(
      "SERV plain means SERV's reasoning on, with its output filter off (Urai always switches it off so answers that quote the rules are not cut), nothing else added.",
    );
    expect(modeNote([off, plain])).toBeNull();
  });

  it("keeps the Multipath name when it is the only SERV mode, with the model in front on two models", () => {
    const multi: RunConfig = { model: "gpt-6-luna", mode: "multipath" };
    const multiSol: RunConfig = { model: "gpt-6-sol", mode: "multipath" };
    expect(configLabels([off, multi])).toEqual(["SERV off", "SERV Multipath"]);
    expect(configLabels([off, multiSol])).toEqual(["gpt-6-luna, SERV off", "gpt-6-sol, SERV Multipath"]);
    expect(configLabels([off, { model: "gpt-6-luna", mode: "guard" }])).toEqual(["SERV off", "SERV with PromptGuard"]);
    expect(configLabels([full])).toEqual(["SERV full"]);
    expect(tryLabels([off, multi])).toEqual(["SERV off", "SERV Multipath"]);
    expect(tryLabels([off, multiSol])).toEqual(["gpt-6-luna, SERV off", "gpt-6-sol, SERV Multipath"]);
    expect(tryLabels([off, { model: "gpt-6-sol", mode: "plain" }])).toEqual(["gpt-6-luna, SERV off", "gpt-6-sol, SERV on"]);
  });

  it("reads SERV plain in a stored run name as SERV on when it is the only mode", () => {
    expect(servTerms("Before the fix: data in the prompt, SERV plain", [plain])).toBe("Before the fix: data in the prompt, SERV on");
    expect(servTerms("A: SERV plain", [plain, full])).toBe("A: SERV plain");
  });
});

function totals(accuracy: number, input: number, output: number): ConfigTotals {
  return {
    accuracy,
    correct: 0,
    calls: 0,
    inputTokens: input,
    outputTokens: output,
    estCostUsd: null,
    meanLatencyMs: null,
    statusCounts: {},
  } as unknown as ConfigTotals;
}

describe("token basis", () => {
  it("compares total tokens, input plus output, and says fewer tokens", () => {
    // Input alone is equal; the totals differ by output only, so an input-only sentence would say "the same".
    const report = {
      configs: [off, plain],
      totals: [totals(1, 1000, 1000), totals(0.95, 1000, 500)],
      cases: [],
    } as unknown as Report;
    expect(summaryText(summarize(report))).toContain("using 25% fewer tokens");
  });
});

describe("try verdict", () => {
  const col = (right: number, back: number, tokens: number | null) => ({ back, right, wrong: back - right, accuracy: right / back, tokens });

  it("says which setting scored higher, by how much, and the token difference", () => {
    const out = verdictSentence([off, plain] as never, [col(20, 20, 10000), col(19, 20, 8800)]);
    expect(out).toBe("SERV off scored higher, 100% against 95% for SERV on, 5 points ahead, and SERV on used 12% fewer tokens.");
  });

  it("drops the token clause when a count is missing", () => {
    expect(verdictSentence([off, plain] as never, [col(10, 20, null), col(12, 20, 100)])).toBe(
      "SERV on scored higher, 60% against 50% for SERV off, 10 points ahead.",
    );
  });
});

// react-dom ships no type declarations here, so the one function used is loaded with its signature written out.
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as { renderToString: (node: ReactNode) => string };

describe("try end state", () => {
  it("shows the verdict sentence, the tokens line and Test your agent next to the saved report", () => {
    const col = (right: number, back: number, tokens: number) => ({ back, right, wrong: back - right, accuracy: right / back, tokens });
    const sample = {
      workloadId: "sample-invoices-good",
      name: "The same agent, set up right",
      line: "",
      configs: [off, plain],
      expected: {},
      saved: { reportId: "EcaTkn78IZ3bLHi0BJcXAg", title: "t", cases: 40, columns: [] },
    };
    // React marks the seams between text parts with empty comments; a reader never sees them.
    const html = renderToString(
      createElement(Outcome, {
        finish: { kind: "done", reportId: "abc" },
        sample: sample as never,
        samples: [sample as never],
        configs: [off, plain] as never,
        totals: [col(20, 20, 10000), col(19, 20, 8800)],
        onReset: () => {},
        onRetryShare: () => {},
        onResume: () => {},
      }),
    ).replaceAll("<!-- -->", "");
    expect(html).toContain("SERV off scored higher, 100% against 95% for SERV on, 5 points ahead, and SERV on used 12% fewer tokens.");
    expect(html).toContain("Tokens, input plus output");
    expect(html).toContain("10,000");
    expect(html).toContain("Compare with the saved 40-case run");
    expect(html).toContain('href="/new"');
    expect(html).toContain("Test your agent");
  });
});

describe("setup evidence", () => {
  it("cuts a shortened quote back to a whole word", () => {
    expect(evidenceText({ id: "quotes-instructions", evidence: "cite the clause number and the supplier bo..." })).toBe(
      "cite the clause number and the supplier...",
    );
  });

  it("trims a template quote at both ends", () => {
    expect(evidenceText({ id: "templated-system-prompt", evidence: "ules apply. The invoice is {{input}} and you must deci" })).toBe(
      "...apply. The invoice is {{input}} and you must...",
    );
  });

  it("trims the prompt quote inside the quoting finding", () => {
    expect(
      evidenceText({ id: "quotes-instructions", evidence: 'answer fields: clauses; prompt: "ull if the invoice does not state them. Cite every clause. Put short machine-r"' }),
    ).toBe('answer fields: clauses; prompt: "...if the invoice does not state them. Cite every clause. Put short..."');
  });

  it("leaves whole evidence alone", () => {
    expect(evidenceText({ id: "strict-schema", evidence: "answer, reason" })).toBe("answer, reason");
  });
});

describe("case problems", () => {
  const limits = { casesMax: 40, caseIdMaxChars: 64, caseInputMaxChars: 20000 };
  const scoring = [{ field: "verdict", rule: "exact" as const }];

  it("names the case by id and says what to add", () => {
    const out = parseCases(JSON.stringify([{ id: "INV-03", input: "x" }]), scoring, limits);
    expect(out.problems).toEqual([{ where: "Case INV-03", message: 'add "expected": { "verdict": the right answer }' }]);
  });

  it("names a missing expected field and a CSV case by id, never by row alone", () => {
    const json = parseCases(JSON.stringify([{ id: "INV-04", input: "x", expected: {} }]), scoring, limits);
    expect(json.problems[0]).toEqual({ where: "Case INV-04", message: 'add "verdict" to expected, with the right answer for this case' });
    const csv = parseCases("id,input,expected.verdict\nINV-05,hello,\n", scoring, limits);
    expect(csv.problems[0]!.where).toBe("Case INV-05");
    expect(csv.problems[0]!.message).toBe("fill in expected.verdict with the right answer for this case");
  });
});

describe("builder form in sessionStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(): Map<string, string> {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  const draft: Draft = {
    ...EMPTY_DRAFT,
    name: "Invoices",
    systemPrompt: "Rules",
    scoring: [{ key: 1, field: "verdict", rule: "exact", tolerance: "" }],
    casesText: "[]",
  };

  it("keeps every field and gives it back", () => {
    stubStorage();
    saveForm({ draft, loaded: "good", model: "gpt-6-luna", modes: ["raw", "plain"], compare: { model: "gpt-6-astra", mode: "guard" } });
    const back = loadForm();
    expect(back?.draft.name).toBe("Invoices");
    expect(back?.draft.scoring.map((r) => r.field)).toEqual(["verdict"]);
    expect(back?.loaded).toBe("good");
    expect(back?.modes).toEqual(["raw", "plain"]);
    expect(back?.compare).toEqual({ model: "gpt-6-astra", mode: "guard" });
  });

  it("reads a form saved before the second model existed as having none, and drops an unknown mode", () => {
    const store = stubStorage();
    store.set("urai.new.form", JSON.stringify({ draft: { ...draft, scoring: [] }, loaded: null, model: "m", modes: ["raw"] }));
    expect(loadForm()?.compare).toEqual(EMPTY_COMPARE);
    store.set("urai.new.form", JSON.stringify({ draft: { ...draft, scoring: [] }, loaded: null, model: "m", modes: ["raw"], compare: { model: "x", mode: "turbo" } }));
    expect(loadForm()?.compare).toEqual({ model: "x", mode: "raw" });
  });

  it("never stores a key, even when one is passed on the object", () => {
    const store = stubStorage();
    saveForm({ draft, loaded: null, model: "m", modes: [], compare: EMPTY_COMPARE, key: "sk-canary-0000000000" } as never);
    expect([...store.values()].join("")).not.toContain("sk-canary");
  });

  it("refuses a stored form of the wrong shape", () => {
    const store = stubStorage();
    store.set("urai.new.form", JSON.stringify({ draft: { name: 1 } }));
    expect(loadForm()).toBeNull();
  });

  it("counts typed input and ignores an empty form", () => {
    expect(draftHasInput(EMPTY_DRAFT)).toBe(false);
    expect(draftHasInput(draft)).toBe(true);
  });
});
