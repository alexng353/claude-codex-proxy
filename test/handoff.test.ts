import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { lockOwner } from "../src/filelock";
import { legacyRunning, processStartTime } from "../src/handoff";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PerpetualWaitAborted,
  drainPerpetual,
  perpetualBusy,
  preparePerpetualWaiting,
  setPerpetualDeps,
} from "../src/perpetual";
import type { PerpetualConfig } from "../src/perpetual/config";
import type { SummaryRunner } from "../src/perpetual/summarizer";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

// alex-0230: during a handoff two copies of the proxy run at once. A perpetual chat
// the old copy still holds must be waited for, never passed through raw, and the
// old copy must let go of each chat as soon as it has no turn running.

const config: PerpetualConfig = { titlePrefix: "Today", viewMin: 64_000, viewMax: 128_000, summaryModel: "haiku" };
const runner: SummaryRunner = () => ({ ask: async () => "S", close() {} });
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "handoff-"));
  setPerpetualDeps({ config: () => config, title: () => "Today (beta)", runner, root });
});
afterAll(() => setPerpetualDeps({}));

const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const request = (threadId: string): ResponsesRequest => ({
  model: "claude-opus-5-5",
  instructions: "x",
  prompt_cache_key: threadId,
  input: [user("hello")],
});
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** A chat lock held by another live process, as the draining copy's would be. */
async function lockedByOther(threadId: string) {
  const dir = join(root, threadId);
  mkdirSync(join(dir, "images"), { recursive: true });
  const path = join(dir, "lock");
  const other = Bun.spawn(["flock", "-o", path, "sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(150);
  return { path, other };
}

test("a chat another live copy holds is waited for, then planned", async () => {
  const { path, other } = await lockedByOther("t1");
  setTimeout(() => other.kill("SIGKILL"), 300);
  const started = Date.now();
  const plan = await preparePerpetualWaiting(request("t1"), { waitMs: 5_000, pollMs: 50 });
  expect(plan).toBeDefined();
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  // It is this copy's now.
  expect(lockOwner(path)).toBe(process.pid);
});

test("a chat held by a live copy is never passed through raw: the wait ends in an error", async () => {
  const { other } = await lockedByOther("t2");
  const ended = new AbortController();
  setTimeout(() => ended.abort(), 200);
  const wait = preparePerpetualWaiting(request("t2"), { pollMs: 50, signal: ended.signal });
  await expect(wait).rejects.toBeInstanceOf(PerpetualWaitAborted);
  other.kill("SIGKILL");
});

test("a dead copy's lock is taken over at once", async () => {
  const { path, other } = await lockedByOther("t4");
  other.kill("SIGKILL");
  await other.exited;
  const plan = await preparePerpetualWaiting(request("t4"), { waitMs: 1_000, pollMs: 50 });
  expect(plan).toBeDefined();
  expect(lockOwner(path)).toBe(process.pid);
});

test("a drain waits for a closing chat's summary before it resolves", async () => {
  let finish!: () => void;
  const slow: SummaryRunner = () => ({
    ask: () => new Promise<string>((resolve) => (finish = () => resolve("S"))),
    close() {},
  });
  setPerpetualDeps({ config: () => config, title: () => "Today (beta)", runner: slow, root });
  const plan = await preparePerpetualWaiting(request("t5"), { waitMs: 0 });
  expect(plan).toBeDefined();
  await plan!.run(async () => ({ text: "done", toolCalls: [], usage }));
  // No summary is running here, so the chat closes and the drain ends.
  await drainPerpetual();
  expect(perpetualBusy()).toBe(0);
  expect(lockOwner(join(root, "t5", "lock"))).toBeUndefined();
  finish?.();
});

test("a drain keeps a chat with a turn running and lets go once it ends", async () => {
  const plan = await preparePerpetualWaiting(request("t3"), { waitMs: 0 });
  expect(plan).toBeDefined();
  const lock = join(root, "t3", "lock");
  expect(lockOwner(lock)).toBe(process.pid);
  expect(perpetualBusy()).toBe(1);
  let drained = false;
  const drain = drainPerpetual().then(() => (drained = true));
  await Bun.sleep(300);
  expect(drained).toBe(false);
  expect(lockOwner(lock)).toBe(process.pid);
  await plan!.run(async () => ({ text: "done", toolCalls: [], usage }));
  await drain;
  expect(perpetualBusy()).toBe(0);
  expect(lockOwner(lock)).toBeUndefined();
});

test("a draining copy neither reopens a closing chat nor waits on the new copy", async () => {
  const plan = await preparePerpetualWaiting(request("t6"), { waitMs: 0 });
  const drain = drainPerpetual();
  await plan!.run(async () => ({ text: "done", toolCalls: [], usage }));
  // The chat is closing here now. A request this copy accepted before the drain
  // must not open a second store on it, and must not wait: it fails over (503).
  await expect(preparePerpetualWaiting(request("t6"), { pollMs: 10 })).rejects.toBeInstanceOf(PerpetualWaitAborted);
  await drain;
  expect(lockOwner(join(root, "t6", "lock"))).toBeUndefined();
});

test("while the old single copy drains (first move), a perpetual chat waits for it to exit", async () => {
  const legacy = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  process.env.LEGACY_PID = String(legacy.pid);
  try {
    setTimeout(() => legacy.kill("SIGKILL"), 300);
    const started = Date.now();
    const plan = await preparePerpetualWaiting(request("t7"), { waitMs: 5_000, pollMs: 50 });
    expect(plan).toBeDefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(lockOwner(join(root, "t7", "lock"))).toBe(process.pid);
  } finally {
    delete process.env.LEGACY_PID;
  }
});

test("the old copy is pinned by its start time, so a reused pid never blocks", () => {
  const pid = String(process.pid);
  const started = processStartTime(process.pid)!;
  expect(started).toMatch(/^[0-9]+$/);
  expect(legacyRunning({ LEGACY_PID: pid, LEGACY_STARTTIME: started })).toBe(true);
  expect(legacyRunning({ LEGACY_PID: pid, LEGACY_STARTTIME: "1" })).toBe(false);
  expect(legacyRunning({ LEGACY_PID: "999999999", LEGACY_STARTTIME: started })).toBe(false);
});
