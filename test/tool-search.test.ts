import { expect, test } from "bun:test";
import {
  outputSchema,
  requestToPrompt,
  requestTools,
  toolDescriptors,
} from "../src/request";
import { responseObject } from "../src/responses";
import type { ResponsesRequest } from "../src/types";

const spawnAgent = {
  type: "function",
  name: "spawn_agent",
  description: "Spawn a sub-agent",
  defer_loading: true,
  parameters: { type: "object", properties: { model: { type: "string" } } },
};
const loaded = { type: "namespace", name: "multi_agent_v1", tools: [spawnAgent] };

const request: ResponsesRequest = {
  model: "claude-opus-5-5",
  tools: [{ type: "tool_search" }, { type: "function", name: "exec_command" }],
  input: [
    { role: "user", content: "spawn a reviewer" },
    { type: "tool_search_call", call_id: "ts_1", arguments: "{}" },
    { type: "tool_search_output", call_id: "ts_1", tools: [loaded] },
    // A second search that loads the same tool again must not duplicate it.
    { type: "tool_search_output", call_id: "ts_2", tools: [loaded] },
  ],
};

test("tools loaded by tool_search become callable", () => {
  expect(requestTools(request)).toHaveLength(4);
  const names = toolDescriptors(requestTools(request)).map((tool) => tool.proxyName);
  expect(names).toContain("multi_agent_v1.spawn_agent");
  expect(names.filter((name) => name === "multi_agent_v1.spawn_agent")).toHaveLength(1);
  expect(requestToPrompt(request)).toContain("- name: multi_agent_v1.spawn_agent");
});

test("a loaded namespaced tool is routed back as a namespaced function call", () => {
  const response = responseObject(request, {
    text: "",
    toolCalls: [{ name: "multi_agent_v1.spawn_agent", arguments: "{}", callId: "call_1" }],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
  expect(response.output[0]).toMatchObject({
    type: "function_call",
    name: "spawn_agent",
    namespace: "multi_agent_v1",
    call_id: "call_1",
  });
});

// --json-schema becomes a synthetic tool definition, which heads the prompt-cache
// prefix, and the worker is reused only while the tool signature is unchanged.
test("loaded tools keep the schema and prompt prefix stable on later turns", () => {
  const schema = (r: ResponsesRequest) => JSON.stringify(outputSchema(requestTools(r)));
  const input = request.input as NonNullable<Exclude<ResponsesRequest["input"], string>>;
  const later: ResponsesRequest = {
    ...request,
    input: [
      ...input,
      { type: "function_call", call_id: "call_2", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_2", output: "ok" },
    ],
  };
  expect(schema(later)).toBe(schema(request));
  const toolsBlock = (r: ResponsesRequest) =>
    /<available_tools>[\s\S]*?<\/available_tools>/.exec(requestToPrompt(r))?.[0];
  expect(toolsBlock(later)).toBe(toolsBlock(request));

  // Loading the same tool once or twice yields an identical schema.
  const once: ResponsesRequest = { ...request, input: input.slice(0, 3) };
  expect(schema(once)).toBe(schema(request));
});
