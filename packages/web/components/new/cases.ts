import type { ExpectedValue, ScoreRule, WorkloadCase } from "@urai/engine";
import { parseCsv } from "./csv";
import { jsonErrorAt } from "./json-error";

export interface CaseLimits {
  casesMax: number;
  caseIdMaxChars: number;
  caseInputMaxChars: number;
}

export interface CaseProblem {
  /** "Row 4" for CSV, "Case 4" for JSON, or null when the problem is with the whole paste. */
  where: string | null;
  message: string;
}

export interface CasesParse {
  format: "json" | "csv" | "empty";
  cases: WorkloadCase[];
  problems: CaseProblem[];
}

const CASE_ID = /^[A-Za-z0-9_-]+$/;
// The same strict grouping the engine's number normaliser accepts, so "1,2,3" is never read as 123.
const NUMERIC = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const EXPECTED_PREFIX = "expected.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkId(id: string, seen: Set<string>, limits: CaseLimits): string | null {
  if (id === "") return "id is empty";
  if (id.length > limits.caseIdMaxChars || !CASE_ID.test(id)) {
    return `id "${id.slice(0, 40)}" must be 1 to ${limits.caseIdMaxChars} characters of A-Z, a-z, 0-9, _ or -`;
  }
  if (seen.has(id)) return `id "${id}" is used by an earlier case`;
  return null;
}

/** One CSV cell as the value its scoring rule expects, or a sentence saying what is wrong. */
function cellValue(raw: string, rule: ScoreRule): { value: ExpectedValue } | { problem: string } {
  const cell = raw.trim();
  if (cell === "") return { problem: `expected.${rule.field} is empty` };
  if (rule.rule === "number") {
    if (!NUMERIC.test(cell)) return { problem: `expected.${rule.field} must be a number, got "${cell.slice(0, 30)}"` };
    return { value: Number(cell.replace(/,/g, "")) };
  }
  if (rule.rule === "oneOf") {
    const options = cell.split("|").map((o) => o.trim()).filter((o) => o !== "");
    return options.length === 0 ? { problem: `expected.${rule.field} needs at least one option` } : { value: options };
  }
  return { value: cell };
}

function fromCsv(text: string, scoring: ScoreRule[], limits: CaseLimits): CasesParse {
  const { records, problems: csvProblems } = parseCsv(text);
  const problems: CaseProblem[] = csvProblems.map((p) => ({ where: `Row ${p.row}`, message: p.message }));
  const header = records[0];
  if (header === undefined) return { format: "csv", cases: [], problems };

  const names = header.cells.map((c) => c.trim());
  const idCol = names.indexOf("id");
  const inputCol = names.indexOf("input");
  if (idCol === -1 || inputCol === -1) {
    problems.unshift({ where: `Row ${header.row}`, message: 'the header needs an "id" and an "input" column' });
  }
  if (scoring.length === 0) {
    problems.unshift({ where: null, message: "Add a scoring rule under Answer shape first, so the expected columns can be read." });
  }

  const ruleCols: { col: number; rule: ScoreRule }[] = [];
  names.forEach((name, col) => {
    if (col === idCol || col === inputCol) return;
    if (!name.startsWith(EXPECTED_PREFIX)) {
      problems.push({ where: `Row ${header.row}`, message: `column "${name.slice(0, 40)}" is not id, input or expected.<field>` });
      return;
    }
    const field = name.slice(EXPECTED_PREFIX.length);
    const rule = scoring.find((r) => r.field === field);
    if (rule === undefined) {
      problems.push({ where: `Row ${header.row}`, message: `column "${name.slice(0, 40)}" has no scoring rule; add one under Answer shape or remove the column` });
    } else {
      ruleCols.push({ col, rule });
    }
  });
  for (const r of scoring) {
    if (!names.includes(EXPECTED_PREFIX + r.field)) {
      problems.push({ where: `Row ${header.row}`, message: `add a column "expected.${r.field}" for the scored field ${r.field}` });
    }
  }
  if (idCol === -1 || inputCol === -1) return { format: "csv", cases: [], problems };

  const cases: WorkloadCase[] = [];
  const seen = new Set<string>();
  for (const rec of records.slice(1)) {
    const where = `Row ${rec.row}`;
    if (rec.cells.length !== names.length) {
      problems.push({ where, message: `has ${rec.cells.length} cells, the header has ${names.length}` });
      continue;
    }
    const rowProblems: string[] = [];
    const id = rec.cells[idCol]!.trim();
    const idProblem = checkId(id, seen, limits);
    if (idProblem !== null) rowProblems.push(idProblem);
    const input = rec.cells[inputCol]!;
    if (input.trim() === "") rowProblems.push("input is empty");
    if (input.length > limits.caseInputMaxChars) rowProblems.push(`input is ${input.length} characters, the limit is ${limits.caseInputMaxChars}`);

    const expected: Record<string, ExpectedValue> = {};
    for (const { col, rule } of ruleCols) {
      const got = cellValue(rec.cells[col]!, rule);
      if ("problem" in got) rowProblems.push(got.problem);
      else expected[rule.field] = got.value;
    }
    if (rowProblems.length > 0) {
      problems.push({ where, message: rowProblems.join("; ") });
      continue;
    }
    seen.add(id);
    cases.push({ id, input, expected });
  }
  if (cases.length + problems.length === 0) problems.push({ where: null, message: "The CSV has a header but no case rows." });
  if (cases.length > limits.casesMax) problems.push({ where: null, message: `${cases.length} cases, the limit is ${limits.casesMax}` });
  return { format: "csv", cases, problems };
}

