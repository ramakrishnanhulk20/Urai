/*
 * The report components rendered to HTML with React's own server renderer, fed a report in which
 * every team, model and lint string is an HTML payload (threat model C20). Not covered here: the
 * page's database lookups (report.test.ts covers the loaders and routes), how the page looks, and
 * anything a browser extension does to the page after it loads.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { RunConfig } from "@urai/engine";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Disagreements } from "../components/report/disagreements";
import { EveryCase } from "../components/report/every-case";
import { Findings } from "../components/report/findings";
import { builderHref, SAMPLE_WORKLOADS, summarize, summaryText, usd } from "../components/report/format";
import { ReportSummary } from "../components/report/summary";
import { Verdict } from "../components/report/verdict";
import { WhatIsThis } from "../components/report/what-is-this";
import type { ConfigTotals, Report } from "../lib/report";

// react-dom ships no type declarations and @types/react-dom is not installed, so the one function
// used here is loaded with its signature written out.
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (node: ReactNode) => string;
};

const XSS = "<img src=x onerror=alert(1)>";
const RAW = "<img src=x";
const ESCAPED = "&lt;img";

const OFF: RunConfig = { model: "gpt-6-luna", mode: "raw", keepContentFilter: false };
const PLAIN: RunConfig = { model: "gpt-6-luna", mode: "plain", keepContentFilter: false };

function totals(patch: Partial<ConfigTotals>): ConfigTotals {
  return {
    calls: 2,
    scored: 2,
    correct: 1,
    accuracy: 0.5,
    statusCounts: { scored: 2 },
    meanLatencyMs: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    estCostUsd: 0.0123,
    ...patch,
  };
}

function hostileReport(): Report {
  return {
    name: `${XSS}: ${XSS}`,
    systemPrompt: { truncated: true, chars: 42_695, text: `Rules ${XSS}` },
    context: `Supplier book ${XSS}`,
    answerSchema: { type: "object" },
    configs: [OFF, PLAIN],
    totals: [
      totals({ correct: 2, accuracy: 1, inputTokens: 1000 }),
      totals({ correct: 0, accuracy: 0, inputTokens: 690, statusCounts: { scored: 1, filtered: 1 } }),
    ],
    balance: { before: 3.61, after: 3.58 },
    cases: [
      {
        id: `case-${XSS}`,
        input: `Invoice ${XSS}`,
        expected: { verdict: XSS, [`key${XSS}`]: [XSS, "pay"] },
        results: [
          {
            status: "scored",
            correct: true,
            answer: { verdict: XSS, reason: `Because ${XSS}`, nested: { deep: XSS } },
            answerTruncatedChars: null,
            answerText: XSS,
            latencyMs: 1500,
          },
          {
            status: "filtered",
            correct: false,
            answer: null,
            answerTruncatedChars: null,
            answerText: `Raw ${XSS}`,
            latencyMs: 900,
          },
        ],
      },
      {
        id: "c2",
        input: "second",
        expected: { verdict: "hold" },
        results: [
          {
            status: "scored",
            correct: true,
            answer: null,
            answerTruncatedChars: 5_321,
            answerText: `Too long ${XSS}`,
            latencyMs: 800,
          },
          null,
        ],
      },
    ],
    disagreements: [`case-${XSS}`],
    lint: [
      {
        id: "data-in-system-prompt",
        severity: "error",
        title: `Title ${XSS}`,
        detail: `Detail ${XSS}`,
        evidence: `Evidence ${XSS}`,
        fixable: true,
        spans: [],
      },
    ],
  };
}

function renderAll(report: Report): string {
  return renderToString(
    <>
      <ReportSummary report={report} />
      <WhatIsThis />
      <Verdict report={report} />
      <Disagreements report={report} />
      <Findings report={report} />
      <EveryCase report={report} />
    </>,
  );
}

describe("report components", () => {
  it("renders every team, model and lint string as escaped text, never as markup (C20)", () => {
    const html = renderAll(hostileReport());
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(RAW);
    // Each hostile field reached the page: name, input, expected, answer, reason, raw reply, finding.
    const needles = ["Invoice", "Because", "Raw", "Detail", "Title", "Evidence", "Rules", "Supplier book"];
    for (const needle of needles) expect(html).toContain(`${needle} ${ESCAPED}`);
  });

  it("has no raw HTML or markdown path anywhere in the report tree (C23 escaping)", () => {
    const dirs = [join(__dirname, "../components/report"), join(__dirname, "../app/r/[reportId]")];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
        const source = readFileSync(join(dir, file), "utf8");
        expect(source, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|from "[^"]*(markdown|mdx|remark|marked)[^"]*"/i);
      }
    }
  });

  it("marks everything the report cut, with the character counts", () => {
    const html = renderAll(hostileReport());
    expect(html).toContain("Cut at 34 characters, of 42,695");
    expect(html).toContain("Answer cut: it ran to 5,321 characters");
    expect(html).toContain("Not run yet");
    expect(html).toContain("Filtered");
  });

  it("writes the summary from the numbers, and unknown for a missing total, never zero", () => {
    const report = hostileReport();
    // One SERV mode reads "SERV on"; tokens are input plus output, 890 against 1,200.
    expect(summaryText(summarize(report))).toBe("SERV on scored 0% against 100% with SERV off, using 26% fewer tokens.");

    report.totals[0] = totals({ inputTokens: null, estCostUsd: null, meanLatencyMs: null });
    expect(summaryText(summarize(report))).toContain("token use is unknown");
    const html = renderToString(<Verdict report={report} />);
    expect(html).toContain("unknown");
    expect(html).not.toContain("$0.0000");
  });

  it("names the model in every setting of a two-model run, and shows each setting's cost per correct answer", () => {
    const report = hostileReport();
    report.configs = [{ ...OFF, model: "gpt-6-astra" }, PLAIN];
    report.totals = [totals({ correct: 2, accuracy: 1, estCostUsd: 0.02 }), totals({ correct: 0, accuracy: 0, estCostUsd: 0.001 })];
    const html = renderAll(report).replaceAll("<!-- -->", "");
    expect(html).toContain("gpt-6-astra, SERV off");
    expect(html).toContain("gpt-6-luna, SERV on");
    // The model is inside each label, so no separate model line repeats it under the setting's name.
    expect(html).not.toContain(">gpt-6-luna</span>");
    expect(html).toContain("Cost per correct answer");
    expect(html).toContain("$0.01");
    expect(html).toContain("no correct answers");
    expect(html).toContain("so it is an estimate in the same way");
    // The model changed too, so the heading does not credit SERV alone.
    expect(html).toContain(">What changed<");
    expect(html).not.toContain("What SERV changed");
  });

  it("gives an unknown cost its real reason: Urai does not price full, and SERV sent every count", () => {
    const report = hostileReport();
    report.configs = [OFF, { ...PLAIN, mode: "full" }];
    report.totals = [totals({ estCostUsd: 0.01 }), totals({ estCostUsd: null })];
    const html = renderToString(<Verdict report={report} />).replaceAll("<!-- -->", "");
    expect(html).toContain(">What SERV changed<");
    // Full is not plain, so its label keeps the mode name instead of reading "SERV on".
    expect(html).toContain("SERV full reads unknown: Urai does not price Multipath, full, or a model missing from the price list.");
    expect(html).not.toContain("SERV did not send token counts");
  });

  it("keeps the short labels and the model line on a one-model run", () => {
    const html = renderToString(<Verdict report={hostileReport()} />).replaceAll("<!-- -->", "");
    expect(html).toContain(">SERV off</h3>");
    expect(html).toContain(">SERV on</h3>");
    expect(html).toContain(">gpt-6-luna</span>");
  });

  it("sends a sample report's builder link to that sample, and any other report to the empty builder", () => {
    for (const sample of SAMPLE_WORKLOADS) {
      const file = JSON.parse(readFileSync(join(__dirname, `../../engine/workloads/invoices-${sample.slug}.json`), "utf8")) as { name: string; systemPrompt: string };
      expect(file.name).toBe(sample.name);
      expect(file.systemPrompt.length).toBe(sample.promptChars);
      // The report cuts a long prompt, so the match reads the full length it records.
      const cut = { name: file.name, systemPrompt: { truncated: true as const, chars: file.systemPrompt.length, text: "..." } };
      expect(builderHref(cut)).toBe(`/new?sample=${sample.slug}`);
    }
    const bad = SAMPLE_WORKLOADS[0];
    expect(builderHref({ name: bad.name, systemPrompt: "A team's own prompt under a borrowed name" })).toBe("/new");

    const report = hostileReport();
    report.name = bad.name;
    report.systemPrompt = { truncated: true, chars: bad.promptChars, text: "Rules" };
    expect(renderToString(<Findings report={report} />)).toContain('href="/new?sample=bad"');
    expect(renderToString(<Findings report={hostileReport()} />)).toContain('href="/new"');
  });

  it("formats money without trailing zeros past the cents", () => {
    expect(usd(0.1)).toBe("$0.10");
    expect(usd(0.0375)).toBe("$0.0375");
    expect(usd(3.61)).toBe("$3.61");
    expect(usd(null)).toBe("unknown");
  });
});
