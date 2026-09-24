// Regression tests for two head-chef fixes; does not cover the rest of the lint or request rules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRequest, findDataBlocks, lintWorkload, parseWorkload } from "../src/index.js";

const load = (name: string) => {
  const parsed = parseWorkload(JSON.parse(readFileSync(new URL(`../workloads/${name}.json`, import.meta.url), "utf8")));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.workload;
};

describe("CSV detector ignores prose bullets", () => {
  it("does not flag the hard sample rulebook as data", () => {
    const hard = load("invoices-hard");
    expect(lintWorkload(hard).some((f) => f.id === "data-in-system-prompt")).toBe(false);
  });

  it("still finds a real CSV block", () => {
    const csv = ["Rules first.", "", "sku,name,price", "A1,Hub,240", "A2,Plan,180", "A3,Cable,12", "A4,Case,30"].join("\n");
    expect(findDataBlocks(csv).map((b) => b.kind)).toContain("csv");
  });

  it("skips comma-heavy list items", () => {
    const bullets = Array.from({ length: 5 }, (_, i) => `- Source ${i}, the company policy, which applies first`).join("\n");
    expect(findDataBlocks(bullets).filter((b) => b.kind === "csv")).toHaveLength(0);
  });
});

describe("one model id policy", () => {
  it("sends a mixed-case model id in lowercase", () => {
    const w = load("invoices-good");
    const req = buildRequest(w, w.cases[0]!, { model: "  GPT-6-Luna ", mode: "multipath" });
    expect(req.body.model).toBe("gpt-6-luna-serv-multipath");
  });
});
