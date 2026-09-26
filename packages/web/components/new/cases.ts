import type { ExpectedValue, ScoreRule, WorkloadCase } from "@urai/engine";
import { parseCsv } from "./csv";
import { jsonErrorAt } from "./json-error";

export interface CaseLimits {
  casesMax: number;
  caseIdMaxChars: number;
  caseInputMaxChars: number;
}

export interface CaseProblem {
  /** The case by its id where it has one ("Case INV-04"), the header row for CSV, or null for the whole paste. */
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
  if (id === "") return "add an id, a short name such as INV-01";
  if (id.length > limits.caseIdMaxChars || !CASE_ID.test(id)) {
    return `change the id "${id.slice(0, 40)}" to 1 to ${limits.caseIdMaxChars} characters of A-Z, a-z, 0-9, _ or - only`;
  }
  if (seen.has(id)) return "give it a new id: an earlier case already uses this one";
  return null;
}

/*
 * Problems name the case by its id, which is what the team searches for in its own file. A case
 * with no usable id falls back to where it sits, said the way a person counts.
 */
function caseName(id: string, position: string): string {
  return id !== "" && CASE_ID.test(id) ? `Case ${id.slice(0, 40)}` : `Case with no usable id, ${position}`;
}

function expectedExample(scoring: ScoreRule[]): string {
  const fields = scoring.length > 0 ? scoring.map((r) => r.field) : ["verdict"];
  return `{ ${fields.map((f) => `"${f}": the right answer`).join(", ")} }`;
}

/** One CSV cell as the value its scoring rule expects, or a sentence saying what is wrong. */
function cellValue(raw: string, rule: ScoreRule): { value: ExpectedValue } | { problem: string } {
  const cell = raw.trim();
  if (cell === "") return { problem: `fill in expected.${rule.field} with the right answer for this case` };
  if (rule.rule === "number") {
    if (!NUMERIC.test(cell)) return { problem: `write expected.${rule.field} as a number, not "${cell.slice(0, 30)}"` };
    return { value: Number(cell.replace(/,/g, "")) };
  }
  if (rule.rule === "oneOf") {
    const options = cell.split("|").map((o) => o.trim()).filter((o) => o !== "");
    return options.length === 0 ? { problem: `add at least one answer to expected.${rule.field}, separated with |` } : { value: options };
  }
  return { value: cell };
}

function fromCsv(text: string, scoring: ScoreRule[], limits: CaseLimits): CasesParse {
  const { records, problems: csvProblems } = parseCsv(text);
  const problems: CaseProblem[] = csvProblems.map((p) => ({ where: `Line ${p.row} of the CSV`, message: p.message }));
  const header = records[0];
  if (header === undefined) return { format: "csv", cases: [], problems };

  const names = header.cells.map((c) => c.trim());
  const idCol = names.indexOf("id");
  const inputCol = names.indexOf("input");
  if (idCol === -1 || inputCol === -1) {
    problems.unshift({ where: "Header row", message: 'add an "id" column and an "input" column' });
  }
  if (scoring.length === 0) {
    problems.unshift({ where: null, message: "Add a scoring rule under Answer shape first, so the expected columns can be read." });
  }

  const ruleCols: { col: number; rule: ScoreRule }[] = [];
  names.forEach((name, col) => {
    if (col === idCol || col === inputCol) return;
    if (!name.startsWith(EXPECTED_PREFIX)) {
      problems.push({ where: "Header row", message: `rename or remove the column "${name.slice(0, 40)}": the columns are id, input and expected.<field>` });
      return;
    }
    const field = name.slice(EXPECTED_PREFIX.length);
    const rule = scoring.find((r) => r.field === field);
    if (rule === undefined) {
      problems.push({ where: "Header row", message: `add a scoring rule for ${field.slice(0, 40)} under Answer shape, or remove the column "${name.slice(0, 40)}"` });
    } else {
      ruleCols.push({ col, rule });
    }
  });
  for (const r of scoring) {
    if (!names.includes(EXPECTED_PREFIX + r.field)) {
      problems.push({ where: "Header row", message: `add a column "expected.${r.field}" holding the right ${r.field} for each case` });
    }
  }
  if (idCol === -1 || inputCol === -1) return { format: "csv", cases: [], problems };

  const cases: WorkloadCase[] = [];
  const seen = new Set<string>();
  for (const rec of records.slice(1)) {
    const id = (rec.cells[idCol] ?? "").trim();
    const where = caseName(id, `line ${rec.row} of the CSV`);
    if (rec.cells.length !== names.length) {
      problems.push({
        where,
        message: `has ${rec.cells.length} cells where the header has ${names.length}: put the input in double quotes if it contains a comma`,
      });
      continue;
    }
    const rowProblems: string[] = [];
    const idProblem = checkId(id, seen, limits);
    if (idProblem !== null) rowProblems.push(idProblem);
    const input = rec.cells[inputCol]!;
    if (input.trim() === "") rowProblems.push("add the input text your agent receives");
    if (input.length > limits.caseInputMaxChars) rowProblems.push(`shorten the input to ${limits.caseInputMaxChars} characters (it has ${input.length})`);

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
    const position = `number ${i + 1} in the list`;
    if (!isRecord(item)) {
      problems.push({
        where: caseName("", position),
        message: `write it as { "id": "INV-01", "input": "the text your agent receives", "expected": ${expectedExample(scoring)} }`,
      });
      return;
    }
    const id = typeof item.id === "string" ? item.id : "";
    const where = caseName(id, position);
    const rowProblems: string[] = [];
    const extra = Object.keys(item).filter((k) => k !== "id" && k !== "input" && k !== "expected");
    if (extra.length > 0) rowProblems.push(`remove ${extra.slice(0, 3).join(", ")}: a case has only id, input and expected`);
    if (typeof item.id !== "string") rowProblems.push('add "id": a short name such as "INV-01"');
    else {
      const idProblem = checkId(id, seen, limits);
      if (idProblem !== null) rowProblems.push(idProblem);
    }
    if (typeof item.input !== "string") rowProblems.push('add "input": the text your agent receives, in quotes');
    else if (item.input.length > limits.caseInputMaxChars) rowProblems.push(`shorten the input to ${limits.caseInputMaxChars} characters (it has ${item.input.length})`);

    const expected: Record<string, ExpectedValue> = {};
    if (!isRecord(item.expected)) rowProblems.push(`add "expected": ${expectedExample(scoring)}`);
    else {
      for (const [field, v] of Object.entries(item.expected)) {
        if (!scored.has(field)) rowProblems.push(`remove expected.${field}, or add a scoring rule for ${field} under Answer shape`);
        else if (!EXPECTED_TYPES(v)) rowProblems.push(`set expected.${field} to text, a number, true, false, null or a list of texts`);
        else expected[field] = v;
      }
      for (const field of scored) {
        if (!Object.hasOwn(item.expected, field)) rowProblems.push(`add "${field}" to expected, with the right answer for this case`);
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
