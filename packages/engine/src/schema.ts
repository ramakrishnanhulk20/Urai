import { Ajv, type Options } from "ajv";
import { LIMITS } from "./limits.js";
import type { CompileResult } from "./types.js";

/*
 * Closed on purpose (C12, C13). Anything not named here is rejected, so no user regex
 * (pattern, patternProperties), no format checks and no $ref, local or remote, can
 * reach the validator. Ajv's own strict mode backs this list: it throws on any keyword
 * it does not know, so a keyword we forget to block still fails closed.
 */
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "anyOf",
]);

/*
 * The one Ajv configuration used for every compile, at workload creation and at scoring
 * (C12, C24). A fresh instance per compile keeps one team's schema out of another's
 * compile cache and stops a long-lived server from growing that cache without bound.
 * No loadSchema, so nothing is ever fetched.
 */
const AJV_OPTIONS: Options = {
  strict: true,
  allowUnionTypes: true,
  validateFormats: false,
  addUsedSchema: false,
  allErrors: false,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJsonPrimitive(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Walks every sub-schema and returns the first problem found, or null. Depth counts schema
 * levels with the root at 1. enum and const must hold plain values so no nesting hides
 * outside the walk and escapes the depth cap.
 */
function checkNode(node: unknown, depth: number, at: string): string | null {
  if (depth > LIMITS.schemaMaxDepth) return `${at}: schema is nested deeper than ${LIMITS.schemaMaxDepth} levels`;
  if (!isPlainObject(node)) return `${at}: must be a schema object`;

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) return `${at}: keyword "${key}" is not allowed`;
  }

  if (Object.hasOwn(node, "properties")) {
    const props = node.properties;
    if (!isPlainObject(props)) return `${at}.properties: must be an object`;
    for (const [name, sub] of Object.entries(props)) {
      const problem = checkNode(sub, depth + 1, `${at}.properties.${name}`);
      if (problem) return problem;
    }
  }
  if (Object.hasOwn(node, "items")) {
    const problem = checkNode(node.items, depth + 1, `${at}.items`);
    if (problem) return problem;
  }
  if (Object.hasOwn(node, "anyOf")) {
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) return `${at}.anyOf: must be a non-empty array of schemas`;
    for (const [i, sub] of branches.entries()) {
      const problem = checkNode(sub, depth + 1, `${at}.anyOf[${i}]`);
      if (problem) return problem;
    }
  }
  if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") {
    const problem = checkNode(node.additionalProperties, depth + 1, `${at}.additionalProperties`);
    if (problem) return problem;
  }
  if (Object.hasOwn(node, "enum")) {
    if (!Array.isArray(node.enum) || !node.enum.every(isJsonPrimitive)) return `${at}.enum: must be an array of plain values`;
  }
  if (Object.hasOwn(node, "const") && !isJsonPrimitive(node.const)) return `${at}.const: must be a plain value`;
  return null;
}

/**
 * Checks a team's answer schema against the closed keyword list, the size cap and the depth
 * cap, then compiles it with the one shared Ajv configuration.
 * Returns ok:false with reasons for a non-object root, a root whose type is not "object",
 * any keyword outside the list, a schema over LIMITS.schemaMaxBytes or LIMITS.schemaMaxDepth,
 * a value that cannot be turned into JSON, or anything Ajv's strict mode refuses.
 */
export function compileAnswerSchema(schema: unknown): CompileResult {
  if (!isPlainObject(schema)) return { ok: false, errors: ["answerSchema: root must be a JSON object"] };

  let json: string;
  try {
    json = JSON.stringify(schema);
  } catch {
    return { ok: false, errors: ["answerSchema: is not plain JSON data"] };
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > LIMITS.schemaMaxBytes) {
    return { ok: false, errors: [`answerSchema: is ${bytes} bytes, the limit is ${LIMITS.schemaMaxBytes}`] };
  }

  if (schema.type !== "object") return { ok: false, errors: ['answerSchema: root must have type "object"'] };
  const problem = checkNode(schema, 1, "answerSchema");
  if (problem) return { ok: false, errors: [problem] };

  try {
    const fn = new Ajv(AJV_OPTIONS).compile(schema);
    return { ok: true, validate: (v: unknown) => fn(v) === true };
  } catch (err) {
    return { ok: false, errors: [`answerSchema: ${err instanceof Error ? err.message : "does not compile"}`] };
  }
}
