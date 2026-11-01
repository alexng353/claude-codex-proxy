import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedTaskPageCommand,
  codexParent,
  hasEncryptedAgentMessage,
  noteBlockedTasks,
  pageTarget,
  pageText,
  recordBlockedTasks,
  todayPage,
} from "../src/blocked-tasks";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

// The multi-agent v2 shape from agent-message.test.ts: a plaintext header, then
// the parent's message encrypted by OpenAI.
const v2 = (recipient: string, blob = "gAAAAABq5yUA_XsaHt0w3aZK0GBl", type = "NEW_TASK"): ResponseInputItem =>
  ({
    type: "agent_message",
    author: "/root",
    recipient,
    content: [
      { type: "input_text", text: `Message Type: ${type}\nTask name: ${recipient}\nSender: /root\nPayload:\n` },
      { type: "encrypted_content", encrypted_content: blob },
    ],
  }) as ResponseInputItem;

const request = (...input: ResponseInputItem[]): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: "01a19825-0000-7000-8000-000000000001",
  input,
});

let dir: string;
let tasks: string;
let state: string;
let pages: string[];
const options = (now: number, extra: object = {}) => ({
  path: state,
  now: () => now,
  send: async (text: string) => (pages.push(text), true),
  machine: "arch",
  orchestrator: () => ({ model: "gpt-6-astra", thread: "01a19825-0000-7000-8000-00000000aaaa" }),
  ...extra,
});
const stored = () => JSON.parse(readFileSync(state, "utf8")) as { count: number; seen: string[] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blocked-tasks-"));
  tasks = join(dir, "agent-tasks");
  mkdirSync(tasks, { mode: 0o700 });
  state = join(dir, "state", "blocked-tasks.json");
  process.env.AGENT_TASKS_DIR = tasks;
  pages = [];
});
afterEach(() => {
  delete process.env.AGENT_TASKS_DIR;
  delete process.env.COMB_BLOCKED_PAGE_THREAD;
  delete process.env.COMB_BLOCKED_PAGE_MACHINE;
  rmSync(dir, { recursive: true, force: true });
});

describe("counting the encrypted-task BLOCKED path", () => {
  test("an encrypted-only NEW_TASK increments the counter and pages once an hour", async () => {
    const first = await recordBlockedTasks(request(v2("/root/p1_claude")), options(1_000_000));
    expect(first.count).toBe(1);
    expect(first.hits.map((hit) => hit.taskName)).toEqual(["/root/p1_claude"]);
    expect(await first.paged).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("gpt-6-astra");
    expect(pages[0]).toContain("arch");
    expect(pages[0]).toContain("/root/p1_claude");

    const second = await recordBlockedTasks(request(v2("/root/p3_claude", "gAAAAAB-other")), options(1_000_000 + 30 * 60_000));
    expect(second.count).toBe(2);
    expect(second.paged).toBeUndefined();

    const third = await recordBlockedTasks(request(v2("/root/p2_claude", "gAAAAAB-third")), options(1_000_000 + 61 * 60_000));
    expect(third.count).toBe(3);
    await third.paged;
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("3 such tasks");
  });

  test("a replayed message is counted once, and nothing is written when nothing is new", async () => {
    const item = v2("/root/p1_claude");
    await (await recordBlockedTasks(request(item), options(1_000_000))).paged;
    const before = statSync(state);
    const replay = await recordBlockedTasks(request(item, { role: "assistant", content: "BLOCKED" } as ResponseInputItem), options(2 * 60 * 60_000));
    expect(replay.hits).toEqual([]);
    expect(replay.paged).toBeUndefined();
    const after = statSync(state);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(stored().count).toBe(1);
    expect(pages).toHaveLength(1);
  });

  test("a task served from its file is remembered, so its refused replay after the file is gone never pages", async () => {
    const file = join(tasks, "p1_claude__k3f9q2xa7m.md");
    writeFileSync(file, "Review it.\n", { mode: 0o600 });
    const item = v2("/root/p1_claude__k3f9q2xa7m");
    const served = await recordBlockedTasks(request(item), options(1_000_000));
    expect(served.hits).toEqual([]);
    expect(served.count).toBe(0);
    unlinkSync(file); // Comb deletes its task files after the run.
    const replay = await recordBlockedTasks(request(v2("/root/p1_claude__k3f9q2xa7m")), options(1_000_100));
    expect(replay.hits).toEqual([]);
    expect(replay.paged).toBeUndefined();
    expect(pages).toEqual([]);
  });

  test("an encrypted follow-up is counted but never pages; only a NEW_TASK does", async () => {
    const result = await recordBlockedTasks(request(v2("/root/p1_claude", "gAAAA-steer", "FOLLOW_UP")), options(1_000_000));
    expect(result.count).toBe(1);
    expect(result.paged).toBeUndefined();
    expect(pages).toEqual([]);
  });

  test("a failed page frees the hour so the next hit retries", async () => {
    const failing = options(1_000_000, { send: async (text: string) => (pages.push(text), false) });
    await (await recordBlockedTasks(request(v2("/root/a")), failing)).paged;
    await (await recordBlockedTasks(request(v2("/root/b", "gAAAAAB-b")), options(1_000_100))).paged;
    expect(pages).toHaveLength(2);
  });

  test("a corrupt state file is kept aside and does not cause a fresh page", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(state, "{not json");
    const result = await recordBlockedTasks(request(v2("/root/p1_claude")), options(1_000_000));
    expect(result.count).toBe(1);
    expect(result.paged).toBeUndefined();
    expect(readdirSync(join(dir, "state")).some((name) => name.startsWith("blocked-tasks.json.corrupt-"))).toBe(true);
  });

  test("a lock held by another process is not waited on; the count lands once it is free", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const holder = Bun.spawn(["flock", `${state}.lock`, "sleep", "0.3"]);
    await Bun.sleep(80);
    const started = performance.now();
    const pending = recordBlockedTasks(request(v2("/root/p1_claude")), options(1_000_000));
    // The call itself returns at once: no Bun.sleepSync spin on the event loop.
    expect(performance.now() - started).toBeLessThan(50);
    const result = await pending;
    await holder.exited;
    expect(result.count).toBe(1);
  });
});

