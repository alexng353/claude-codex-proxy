import { describe, expect, test } from "bun:test";
import { buildClaudeArgs } from "../src/claude";

describe("Claude subprocess permissions", () => {
  test("loads normal Claude configuration with unrestricted tools", () => {
    const args = buildClaudeArgs({ model: "sonnet", input: "hello" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--tools");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("Never claim that a listed Codex tool is unavailable");
  });
});
