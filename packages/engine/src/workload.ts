import { z } from "zod";
import { LIMITS } from "./limits.js";
import { compileAnswerSchema } from "./schema.js";
import { normaliseNumber, normaliseText } from "./score.js";
import type { ParseResult, Workload } from "./types.js";

const expectedValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

const scoreRule = z.strictObject({
  field: z.string(),
  rule: z.enum(["exact", "number", "oneOf"]),
  tolerance: z.number().optional(),
});

const workloadCase = z.strictObject({
  id: z.string(),
  input: z.string(),
  expected: z.record(z.string(), expectedValue),
});

const workloadShape = z.strictObject({
  name: z.string(),
  systemPrompt: z.string(),
  context: z.string().nullable(),
  answerSchema: z.record(z.string(), z.unknown()),
  shadowHint: z.string().nullable(),
  scoring: z.array(scoreRule),
  cases: z.array(workloadCase),
});

const CASE_ID = new RegExp(`^[A-Za-z0-9_-]{${LIMITS.caseIdMinChars},${LIMITS.caseIdMaxChars}}$`);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/*
 * zod still walks every element of an array that is over its max before it reports the
 * length, so the counts are checked on the raw input first and nothing over a cap is
 * processed at all (C14).
 */
function countGuard(input: unknown): string[] {
  if (!isPlainObject(input)) return [];
  const errors: string[] = [];
  const { cases, scoring } = input;
  if (Array.isArray(scoring) && scoring.length > LIMITS.scoringRulesMax) {
    errors.push(`scoring: has ${scoring.length} rules, the limit is ${LIMITS.scoringRulesMax}`);
  }
  if (Array.isArray(cases)) {
    if (cases.length > LIMITS.casesMax) {
      errors.push(`cases: has ${cases.length} cases, the limit is ${LIMITS.casesMax}`);
    } else {
      for (const [i, c] of cases.entries()) {
        if (!isPlainObject(c) || !isPlainObject(c.expected)) continue;
        if (Object.keys(c.expected).length > LIMITS.scoringRulesMax) {
          errors.push(`cases[${i}].expected: has more fields than the ${LIMITS.scoringRulesMax} scoring rules allowed`);
          continue;
        }
        for (const [field, v] of Object.entries(c.expected)) {
          if (Array.isArray(v) && v.length > LIMITS.oneOfOptionsMax) {
            errors.push(`cases[${i}].expected.${field}: has ${v.length} options, the limit is ${LIMITS.oneOfOptionsMax}`);
          }
        }
      }
    }
  }
  return errors;
}

function lengthErrors(w: Workload): string[] {
  const errors: string[] = [];
  if (w.name.length < LIMITS.nameMinChars || w.name.length > LIMITS.nameMaxChars || w.name.trim() === "") {
    errors.push(`name: must be ${LIMITS.nameMinChars} to ${LIMITS.nameMaxChars} characters and not blank`);
  }
  // SERV refuses any request without a system prompt, so a blank one can never run.
  if (w.systemPrompt.trim() === "") errors.push("systemPrompt: must not be blank");
  if (w.systemPrompt.length > LIMITS.systemPromptMaxChars) {
    errors.push(`systemPrompt: is ${w.systemPrompt.length} characters, the limit is ${LIMITS.systemPromptMaxChars}`);
  }
  if (w.context !== null && w.context.length > LIMITS.contextMaxChars) {
    errors.push(`context: is ${w.context.length} characters, the limit is ${LIMITS.contextMaxChars}`);
  }
  if (w.shadowHint !== null && w.shadowHint.length > LIMITS.shadowHintMaxChars) {
    errors.push(`shadowHint: is ${w.shadowHint.length} characters, the limit is ${LIMITS.shadowHintMaxChars}`);
  }
  if (w.cases.length < LIMITS.casesMin || w.cases.length > LIMITS.casesMax) {
    errors.push(`cases: must have ${LIMITS.casesMin} to ${LIMITS.casesMax} cases`);
  }
  if (w.scoring.length < LIMITS.scoringRulesMin || w.scoring.length > LIMITS.scoringRulesMax) {
    errors.push(`scoring: must have ${LIMITS.scoringRulesMin} to ${LIMITS.scoringRulesMax} rules`);
  }
  for (const [i, c] of w.cases.entries()) {
    if (!CASE_ID.test(c.id)) {
      errors.push(`cases[${i}].id: must be ${LIMITS.caseIdMinChars} to ${LIMITS.caseIdMaxChars} characters of A-Z, a-z, 0-9, _ or -`);
    }
    if (c.input.length > LIMITS.caseInputMaxChars) {
      errors.push(`cases[${i}].input: is ${c.input.length} characters, the limit is ${LIMITS.caseInputMaxChars}`);
    }
    for (const [field, v] of Object.entries(c.expected)) {
      const strings = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
      if (strings.some((x) => x.length > LIMITS.expectedStringMaxChars)) {
        errors.push(`cases[${i}].expected.${field}: a value is over the ${LIMITS.expectedStringMaxChars} character limit`);
      }
    }
  }
  return errors;
}

