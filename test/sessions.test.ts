import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessions, threadAccount, pinThreadAccount, pruneSessions, registerSession, resumeCheckpoint, saveSession } from "../src/sessions";

let directory = "";
const saved: Record<string, string | undefined> = {};
const key = { model: "m", effort: "low", instructionsHash: "i", toolsHash: "t" };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-sessions-"));
  for (const name of ["PROXY_STATE_DIR", "CLAUDE_CONFIG_DIR"]) saved[name] = process.env[name];
  process.env.PROXY_STATE_DIR = join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

test("finds only completed sessions with the same key and a shorter history", () => {
  const id = crypto.randomUUID();
  registerSession(id, key);
  expect(findSessions(key, 10)).toHaveLength(0);
  saveSession({ ...key, sessionId: id, seenCount: 3, prefixHash: "h", lastText: "x", lastCallIds: ["c"] });
  expect(findSessions(key, 10)).toEqual([
    { ...key, sessionId: id, seenCount: 3, prefixHash: "h", lastText: "x", lastCallIds: ["c"] },
  ]);
  expect(findSessions(key, 3)).toHaveLength(0);
  expect(findSessions({ ...key, toolsHash: "other" }, 10)).toHaveLength(0);
});

test("a fleet sharing one key does not hide older sessions", () => {
  const fleet = { ...key, toolsHash: "fleet" };
  const target = crypto.randomUUID();
  saveSession({ ...fleet, sessionId: target, seenCount: 4, prefixHash: "target", lastText: "", lastCallIds: [] });
  for (let i = 0; i < 30; i++)
    saveSession({ ...fleet, sessionId: crypto.randomUUID(), seenCount: 5, prefixHash: `other-${i}`, lastText: "", lastCallIds: [] });
  expect(findSessions(fleet, 10).map((s) => s.sessionId)).toContain(target);
});

test("resume checkpoint keeps the successful tool result and excludes a partial failed turn", () => {
  const id = crypto.randomUUID();
  const reply = crypto.randomUUID();
  const project = join(directory, "claude", "projects", "-tmp-checkpoint");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), [
    { type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "success" }] } },
    { type: "user", uuid: reply, message: { content: [{ type: "tool_result", tool_use_id: "success" }] } },
    { type: "user", uuid: crypto.randomUUID() },
    { type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "failure" }] } },
    { type: "user", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_result", tool_use_id: "failure", is_error: true }] } },
    { type: "assistant", uuid: crypto.randomUUID(), isApiErrorMessage: true },
    { type: "cost-state" },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  expect(resumeCheckpoint(id)).toBe(reply);
  expect(resumeCheckpoint(crypto.randomUUID())).toBeUndefined();
});

test("pruning deletes expired sessions and their transcripts, but not kept ones", () => {
  const old = crypto.randomUUID();
  const kept = crypto.randomUUID();
  const project = join(directory, "claude", "projects", "-tmp-x");
  mkdirSync(join(project, old), { recursive: true });
  writeFileSync(join(project, `${old}.jsonl`), "{}");
  writeFileSync(join(project, `${kept}.jsonl`), "{}");
  registerSession(old, key);
  registerSession(kept, key);
  const removed = pruneSessions(-1, new Set([kept]));
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(existsSync(join(project, `${old}.jsonl`))).toBe(false);
  expect(existsSync(join(project, old))).toBe(false);
  expect(existsSync(join(project, `${kept}.jsonl`))).toBe(true);
  expect(findSessions(key, 10).map((s) => s.sessionId)).not.toContain(old);
});


test("a stale response cannot overwrite a failover pin, and pins survive pruning and process exit", () => {
  const thread = crypto.randomUUID();
  pinThreadAccount(thread, "default");
  pinThreadAccount(thread, "spare", "default");
  pinThreadAccount(thread, "default", "default");
  expect(threadAccount(thread)).toBe("spare");
  pruneSessions(-1, new Set());
  const child = Bun.spawnSync([process.execPath, "-e", `import { threadAccount } from ${JSON.stringify(join(import.meta.dir, "../src/sessions.ts"))}; console.log(threadAccount(${JSON.stringify(thread)}));`], { env: process.env });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("spare");
});


test("the first account assignment wins when a key is claimed twice", async () => {
  const { claimThreadAccount } = await import("../src/sessions");
  const thread = crypto.randomUUID();
  expect(claimThreadAccount(thread, "martin")).toBe("martin");
  expect(claimThreadAccount(thread, "default")).toBe("martin");
});