const EXPECTED_TYPES = (v: unknown): v is ExpectedValue =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

function fromJson(text: string, scoring: ScoreRule[], limits: CaseLimits): CasesParse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { format: "json", cases: [], problems: [{ where: null, message: `Not valid JSON: ${jsonErrorAt(text, err)}` }] };
  }
  if (!Array.isArray(data)) {
    return { format: "json", cases: [], problems: [{ where: null, message: "Paste a JSON array of cases: [ { \"id\": ..., \"input\": ..., \"expected\": { ... } } ]" }] };
  }
  if (data.length > limits.casesMax) {
    return { format: "json", cases: [], problems: [{ where: null, message: `${data.length} cases, the limit is ${limits.casesMax}` }] };
  }

  const problems: CaseProblem[] = [];
  const cases: WorkloadCase[] = [];
  const seen = new Set<string>();
  const scored = new Set(scoring.map((r) => r.field));
  data.forEach((item: unknown, i) => {
    const where = `Case ${i + 1}`;
    if (!isRecord(item)) {
      problems.push({ where, message: "must be an object with id, input and expected" });
      return;
    }
    const rowProblems: string[] = [];
    const extra = Object.keys(item).filter((k) => k !== "id" && k !== "input" && k !== "expected");
    if (extra.length > 0) rowProblems.push(`only id, input and expected are allowed, found ${extra.slice(0, 3).join(", ")}`);
    const id = typeof item.id === "string" ? item.id : "";
    if (typeof item.id !== "string") rowProblems.push("id must be a string");
    else {
      const idProblem = checkId(id, seen, limits);
      if (idProblem !== null) rowProblems.push(idProblem);
    }
    if (typeof item.input !== "string") rowProblems.push("input must be a string");
    else if (item.input.length > limits.caseInputMaxChars) rowProblems.push(`input is ${item.input.length} characters, the limit is ${limits.caseInputMaxChars}`);

    const expected: Record<string, ExpectedValue> = {};
    if (!isRecord(item.expected)) rowProblems.push("expected must be an object of field: value");
    else {
      for (const [field, v] of Object.entries(item.expected)) {
        if (!scored.has(field)) rowProblems.push(`expected.${field} has no scoring rule`);
        else if (!EXPECTED_TYPES(v)) rowProblems.push(`expected.${field} must be a string, number, true, false, null or a list of strings`);
        else expected[field] = v;
      }
      for (const field of scored) {
        if (!Object.hasOwn(item.expected, field)) rowProblems.push(`expected.${field} is missing`);
      }
    }
    if (rowProblems.length > 0) {
      problems.push({ where, message: rowProblems.join("; ") });
      return;
    }
    seen.add(id);
    cases.push({ id, input: item.input as string, expected });
  });
  if (data.length === 0) problems.push({ where: null, message: "The array is empty. Add at least one case." });
  return { format: "json", cases, problems };
}

/**
 * Turns what the team pasted or uploaded into cases. Text that starts with "[" is read as a JSON
 * array; anything else as CSV with the columns id, input and expected.<field>. Every problem is
 * reported with the row or case it sits in, so the fix can be made in the source file.
 */
export function parseCases(text: string, scoring: ScoreRule[], limits: CaseLimits): CasesParse {
  const trimmed = text.trim();
  if (trimmed === "") return { format: "empty", cases: [], problems: [] };
  return trimmed.startsWith("[") ? fromJson(trimmed, scoring, limits) : fromCsv(text, scoring, limits);
}
