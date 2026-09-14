import { describe, expect, test } from "bun:test";
import { outputSchema, requestToPrompt, validateRequest } from "../src/request";

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
    expect(prompt).toContain("Do not execute tools yourself");
  });

  test("constrains structured output to supplied tools", () => {
    const schema = outputSchema([{ type: "custom", name: "apply_patch" }]);
    expect(JSON.stringify(schema)).toContain('"enum":["apply_patch"]');
  });

  test("rejects malformed requests", () => {
    expect(() => validateRequest({ input: "hello" })).toThrow("model is required");
  });
});