function consistencyErrors(w: Workload): string[] {
  const errors: string[] = [];

  const seenIds = new Set<string>();
  for (const [i, c] of w.cases.entries()) {
    if (seenIds.has(c.id)) errors.push(`cases[${i}].id: "${c.id}" is used by an earlier case`);
    seenIds.add(c.id);
  }

  const props = isPlainObject(w.answerSchema.properties) ? w.answerSchema.properties : {};
  const seenFields = new Set<string>();
  for (const [i, r] of w.scoring.entries()) {
    const at = `scoring[${i}]`;
    if (seenFields.has(r.field)) errors.push(`${at}.field: "${r.field}" is scored by an earlier rule`);
    seenFields.add(r.field);
    if (!Object.hasOwn(props, r.field)) errors.push(`${at}.field: "${r.field}" is not a property in answerSchema`);
    if (r.tolerance !== undefined && (r.rule !== "number" || r.tolerance < 0)) {
      errors.push(`${at}.tolerance: only a number rule takes a tolerance, and it must be 0 or more`);
    }
  }

  // Each expected value is checked with the same normaliser scoreAnswer uses (C24), so a
  // value that could never match is refused here instead of scoring as a silent miss.
  for (const [i, c] of w.cases.entries()) {
    for (const key of Object.keys(c.expected)) {
      if (!seenFields.has(key)) errors.push(`cases[${i}].expected.${key}: no scoring rule checks this field`);
    }
    for (const r of w.scoring) {
      const at = `cases[${i}].expected.${r.field}`;
      if (!Object.hasOwn(c.expected, r.field)) {
        errors.push(`${at}: missing, every scored field needs an expected value`);
        continue;
      }
      const v = c.expected[r.field];
      if (r.rule === "oneOf" && (!Array.isArray(v) || v.length === 0)) {
        errors.push(`${at}: a oneOf rule expects a non-empty list of strings`);
      } else if (r.rule === "exact" && normaliseText(v) === null) {
        errors.push(`${at}: an exact rule expects a string, number or boolean`);
      } else if (r.rule === "number" && normaliseNumber(v) === null) {
        errors.push(`${at}: a number rule expects a number or a numeric string`);
      }
    }
  }
  return errors;
}

/**
 * Validates a team's test set and returns it typed, or every reason it was refused.
 * Order: raw array counts, shape, every cap in LIMITS, unique case ids, scoring fields
 * against the schema's properties, expected values against their rule, then the schema
 * itself through compileAnswerSchema. Nothing partial is ever returned: any failure means
 * ok:false and no workload.
 */
export function parseWorkload(input: unknown): ParseResult {
  const countErrors = countGuard(input);
  if (countErrors.length > 0) return { ok: false, errors: countErrors };

  const shaped = workloadShape.safeParse(input);
  if (!shaped.success) {
    return {
      ok: false,
      errors: shaped.error.issues.map((i) => `${i.path.map(String).join(".") || "workload"}: ${i.message}`),
    };
  }
  const workload: Workload = shaped.data;

  const capErrors = lengthErrors(workload);
  if (capErrors.length > 0) return { ok: false, errors: capErrors };

  const errors = consistencyErrors(workload);
  const compiled = compileAnswerSchema(workload.answerSchema);
  if (!compiled.ok) errors.push(...compiled.errors);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, workload };
}
