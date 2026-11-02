import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeItem } from "../src/request";
import type { ResponseInputItem } from "../src/types";

// Exact bytes of serializeItem for agent_message items, captured from 3896a73
// (before agentMessagePayload was split out). The refactor must not change a
// single character a Claude child sees. A NEW_TASK's BLOCKED reply gained its
// retry sentence on purpose (q proxy-encrypted-subagent-task); nothing else moved.
const EXPECTED: Record<string, string> = {
  "noNonce": "<agent_message from=\"/root\" to=\"/root/p1_claude\">\nMessage Type: NEW_TASK\nTask name: /root/p1_claude\nSender: /root\nPayload:\n[The payload of this message is encrypted for OpenAI models, and this Claude model cannot read it. No task file was looked up: the task name has no \"__<nonce>\" suffix. The task is unknown. Do not guess the task, its target or its scope, and take no actions. Reply only: \"BLOCKED: the task payload was encrypted and unreadable (/root/p1_claude). A Claude agent cannot read an encrypted message. Create @DIR@ with mode 700 if it is missing, write the complete task to @DIR@/p1_claude__62fccba0dbd8.md with mode 600, and spawn a new agent with task_name p1_claude__62fccba0dbd8.\"]\n</agent_message>",
  "missingFile": "<agent_message from=\"/root\" to=\"/root/p3_claude__zzzzzzzz99\">\nMessage Type: NEW_TASK\nTask name: /root/p3_claude__zzzzzzzz99\nSender: /root\nPayload:\n[The payload of this message is encrypted for OpenAI models, and this Claude model cannot read it. The task file @DIR@/p3_claude__zzzzzzzz99.md was not used: it does not exist. The task is unknown. Do not guess the task, its target or its scope, and take no actions. Reply only: \"BLOCKED: the task payload was encrypted and unreadable (/root/p3_claude__zzzzzzzz99). A Claude agent cannot read an encrypted message. Create @DIR@ with mode 700 if it is missing, write the complete task to @DIR@/p3_claude__7ec56327346d.md with mode 600, and spawn a new agent with task_name p3_claude__7ec56327346d.\"]\n</agent_message>",
  "followUp": "<agent_message from=\"/root\" to=\"/root/p1_claude__k3f9q2xa7m\">\nMessage Type: FOLLOW_UP\nTask name: /root/p1_claude__k3f9q2xa7m\nSender: /root\nPayload:\n[The payload of this message is encrypted for OpenAI models, and this Claude model cannot read it. Only a NEW_TASK is read from a task file, and this message is not one. The task is unknown. Do not guess the task, its target or its scope, and take no actions. Reply only: \"BLOCKED: the task payload was encrypted and unreadable (/root/p1_claude__k3f9q2xa7m).\"]\n</agent_message>",
  "taskFile": "<agent_message from=\"/root\" to=\"/root/p1_claude__k3f9q2xa7m\">\nMessage Type: NEW_TASK\nTask name: /root/p1_claude__k3f9q2xa7m\nSender: /root\nPayload:\n[The sender's payload was encrypted for OpenAI models, so the proxy read the sender's task file @DIR@/p1_claude__k3f9q2xa7m.md in its place. Its text follows and is your task.]\nReview it.\n</agent_message>",
  "headerOnly": "<agent_message from=\"/root\">\nMessage Type: NEW_TASK\nTask name: /root/hdr__abcdefgh12\nSender: /root\nPayload:\n[The payload of this message is encrypted for OpenAI models, and this Claude model cannot read it. The task file @DIR@/hdr__abcdefgh12.md was not used: it does not exist. The task is unknown. Do not guess the task, its target or its scope, and take no actions. Reply only: \"BLOCKED: the task payload was encrypted and unreadable (/root/hdr__abcdefgh12). A Claude agent cannot read an encrypted message. Create @DIR@ with mode 700 if it is missing, write the complete task to @DIR@/hdr__34e5fe92e73f.md with mode 600, and spawn a new agent with task_name hdr__34e5fe92e73f.\"]\n</agent_message>",
  "plain": "<agent_message from=\"/root/x\" to=\"/root\">\nMessage Type: FINAL_ANSWER\nPayload:\nNo findings.\n</agent_message>"
};

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-bytes-"));
  writeFileSync(join(dir, "p1_claude__k3f9q2xa7m.md"), "Review it.\n", { mode: 0o600 });
  process.env.AGENT_TASKS_DIR = dir;
});
afterAll(() => {
  delete process.env.AGENT_TASKS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const msg = (recipient: string | undefined, type: string): ResponseInputItem =>
  ({
    type: "agent_message",
    author: "/root",
    ...(recipient ? { recipient } : {}),
    content: [
      { type: "input_text", text: `Message Type: ${type}\nTask name: ${recipient ?? "/root/hdr__abcdefgh12"}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: "gAAAA" },
    ],
  }) as ResponseInputItem;

const cases: Record<string, () => ResponseInputItem> = {
  noNonce: () => msg("/root/p1_claude", "NEW_TASK"),
  missingFile: () => msg("/root/p3_claude__zzzzzzzz99", "NEW_TASK"),
  followUp: () => msg("/root/p1_claude__k3f9q2xa7m", "FOLLOW_UP"),
  taskFile: () => msg("/root/p1_claude__k3f9q2xa7m", "NEW_TASK"),
  headerOnly: () => msg(undefined, "NEW_TASK"),
  plain: () =>
    ({ type: "agent_message", author: "/root/x", recipient: "/root", content: "Message Type: FINAL_ANSWER\nPayload:\nNo findings.\n\n" }) as ResponseInputItem,
};

for (const [name, make] of Object.entries(cases))
  test(`agent_message ${name} serializes to the same bytes as before the refactor`, () => {
    expect(serializeItem(make())).toBe(EXPECTED[name].replaceAll("@DIR@", dir));
  });
