// Not covered here: whether SERV accepts these bodies (the bench proved the same shapes live), the Authorization header, and network behaviour.
import { describe, expect, it } from "vitest";
import { buildRequest, buildUserMessage, type ServMode, type Workload } from "../src/index.js";

const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };

const w: Workload = {
  name: "t",
  systemPrompt: "Rules line one.\n  Rules line two with trailing space. ",
  context: "shared data",
  answerSchema: schema,
  shadowHint: "Cite a clause.",
  scoring: [{ field: "verdict", rule: "exact" }],
  cases: [
    { id: "a", input: "first case", expected: { verdict: "pay" } },
    { id: "b", input: "second case", expected: { verdict: "hold" } },
  ],
};
const c = w.cases[0]!;

const guard = { type: "function", function: { name: "serv_prompt_guard" } };
const noFilter = { type: "function", function: { name: "serv_disable_content_filter" } };
const shadow = (hint: string) => ({
  type: "function",
  function: {
    name: "serv_shadow_agent",
    description: "Enable SERV shadow-agent validation.",
    parameters: {
      type: "object",
      properties: { hint: { type: "string", default: hint }, max_iterations: { type: "integer", default: 3 } },
    },
  },
});

const base = (model: string) => ({
  model,
  messages: [
    { role: "system", content: w.systemPrompt },
    { role: "user", content: '{"context":"shared data","input":"first case"}' },
  ],
  response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
});

describe("buildRequest", () => {
  it.each<[ServMode, Record<string, unknown>, Record<string, string>]>([
    ["raw", base("gpt-6-luna"), { "x-openserv-disable-braid": "true" }],
    ["plain", { ...base("gpt-6-luna"), tools: [noFilter] }, {}],
    ["guard", { ...base("gpt-6-luna"), tools: [guard, noFilter] }, {}],
    ["multipath", { ...base("gpt-6-luna-serv-multipath"), tools: [noFilter] }, {}],
    ["full", { ...base("gpt-6-luna-serv-multipath"), tools: [guard, shadow("Cite a clause."), noFilter] }, {}],
  ])("builds the exact %s request", (mode, body, headers) => {
    expect(buildRequest(w, c, { model: "  gpt-6-luna ", mode })).toStrictEqual({ body, headers });
  });

  it.each<[ServMode, Record<string, unknown>, Record<string, string>]>([
    ["raw", base("m"), { "x-openserv-disable-braid": "true" }],
    ["plain", base("m"), {}],
    ["guard", { ...base("m"), tools: [guard] }, {}],
    ["multipath", base("m-serv-multipath"), {}],
    ["full", { ...base("m-serv-multipath"), tools: [guard, shadow("Cite a clause.")] }, {}],
  ])("keepContentFilter drops serv_disable_content_filter in %s", (mode, body, headers) => {
    expect(buildRequest(w, c, { model: "m", mode, keepContentFilter: true })).toStrictEqual({ body, headers });
  });

  it("falls back to the default shadow hint when the workload has none", () => {
    const { body } = buildRequest({ ...w, shadowHint: null }, c, { model: "m", mode: "full" });
    expect(body.tools).toContainEqual(shadow("The answer must follow the instructions and match the answer schema."));
  });

  it("sends a byte-identical system message for every case", () => {
    const systems = w.cases.map((x) => (buildRequest(w, x, { model: "m", mode: "plain" }).body.messages as { content: string }[])[0]!.content);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toBe(w.systemPrompt);
  });

  it("sends max_completion_tokens only when asked, and refuses a cap that is not a positive integer", () => {
    expect(buildRequest(w, c, { model: "m", mode: "raw" }).body).not.toHaveProperty("max_completion_tokens");
    expect(buildRequest(w, c, { model: "m", mode: "raw" }, {}).body).not.toHaveProperty("max_completion_tokens");
    expect(buildRequest(w, c, { model: "m", mode: "plain" }, { maxCompletionTokens: 8192 }).body).toMatchObject({ max_completion_tokens: 8192 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildRequest(w, c, { model: "m", mode: "raw" }, { maxCompletionTokens: bad })).toThrow("maxCompletionTokens");
    }
  });

  it("refuses a blank model id and an unknown mode", () => {
    expect(() => buildRequest(w, c, { model: "   ", mode: "raw" })).toThrow("blank");
    expect(() => buildRequest(w, c, { model: "m", mode: "turbo" as ServMode })).toThrow("Unknown SERV mode");
  });
});

describe("buildUserMessage", () => {
  it("carries context and input, or input alone when context is null", () => {
    expect(buildUserMessage(w, c)).toBe('{"context":"shared data","input":"first case"}');
    expect(buildUserMessage({ ...w, context: null }, c)).toBe('{"input":"first case"}');
  });
});
