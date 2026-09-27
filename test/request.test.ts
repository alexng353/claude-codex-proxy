import { describe, expect, test } from "bun:test";
import {
  COMPUTER_TOOL_NAME,
  deltaRequest,
  outputSchema,
  prepareClaudePrompt,
  requestToPrompt,
  toolDescriptors,
  validateRequest,
} from "../src/request";

describe("Responses request adapter", () => {
  test("preserves conversation items and tool results", () => {
    const prompt = requestToPrompt({
      model: "sonnet",
      instructions: "Be concise",
      input: [
        { role: "user", content: [{ type: "input_text", text: "List files" }] },
        {
          type: "function_call",
          name: "shell",
          call_id: "call_1",
          arguments: '{"cmd":"ls"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "README.md",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell",
          description: "Run a command",
          parameters: { type: "object" },
        },
      ],
    });
    expect(prompt).toContain("<instructions>\nBe concise");
    expect(prompt).toContain(
      '<assistant_tool_call name="shell" call_id="call_1">',
    );
    expect(prompt).toContain('<tool_result call_id="call_1">\nREADME.md');
    expect(prompt).toContain(
      "Return Codex-provided tool requests in tool_calls",
    );
  });

  test("keeps tool names out of the cache-heading output schema", () => {
    const schema = JSON.stringify(
      outputSchema([{ type: "custom", name: "apply_patch" }]),
    );
    expect(schema).not.toContain("enum");
    expect(schema).toBe(
      JSON.stringify(outputSchema([{ type: "function", name: "other" }])),
    );
    expect(JSON.stringify(outputSchema([]))).toContain('"maxItems":0');
  });

  test("normalizes computer and namespaced tools", () => {
    const tools = [
      { type: "computer" },
      {
        type: "namespace",
        name: "browser",
        tools: [
          { type: "function", name: "open", parameters: { type: "object" } },
        ],
      },
    ];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({
        proxyName: COMPUTER_TOOL_NAME,
        type: "computer",
      }),
      expect.objectContaining({
        proxyName: "browser.open",
        name: "open",
        namespace: "browser",
      }),
    ]);
    expect(
      requestToPrompt({ model: "sonnet", input: "open a page", tools }),
    ).not.toContain("undefined");
  });

  test("normalizes deferred Codex tool search", () => {
    const tools = [
      { type: "tool_search", description: "Search deferred tools" },
    ];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({
        proxyName: "__codex_tool_search",
        type: "tool_search",
      }),
    ]);
  });

  test("passes computer screenshots as image blocks without native Read", async () => {
    const prepared = await prepareClaudePrompt({
      model: "sonnet",
      input: [
        {
          type: "computer_call_output",
          call_id: "call_browser_1",
          output: {
            type: "computer_screenshot",
            image_url: "data:image/png;base64,aGVsbG8=",
          },
        },
      ],
    });
    expect(prepared.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(prepared.prompt).not.toContain("Read tool");
    expect(prepared.prompt).not.toContain("aGVsbG8=");
    await prepared.cleanup();
  });

  test("rejects malformed requests", () => {
    expect(() => validateRequest({ input: "hello" })).toThrow(
      "model is required",
    );
  });

  test("sends a live worker only the unseen items", () => {
    const request = {
      model: "sonnet",
      instructions: "original instructions",
      tools: [{ type: "function", name: "shell" }],
      input: [{ role: "user", content: "run it" }],
    };
    const delta = [{ role: "user", content: "summarize" }];
    expect(deltaRequest(request, delta)).toEqual({
      ...request,
      instructions: undefined,
      tools: [],
      input: delta,
    });
  });
});

test("tool ordering and object key ordering do not perturb the cache prefix", () => {
  const a = {
    type: "function",
    name: "a",
    parameters: { type: "object", properties: { x: { type: "string" } } },
  };
  const b = { type: "function", name: "b" };
  const request = {
    model: "claude-opus-5-5",
    instructions: "stable",
    input: "changing input",
    tools: [b, a],
  };
  expect(requestToPrompt(request)).toBe(
    requestToPrompt({ ...request, tools: [a, b] }),
  );
  expect(outputSchema([a, b])).toEqual(outputSchema([b, a]));
  expect(requestToPrompt(request).indexOf("<available_tools>")).toBeLessThan(
    requestToPrompt(request).indexOf("changing input"),
  );
});
