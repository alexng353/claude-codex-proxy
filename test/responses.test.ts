import { describe, expect, test } from "bun:test";
import { responseObject, streamResponse } from "../src/responses";

describe("Responses API output", () => {
  const request = { model: "sonnet", input: "hello", stream: true } as const;
  const output = { text: "Hi", toolCalls: [{ name: "shell", arguments: "{\"cmd\":\"pwd\"}" }], usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } };

  test("creates message and function call items", () => {
    const response = responseObject(request, output);
    expect(response.output.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(response.usage.total_tokens).toBe(13);
  });

  for (const [phase, toolCalls] of [
    ["commentary", output.toolCalls],
    ["final_answer", []],
  ] as const) {
    test(`preserves ${phase} through JSON and SSE message lifecycle`, async () => {
      const response = responseObject(request, { ...output, toolCalls: [...toolCalls] });
      expect(response.output[0]).toMatchObject({ type: "message", phase });
      const body = await streamResponse(response).text();
      const events = body.split("\n")
        .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      for (const type of ["response.output_item.added", "response.output_item.done"]) {
        const event = events.find((event) => event.type === type && event.item.type === "message");
        expect(event.item.phase).toBe(phase);
      }
      expect(events.find((event) => event.type === "response.completed").response.output[0].phase).toBe(phase);
    });
  }

  test("tool-only output does not invent a final answer", () => {
    const response = responseObject(request, { ...output, text: "" });
    expect(response.output.map((item) => item.type)).toEqual(["function_call"]);
    expect(response.output[0]).not.toHaveProperty("phase");
  });

  test("preserves proxy-assigned tool call IDs", () => {
    const response = responseObject(request, {
      ...output,
      toolCalls: [{ name: "shell", arguments: "{}", callId: "call_session_route" }],
    });
    expect(response.output[1].call_id).toBe("call_session_route");
  });

  test("emits Codex-compatible SSE events", async () => {
    const body = await streamResponse(responseObject(request, output)).text();
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.function_call_arguments.done");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  });

  test("uses custom tool call items for freeform tools", async () => {
    const customRequest = { ...request, tools: [{ type: "custom" as const, name: "apply_patch" }] };
    const customOutput = { ...output, toolCalls: [{ name: "apply_patch", arguments: "*** Begin Patch" }] };
    const response = responseObject(customRequest, customOutput);
    expect(response.output[1]).toMatchObject({ type: "custom_tool_call", input: "*** Begin Patch" });
    expect(await streamResponse(response).text()).toContain("event: response.custom_tool_call_input.delta");
  });

  test("returns computer calls for browser actions", async () => {
    const computerRequest = { ...request, tools: [{ type: "computer" }] };
    const computerOutput = { ...output, toolCalls: [{ name: "__codex_computer_use", arguments: '{"type":"click","x":10,"y":20,"button":"left"}' }] };
    const response = responseObject(computerRequest, computerOutput);
    expect(response.output[1]).toMatchObject({
      type: "computer_call",
      action: { type: "click", x: 10, y: 20, button: "left" },
      pending_safety_checks: [],
    });
    expect(await streamResponse(response).text()).toContain('"type":"computer_call"');
  });

  test("returns client tool search calls for deferred MCP discovery", () => {
    const searchRequest = { ...request, tools: [{ type: "tool_search" }] };
    const searchOutput = { ...output, toolCalls: [{ name: "__codex_tool_search", arguments: '{"query":"browser cua_repl node_repl","limit":8}' }] };
    const response = responseObject(searchRequest, searchOutput);
    expect(response.output[1]).toMatchObject({
      type: "tool_search_call",
      execution: "client",
      arguments: { query: "browser cua_repl node_repl", limit: 8 },
    });
  });
});
