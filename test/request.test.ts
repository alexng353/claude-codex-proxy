import { describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import { COMPUTER_TOOL_NAME, continuationRequest, outputSchema, prepareClaudePrompt, requestToPrompt, toolDescriptors, validateRequest } from "../src/request";

describe("Responses request adapter", () => {
  test("preserves conversation items and tool results", () => {
    const prompt = requestToPrompt({
      model: "sonnet",
      instructions: "Be concise",
      input: [
        { role: "user", content: [{ type: "input_text", text: "List files" }] },
        { type: "function_call", name: "shell", call_id: "call_1", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "call_1", output: "README.md" },
      ],
      tools: [{ type: "function", name: "shell", description: "Run a command", parameters: { type: "object" } }],
    });
    expect(prompt).toContain("<instructions>\nBe concise");
    expect(prompt).toContain("<assistant_tool_call name=\"shell\" call_id=\"call_1\">");
    expect(prompt).toContain("<tool_result call_id=\"call_1\">\nREADME.md");
    expect(prompt).toContain("Return Codex-provided tool requests in tool_calls");
  });

  test("constrains structured output to supplied tools", () => {
    const schema = outputSchema([{ type: "custom", name: "apply_patch" }]);
    expect(JSON.stringify(schema)).toContain('"enum":["apply_patch"]');
  });

  test("normalizes computer and namespaced tools", () => {
    const tools = [
      { type: "computer" },
      { type: "namespace", name: "browser", tools: [{ type: "function", name: "open", parameters: { type: "object" } }] },
    ];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({ proxyName: COMPUTER_TOOL_NAME, type: "computer" }),
      expect.objectContaining({ proxyName: "browser.open", name: "open", namespace: "browser" }),
    ]);
    expect(JSON.stringify(outputSchema(tools))).toContain(`"${COMPUTER_TOOL_NAME}"`);
    expect(requestToPrompt({ model: "sonnet", input: "open a page", tools })).not.toContain("undefined");
  });

  test("normalizes deferred Codex tool search", () => {
    const tools = [{ type: "tool_search", description: "Search deferred tools" }];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({ proxyName: "__codex_tool_search", type: "tool_search" }),
    ]);
    expect(JSON.stringify(outputSchema(tools))).toContain('"__codex_tool_search"');
  });

  test("materializes computer screenshots for Claude's Read tool", async () => {
    const prepared = await prepareClaudePrompt({
      model: "sonnet",
      input: [{
        type: "computer_call_output",
        call_id: "call_browser_1",
        output: { type: "computer_screenshot", image_url: "data:image/png;base64,aGVsbG8=" },
      }],
    });
    const match = /path="([^"]+)"/.exec(prepared.prompt);
    expect(match?.[1]).toBeTruthy();
    expect(await exists(match![1])).toBe(true);
    await prepared.cleanup();
    expect(await exists(match![1])).toBe(false);
  });

  test("rejects malformed requests", () => {
    expect(() => validateRequest({ input: "hello" })).toThrow("model is required");
  });

  test("reduces a tool continuation to new results and following input", () => {
    const request = {
      model: "sonnet",
      instructions: "original instructions",
      input: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { role: "user", content: "summarize" },
      ],
    };
    expect(continuationRequest(request, new Set(["call_1"]))).toEqual({
      ...request,
      instructions: undefined,
      input: request.input.slice(2),
    });
  });
});