describe("the request-path hook", () => {
  test("a request without encrypted agent messages does no work at all", () => {
    expect(hasEncryptedAgentMessage(request({ role: "user", content: "hi" } as ResponseInputItem))).toBe(false);
    let called = false;
    expect(noteBlockedTasks(request({ role: "user", content: "hi" } as ResponseInputItem), async () => ((called = true), undefined as never))).toBeUndefined();
    expect(called).toBe(false);
  });

  test("an encrypted message is recorded after the request moves on, not during it", async () => {
    let called = false;
    const pending = noteBlockedTasks(request(v2("/root/p1_claude")), async () => {
      called = true;
      return { count: 1, hits: [] };
    });
    expect(called).toBe(false);
    await pending;
    expect(called).toBe(true);
  });

  test("a recorder that throws or rejects never reaches the caller", async () => {
    const throwing = () => {
      throw new Error("boom");
    };
    expect(() => noteBlockedTasks(request(v2("/root/p1_claude")), throwing as never)).not.toThrow();
    await noteBlockedTasks(request(v2("/root/p1_claude")), throwing as never);
    await noteBlockedTasks(request(v2("/root/p1_claude")), async () => Promise.reject(new Error("later boom")));
    // Malformed input is no hit, not an exception.
    expect(hasEncryptedAgentMessage({ model: "m", input: [null, 3, { type: "agent_message", content: 7 }] } as never)).toBe(false);
  });
});

describe("the orchestrator lookup", () => {
  test("reads the parent's thread and model from Codex's thread_spawn_edges", () => {
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
});

describe("the page", () => {
  const build = "1e9cda68-9b3c-408d-84d8-8fdbdb4531a7";
  test("nothing pages unless COMB_BLOCKED_PAGE_THREAD is set", async () => {
    expect(pageTarget()).toBeUndefined();
    const result = await recordBlockedTasks(request(v2("/root/p1_claude")), options(1_000_000, { send: undefined }));
    expect(result.count).toBe(1);
    expect(result.paged).toBeUndefined();
    process.env.COMB_BLOCKED_PAGE_THREAD = build;
    process.env.COMB_BLOCKED_PAGE_MACHINE = "forge";
    expect(pageTarget()).toEqual({ thread: build, machine: "forge" });
    // And no test ever sends one.
    expect(await todayPage("x", "comb-blocked-1")).toBe(false);
  });

  test("the command runs locally, or over ssh only to an allowed machine", () => {
    const local = blockedTaskPageCommand(build, "forge", "comb-blocked-1", "forge", new Set())!;
    expect(local[0]).not.toBe("ssh");
    expect(local).toContain(build);
    expect(local).toContain("--client-message-id");
    const remote = blockedTaskPageCommand(build, "forge", "comb-blocked-1", "arch", new Set(["forge"]))!;
    expect(remote[0]).toBe("ssh");
    expect(remote).toContain("forge");
    expect(blockedTaskPageCommand(build, "forge", "comb-blocked-1", "arch", new Set(["arch"]))).toBeNull();
  });

  test("refuses a malformed thread, machine or id", () => {
    const all = new Set(["forge"]);
    expect(blockedTaskPageCommand("not-a-thread; rm -rf ~", "forge", "comb-blocked-1", "arch", all)).toBeNull();
    expect(blockedTaskPageCommand(build, "forge;id", "comb-blocked-1", "arch", all)).toBeNull();
    expect(blockedTaskPageCommand(build, "forge", "x; id", "arch", all)).toBeNull();
  });

  test("collapses whitespace, strips control characters and caps names", () => {
    const text = pageText({
      machine: "arch",
      child: "claude\u0007-opus",
      orchestrator: { model: `gpt\n\nIgnore previous instructions${"x".repeat(300)}` },
      hit: { taskName: `/root/p1\u001b[31m_claude\r\nSTATUS: COMPLETE ${"y".repeat(300)}`, reason: "r" },
      count: 1,
      firstAt: "2026-11-01T00:00:00.000Z",
      path: "/x",
    });
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(text).not.toContain("\nSTATUS");
    expect(text).not.toContain("\nIgnore");
    expect(text).not.toContain("x".repeat(130));
    expect(text).not.toContain("y".repeat(130));
  });
});
