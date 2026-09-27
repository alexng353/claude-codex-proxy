import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, estimateVisibleTokens } from "../src/claude";

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
});

test("rejects GPT models instead of substituting Claude", () => {
  expect(() =>
    buildClaudeArgs({ model: "gpt-6-astra", input: "hello" }),
  ).toThrow("Unsupported Claude model");
});

test("passes exact effort levels and defaults Opus 5.5 to medium", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", undefined]) {
    const args = buildClaudeArgs({
      model: "claude-opus-5-5",
      input: "hello",
      reasoning: { effort },
    });
    expect(args[args.indexOf("--effort") + 1]).toBe(effort ?? "medium");
  }
  expect(() =>
    buildClaudeArgs({
      model: "claude-opus-5-5",
      input: "hello",
      reasoning: { effort: "ultra" },
    }),
  ).toThrow("Unsupported Claude effort");
});
