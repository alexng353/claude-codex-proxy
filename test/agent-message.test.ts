import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestToPrompt, serializeItem } from "../src/request";
import type { ResponseInputItem } from "../src/types";

// The shape Codex 0.163 sends a multi-agent v2 child (from an arch rollout,
// 2026-11-01 04:39, parent gpt-6-astra, child claude-opus-5-5): a plaintext
// header, then the parent's spawn_agent message encrypted by OpenAI.
const v2Task = (recipient: string, extra: Partial<ResponseInputItem> = {}): ResponseInputItem =>
  ({
    type: "agent_message",
    author: "/root",
    recipient,
    content: [
      {
        type: "input_text",
        text: `Message Type: NEW_TASK\nTask name: ${recipient}\nSender: /root\nPayload:\n`,
      },
      { type: "encrypted_content", encrypted_content: "gAAAAABq5yUA_XsaHt0w3aZK0GBlcIyecxCVl7vLk9w5MbrIfVDU79bl" },
    ],
    ...extra,
  }) as ResponseInputItem;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-tasks-"));
  process.env.AGENT_TASKS_DIR = dir;
});
afterEach(() => {
  delete process.env.AGENT_TASKS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("multi-agent v2 agent_message items", () => {
  test("an encrypted payload is never passed on as an empty one", () => {
    const text = serializeItem(v2Task("/root/boundary_claude"));
    expect(text).toContain("Task name: /root/boundary_claude");
    // Before the fix the item became "<agent_message>...Payload:\n</agent_message>":
    // the model saw a blank task and either asked again or guessed one.
    expect(text).toContain("encrypted");
    expect(text).toContain("Do not guess");
    expect(text).not.toMatch(/Payload:\s*<\/agent_message>/);
  });

  test("plaintext agent messages keep their text, sender and recipient", () => {
    const text = serializeItem({
      type: "agent_message",
      author: "/root/simplify_openai",
      recipient: "/root",
      content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\nNo findings." }],
    } as ResponseInputItem);
    expect(text).toContain("No findings.");
    expect(text).toContain("/root/simplify_openai");
    expect(text).not.toContain("encrypted");
  });

  test("the orchestrator's task file stands in for an encrypted payload", () => {
    writeFileSync(join(dir, "correctness_claude__k3f9q2xa7m.md"), "Echo the token PLUM-4417.\n", { mode: 0o600 });
    const text = serializeItem(v2Task("/root/correctness_claude__k3f9q2xa7m"));
    expect(text).toContain("Echo the token PLUM-4417.");
    expect(text).toContain(join(dir, "correctness_claude__k3f9q2xa7m.md"));
    expect(text).not.toContain("Do not guess");
  });

  test("the whole prompt carries the task file text", () => {
    writeFileSync(join(dir, "t__abcdefgh12.md"), "Say PLUM-4417.", { mode: 0o600 });
    const prompt = requestToPrompt({ model: "claude-opus-5-5", input: [v2Task("/root/t__abcdefgh12")] });
    expect(prompt).toContain("Say PLUM-4417.");
  });

  test("names without a nonce are never looked up, so a stale generic file cannot be read", () => {
    writeFileSync(join(dir, "boundary_claude.md"), "Stale task from another comb.", { mode: 0o600 });
    const text = serializeItem(v2Task("/root/boundary_claude"));
    expect(text).not.toContain("Stale task");
    expect(text).toContain("Do not guess");
  });

  test("a missing, stale, symlinked or shared task file is refused", () => {
    const name = "pass1_claude__zz99yy88xx";
    const path = join(dir, `${name}.md`);
    // Missing: the notice names where it looked.
    expect(serializeItem(v2Task(`/root/${name}`))).toContain(path);
    expect(serializeItem(v2Task(`/root/${name}`))).toContain("Do not guess");
    // Older than a day.
    writeFileSync(path, "Old task.", { mode: 0o600 });
    const old = Date.now() / 1000 - 2 * 86_400;
    utimesSync(path, old, old);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Old task.");
    rmSync(path);
    // A symlink to some other file.
    const other = join(dir, "elsewhere.txt");
    writeFileSync(other, "Linked task.", { mode: 0o600 });
    symlinkSync(other, path);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Linked task.");
    rmSync(path);
    // Writable by others.
    writeFileSync(path, "Shared task.");
    chmodSync(path, 0o666);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Shared task.");
  });

  test("a nested task name uses its last segment", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "leaf__q1w2e3r4t5.md"), "Nested PLUM.", { mode: 0o600 });
    expect(serializeItem(v2Task("/root/driver/leaf__q1w2e3r4t5"))).toContain("Nested PLUM.");
  });
});
