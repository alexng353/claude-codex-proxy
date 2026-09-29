import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  estimateRequestTokens,
  estimateVisibleTokens,
  IMAGE_TOKEN_ESTIMATE,
  systemPromptFile,
} from "../src/claude";
import { conversationRequest, requestToPrompt } from "../src/request";

let stateDirectory = "";
let oldStateDir: string | undefined;

beforeAll(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), "claude-codex-proxy-args-"));
  oldStateDir = process.env.PROXY_STATE_DIR;
  process.env.PROXY_STATE_DIR = stateDirectory;
});

afterAll(() => {
  if (oldStateDir === undefined) delete process.env.PROXY_STATE_DIR;
  else process.env.PROXY_STATE_DIR = oldStateDir;
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("Claude subprocess permissions", () => {
  test("loads a minimal runtime with all tools routed through Codex", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "hello" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--no-session-persistence");
    const persisted = buildClaudeArgs(
      { model: "sonnet", input: "hello" },
      { id: "new-id", resumeFrom: "old-id" },
    );
    expect(persisted).not.toContain("--no-session-persistence");
    expect(persisted[persisted.indexOf("--resume") + 1]).toBe("old-id");
    expect(persisted).toContain("--fork-session");
    expect(persisted[persisted.indexOf("--session-id") + 1]).toBe("new-id");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--system-prompt");
    expect(
      readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8"),
    ).toContain("Never claim that a listed Codex tool is unavailable");
  });

  test("new conversations share one cacheable system prompt", () => {
    const base = {
      model: "claude-opus-5-5",
      instructions: "stable instructions",
      tools: [{ type: "function", name: "lookup", description: "Look up" }],
    };
    const first = { ...base, input: "first conversation" };
    const second = {
      ...base,
      input: [{ role: "user", content: "second conversation" }],
    };
    const path = systemPromptFile(first);
    expect(systemPromptFile(second)).toBe(path);
    const system = readFileSync(path, "utf8");
    expect(system).toContain("stable instructions");
    expect(system).toContain("- name: lookup");
    expect(system).not.toContain("first conversation");

    const message = requestToPrompt(conversationRequest(first));
    expect(message).toContain("first conversation");
    expect(message).not.toContain("stable instructions");
    expect(message).not.toContain("<available_tools>");
  });

  test("tools loaded by a past tool search stay in the conversation", () => {
    const message = requestToPrompt(
      conversationRequest({
        model: "claude-opus-5-5",
        instructions: "stable instructions",
        tools: [{ type: "function", name: "lookup" }],
        input: [
          {
            type: "tool_search_output",
            call_id: "call_search",
            tools: [{ type: "function", name: "found_later" }],
          },
        ],
      }),
    );
    expect(message).toContain("- name: found_later");
    expect(message).not.toContain("- name: lookup");
  });

  test("Codex's opening context is shared, the task-specific rest is not", () => {
    const context = [
      {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "<app-context>shared app</app-context>" },
          { type: "input_text", text: "<skills_instructions>skills</skills_instructions>" },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<recommended_plugins>none</recommended_plugins>" },
          { type: "input_text", text: "# AGENTS.md instructions for /repo\n\nbe terse" },
          { type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" },
        ],
      },
    ];
    const task = (prompt: string) => ({
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "lookup" }],
      input: [
        ...context,
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: `hook output for ${prompt}` }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      ],
    });
    const path = systemPromptFile(task("first task"));
    expect(systemPromptFile(task("second task"))).toBe(path);
    const system = readFileSync(path, "utf8");
    expect(system).toContain("shared app");
    expect(system).toContain("be terse");
    expect(system).toContain("<cwd>/repo</cwd>");
    expect(system).not.toContain("hook output");

    const message = requestToPrompt(conversationRequest(task("first task")));
    expect(message).toContain("hook output for first task");
    expect(message).toContain("first task");
    expect(message).not.toContain("shared app");
    expect(message).not.toContain("be terse");
  });

  test("a prompt that is not Codex context stays in the conversation", () => {
    const request = {
      model: "claude-opus-5-5",
      input: [
        { role: "developer", content: "developer note" },
        { role: "user", content: "<environment_context> is what I want to ask about" },
      ],
    };
    // The only user message would be moved, leaving nothing to send.
    expect(requestToPrompt(conversationRequest(request))).toContain(
      "what I want to ask about",
    );
    const plain = {
      model: "claude-opus-5-5",
      input: [
        { role: "developer", content: "developer note" },
        { role: "user", content: "just a question" },
      ],
    };
    expect(requestToPrompt(conversationRequest(plain))).toContain("developer note");
  });

  test("estimates only Codex-visible UTF-8 content", () => {
    expect(estimateVisibleTokens("hello")).toBe(2);
    expect(estimateVisibleTokens("")).toBe(0);
  });

  test("counts tool-output images per image, not per base64 byte", () => {
    const tokens = estimateRequestTokens({
      model: "sonnet",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            {
              type: "input_image",
              image_url: "data:image/png;base64," + "A".repeat(400_000),
            },
          ],
        },
      ],
    });
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
  });
});

test("rejects GPT models instead of substituting Claude", () => {
  expect(() =>
    buildClaudeArgs({ model: "gpt-6-astra", input: "hello" }),
  ).toThrow("Unsupported Claude model");
});

test("passes exact effort levels and defaults Opus and Sonnet 5.5 to medium", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"])
    for (const effort of ["low", "medium", "high", "xhigh", "max", undefined]) {
      const args = buildClaudeArgs({ model, input: "hello", reasoning: { effort } });
      expect(args[args.indexOf("--effort") + 1]).toBe(effort ?? "medium");
      expect(args[args.indexOf("--model") + 1]).toBe(model);
    }
  expect(buildClaudeArgs({ model: "sonnet", input: "hello" })).not.toContain("--effort");
  expect(() =>
    buildClaudeArgs({
      model: "claude-opus-5-5",
      input: "hello",
      reasoning: { effort: "ultra" },
    }),
  ).toThrow("Unsupported Claude effort");
});
