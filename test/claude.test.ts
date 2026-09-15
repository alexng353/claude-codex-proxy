import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, estimateVisibleTokens } from "../src/claude";

describe("Claude subprocess permissions", () => {
  test("loads normal Claude configuration with unrestricted tools", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "hello" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--tools");
    expect(args).toContain("--disallowed-tools");
    expect(args[args.indexOf("--disallowed-tools") + 1]).toBe("ToolSearch,WebFetch,WebSearch");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("Never claim that a listed Codex tool is unavailable");
  });

  test("estimates only Codex-visible UTF-8 content", () => {
    expect(estimateVisibleTokens("hello")).toBe(2);
    expect(estimateVisibleTokens("")).toBe(0);
  });
});
