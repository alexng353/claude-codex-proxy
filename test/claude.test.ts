import { describe, expect, test } from "bun:test";
import {
  buildClaudeArgs,
  estimateRequestTokens,
  estimateVisibleTokens,
  IMAGE_TOKEN_ESTIMATE,
} from "../src/claude";

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
    expect(args[args.indexOf("--system-prompt") + 1]).toContain(
      "Never claim that a listed Codex tool is unavailable",
    );
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
