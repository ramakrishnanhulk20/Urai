import { normaliseModelId } from "./model-id.js";
import type { BuiltRequest, RunConfig, ServMode, Workload, WorkloadCase } from "./types.js";

const DEFAULT_SHADOW_HINT = "The answer must follow the instructions and match the answer schema.";

// SERV reads tools named serv_* and strips them before the model sees them; options ride on schema defaults.
const PROMPT_GUARD = { type: "function", function: { name: "serv_prompt_guard" } } as const;

// SERV's default output filter cuts any answer that quotes the system prompt, which a rules
// agent does by design (bench run 1: 10 of 17 answers cut), so it is off unless asked for.
const NO_CONTENT_FILTER = { type: "function", function: { name: "serv_disable_content_filter" } } as const;

function shadowAgent(hint: string | null) {
  return {
    type: "function",
    function: {
      name: "serv_shadow_agent",
      description: "Enable SERV shadow-agent validation.",
      parameters: {
        type: "object",
        properties: {
          hint: { type: "string", default: hint ?? DEFAULT_SHADOW_HINT },
          max_iterations: { type: "integer", default: 3 },
        },
      },
    },
  } as const;
}

function servTools(mode: ServMode, shadowHint: string | null): object[] {
  switch (mode) {
    case "raw":
    case "plain":
    case "multipath":
      return [];
    case "guard":
      return [PROMPT_GUARD];
    case "full":
      return [PROMPT_GUARD, shadowAgent(shadowHint)];
    default:
      throw new Error(`Unknown SERV mode: ${String(mode satisfies never)}`);
  }
}

/**
 * The user message for one case. Shared data travels here, not in the system prompt, because
 * SERV rewrites the system prompt into its own graph and drops the data it finds there.
 */
export function buildUserMessage(w: Workload, c: WorkloadCase): string {
  return w.context !== null ? JSON.stringify({ context: w.context, input: c.input }) : JSON.stringify({ input: c.input });
}

/**
 * The exact Chat Completions body and the SERV headers for one case under one configuration.
 * The system message is the workload's systemPrompt byte for byte, so every case shares SERV's
 * cached reasoning graph. Never carries an API key: the caller adds Authorization.
 * Throws on a blank model id or an unknown mode, so a bad config never reaches the network.
 */
export function buildRequest(w: Workload, c: WorkloadCase, cfg: RunConfig): BuiltRequest {
  // The one place a model id is trimmed (C24), so the id checked and the id sent never differ.
  const model = normaliseModelId(cfg.model);
  if (model === "") throw new Error("Model id is blank.");

  const tools = cfg.mode === "raw" ? [] : [...servTools(cfg.mode, w.shadowHint), ...(cfg.keepContentFilter ? [] : [NO_CONTENT_FILTER])];
  const body: Record<string, unknown> = {
    model: cfg.mode === "multipath" || cfg.mode === "full" ? `${model}-serv-multipath` : model,
    messages: [
      { role: "system", content: w.systemPrompt },
      { role: "user", content: buildUserMessage(w, c) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: w.answerSchema } },
    ...(tools.length > 0 ? { tools } : {}),
  };
  const headers: Record<string, string> = cfg.mode === "raw" ? { "x-openserv-disable-braid": "true" } : {};
  return { body, headers };
}
