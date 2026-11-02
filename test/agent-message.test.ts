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

  test("only a NEW_TASK is replaced by the task file; a follow-up or steer is never answered with the old task", () => {
    const name = "p1_claude__aa11bb22cc";
    writeFileSync(join(dir, `${name}.md`), "Original task PLUM.", { mode: 0o600 });
    for (const kind of ["MESSAGE", "FOLLOWUP_TASK"]) {
      const item = v2Task(`/root/${name}`);
      const parts = item.content as { type: string; text?: string }[];
      parts[0] = { type: "input_text", text: `Message Type: ${kind}\nTask name: /root/${name}\nSender: /root\nPayload:\n` };
      const text = serializeItem(item);
      expect(text).not.toContain("Original task PLUM.");
      expect(text).toContain("BLOCKED");
    }
  });

  test("plaintext parts are joined with a newline so they cannot run together", () => {
    const text = serializeItem({
      type: "agent_message",
      author: "/root/a",
      recipient: "/root",
      content: [
        { type: "input_text", text: "first" },
        { type: "input_text", text: "second" },
      ],
    } as ResponseInputItem);
    expect(text).toContain("first\nsecond");
  });

  test("a task file readable by group or others is refused", () => {
    const name = "p1_claude__gg44hh55ii";
    const path = join(dir, `${name}.md`);
    writeFileSync(path, "Readable task.");
    chmodSync(path, 0o640);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Readable task.");
    chmodSync(path, 0o604);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Readable task.");
  });

  test("a task file with a future mtime is refused", () => {
    const name = "p1_claude__ff00ee11dd";
    const path = join(dir, `${name}.md`);
    writeFileSync(path, "Future task.", { mode: 0o600 });
    const future = Date.now() / 1000 + 2 * 86_400;
    utimesSync(path, future, future);
    expect(serializeItem(v2Task(`/root/${name}`))).not.toContain("Future task.");
  });

  // Regression guard for the size limit; the grow-after-fstat race the bounded
  // read closes cannot be staged deterministically here.
  test("an oversized task file is refused", () => {
    const name = "p1_claude__bb22cc33dd";
    const path = join(dir, `${name}.md`);
    writeFileSync(path, "x".repeat(512 * 1024 + 1), { mode: 0o600 });
    const text = serializeItem(v2Task(`/root/${name}`));
    expect(text).not.toContain("xxxxxxxx");
    expect(text).toContain("BLOCKED");
  });
});

// q proxy-encrypted-subagent-task (arch, Nov 2 13:26-13:29): a gpt-6-astra comb spawned
// /root/comb_opus, then /root/comb_opus_retry, then /root/comb_opus__a7c92d, with no task
// file. All three replied a bare BLOCKED, and the third was told its name had no
// "__<nonce>" suffix when it had a six-character one. OpenAI encrypts the spawn message
// and rejects a schema without the encryption marker, so the task file is the only way a
// Claude child gets its task; the BLOCKED reply must tell the parent how to use it.
describe("a BLOCKED reply the parent can act on", () => {
  const reply = (text: string) => /Reply only: "(BLOCKED: [^"]*)"\]/.exec(text)?.[1] ?? "";
  const suggested = (text: string) => /task_name ([a-z0-9_]+__[a-z0-9]+)/.exec(reply(text))?.[1];

  test("a key of the wrong length is named as such, not as a missing suffix", () => {
    const text = serializeItem(v2Task("/root/comb_opus__a7c92d"));
    expect(text).not.toContain('has no "__<nonce>" suffix');
    expect(text).toContain("8 to 32 lowercase letters or digits");
  });

  test("the reply keeps its prefix and names a task file and task name to spawn again with", () => {
    const text = serializeItem(v2Task("/root/comb_opus"));
    const answer = reply(text);
    expect(answer.startsWith("BLOCKED: the task payload was encrypted and unreadable (/root/comb_opus).")).toBe(true);
    const name = suggested(text);
    expect(name).toMatch(/^comb_opus__[a-z0-9]{12}$/);
    expect(answer).toContain(join(dir, `${name}.md`));
  });

  test("the suggested name and path are the ones the proxy then reads", () => {
    const name = suggested(serializeItem(v2Task("/root/comb_opus__a7c92d")))!;
    writeFileSync(join(dir, `${name}.md`), "Echo PLUM-9090.", { mode: 0o600 });
    expect(serializeItem(v2Task(`/root/${name}`))).toContain("Echo PLUM-9090.");
  });

  test("the suggestion is stable across replays and differs between tasks", () => {
    const a = suggested(serializeItem(v2Task("/root/comb_opus")));
    expect(suggested(serializeItem(v2Task("/root/comb_opus")))).toBe(a);
    const other = v2Task("/root/comb_opus");
    (other.content as { encrypted_content?: string }[])[1].encrypted_content = "gAAAAABq6PIWPXePuty8Ss7dXJzp8e6E5bdd";
    expect(suggested(serializeItem(other))).not.toBe(a);
  });

  test("a label outside [a-z0-9_] becomes a valid name", () => {
    expect(suggested(serializeItem(v2Task("/root/Comb-Opus.v2")))).toMatch(/^comb_opus_v2__[a-z0-9]{12}$/);
  });

  test("every awkward task name still yields a name and file the proxy reads", () => {
    const cases: [string, RegExp][] = [
      ["", /^task__[a-z0-9]{12}$/],
      ["/root/___", /^task__[a-z0-9]{12}$/],
      [`/root/${"a_".repeat(40)}`, /^(a_){19}a__[a-z0-9]{12}$/],
      ["/root/İx", /^i_x__[a-z0-9]{12}$/],
      ["/root/foo___bar", /^foo__[a-z0-9]{12}$/],
      ["/root/__k", /^task__[a-z0-9]{12}$/],
    ];
    for (const [task, shape] of cases) {
      const name = suggested(serializeItem(v2Task(task)))!;
      expect(name).toMatch(shape);
      writeFileSync(join(dir, `${name}.md`), `Task for ${JSON.stringify(task)}.`, { mode: 0o600 });
      expect(serializeItem(v2Task(`/root/${name}`))).toContain(`Task for ${JSON.stringify(task)}.`);
    }
  });

  test("the reply says to create the directory and write the file privately", () => {
    const answer = reply(serializeItem(v2Task("/root/comb_opus")));
    expect(answer).toContain(`Create ${dir} with mode 700 if it is missing`);
    expect(answer).toContain("with mode 600");
  });

  test("a follow-up keeps the bare reply: respawning would drop the child's work", () => {
    const item = v2Task("/root/comb_opus__k3f9q2xa7m");
    (item.content as { type: string; text?: string }[])[0].text =
      "Message Type: FOLLOW_UP\nTask name: /root/comb_opus__k3f9q2xa7m\nSender: /root\nPayload:\n";
    expect(reply(serializeItem(item))).toBe("BLOCKED: the task payload was encrypted and unreadable (/root/comb_opus__k3f9q2xa7m).");
  });
});
