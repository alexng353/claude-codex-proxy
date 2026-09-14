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
});
