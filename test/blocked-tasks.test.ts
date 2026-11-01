import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { blockedTaskPageCommand, codexParent, recordBlockedTasks } from "../src/blocked-tasks";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

// The multi-agent v2 NEW_TASK shape from agent-message.test.ts: a plaintext
// header, then the parent's message encrypted by OpenAI.
const v2Task = (recipient: string, blob = "gAAAAABq5yUA_XsaHt0w3aZK0GBl"): ResponseInputItem =>
  ({
    type: "agent_message",
    author: "/root",
    recipient,
    content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: ${recipient}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: blob },
    ],
  }) as ResponseInputItem;

const request = (...input: ResponseInputItem[]): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: "01a19825-0000-7000-8000-000000000001",
  input,
});

let dir: string;
let pages: string[];
const send = async (text: string) => {
  pages.push(text);
  return true;
};
const options = (now: number) => ({
  path: join(dir, "blocked-tasks.json"),
  now: () => now,
  send,
  machine: "arch",
  orchestrator: () => ({ model: "gpt-6-astra", thread: "01a19825-0000-7000-8000-00000000aaaa" }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blocked-tasks-"));
  process.env.AGENT_TASKS_DIR = join(dir, "agent-tasks");
  pages = [];
});
afterEach(() => {
  delete process.env.AGENT_TASKS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("the encrypted-task BLOCKED path is counted and paged", () => {
  test("the orchestrator is read from Codex's thread_spawn_edges", () => {
    const home = join(dir, "codex-home");
    mkdirSync(home);
    const db = new Database(join(home, "state_5.sqlite"));
    db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)");
    db.run("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)");
    const parent = "01a19825-0000-7000-8000-00000000aaaa";
    const child = "01a19825-0000-7000-8000-000000000001";
    db.run("INSERT INTO threads VALUES (?, 'gpt-6-astra'), (?, 'claude-opus-5-5')", [parent, child]);
    db.run("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')", [parent, child]);
    db.close();
    expect(codexParent(child, [join(dir, "missing"), home])).toEqual({ thread: parent, model: "gpt-6-astra" });
    expect(codexParent(parent, [home])).toBeUndefined();
    expect(codexParent("not a thread", [home])).toBeUndefined();
  });

  test("an encrypted-only agent_message increments the counter and pages once", async () => {
    const first = recordBlockedTasks(request(v2Task("/root/p1_claude")), options(1_000_000));
    expect(first.count).toBe(1);
    expect(first.hits.map((hit) => hit.taskName)).toEqual(["/root/p1_claude"]);
    await first.paged;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("gpt-6-astra");
    expect(pages[0]).toContain("arch");
    expect(pages[0]).toContain("/root/p1_claude");

    // A second, different hit inside the hour counts but does not page again.
    const second = recordBlockedTasks(request(v2Task("/root/p3_claude", "gAAAAAB-other")), options(1_000_000 + 30 * 60_000));
    expect(second.count).toBe(2);
    expect(second.paged).toBeUndefined();
    expect(pages).toHaveLength(1);

    // After an hour the next hit pages again, and reports the running count.
    const third = recordBlockedTasks(request(v2Task("/root/p2_claude", "gAAAAAB-third")), options(1_000_000 + 61 * 60_000));
    expect(third.count).toBe(3);
    await third.paged;
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("3 ");
  });

  test("the same message replayed in later turns of the child is counted once", async () => {
    const item = v2Task("/root/p1_claude");
    await recordBlockedTasks(request(item), options(1_000_000)).paged;
    const replay = recordBlockedTasks(
      request(item, { role: "assistant", content: "BLOCKED" } as ResponseInputItem),
      options(2 * 60 * 60_000),
    );
    expect(replay.count).toBe(1);
    expect(replay.hits).toEqual([]);
    expect(replay.paged).toBeUndefined();
    expect(pages).toHaveLength(1);
  });

  test("a task the proxy could read from its task file is not a hit", () => {
    mkdirSync(process.env.AGENT_TASKS_DIR!, { recursive: true, mode: 0o700 });
    writeFileSync(join(process.env.AGENT_TASKS_DIR!, "p1_claude__k3f9q2xa7m.md"), "Review it.\n", { mode: 0o600 });
    const result = recordBlockedTasks(request(v2Task("/root/p1_claude__k3f9q2xa7m")), options(1_000_000));
    expect(result.count).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.paged).toBeUndefined();
  });

  test("a plaintext agent_message is not a hit", () => {
    const item = {
      type: "agent_message",
      author: "/root/p1_openai",
      recipient: "/root",
      content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nPayload:\nNo findings." }],
    } as ResponseInputItem;
    expect(recordBlockedTasks(request(item), options(1_000_000)).count).toBe(0);
  });

  test("a failed page frees the hour so the next hit retries", async () => {
    const failing = { ...options(1_000_000), send: async (text: string) => (pages.push(text), false) };
    await recordBlockedTasks(request(v2Task("/root/a")), failing).paged;
    await recordBlockedTasks(request(v2Task("/root/b", "gAAAAAB-b")), options(1_000_100)).paged;
    expect(pages).toHaveLength(2);
  });
});

describe("the page command", () => {
  test("is never run from a test", async () => {
    const { todayPage } = await import("../src/blocked-tasks");
    expect(await todayPage("x", "comb-blocked-1")).toBe(false);
  });
  const build = "1e9cda68-9b3c-408d-84d8-8fdbdb4531a7";
  test("pages a chat on this machine through the local daemon", () => {
    const argv = blockedTaskPageCommand(build, "forge", "comb-blocked-1", "forge")!;
    expect(argv[0]).not.toBe("ssh");
    expect(argv).toContain(build);
    expect(argv).toContain("--client-message-id");
  });
  test("reaches a chat on another machine over ssh", () => {
    const argv = blockedTaskPageCommand(build, "forge", "comb-blocked-1", "arch")!;
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("forge");
  });
  test("refuses a malformed thread, machine or id", () => {
    expect(blockedTaskPageCommand("not-a-thread; rm -rf ~", "forge", "comb-blocked-1", "arch")).toBeNull();
    expect(blockedTaskPageCommand(build, "forge;id", "comb-blocked-1", "arch")).toBeNull();
    expect(blockedTaskPageCommand(build, "forge", "x; id", "arch")).toBeNull();
  });
});
