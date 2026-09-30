import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDb, recordUsage, syncUsage } from "../src/usage";

let root = "";
let run = 0;
let oldStateDir: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-codex-usage-"));
  oldStateDir = process.env.PROXY_STATE_DIR;
});

beforeEach(() => {
  process.env.PROXY_STATE_DIR = join(root, `state-${run++}`);
});

afterAll(async () => {
  if (oldStateDir === undefined) delete process.env.PROXY_STATE_DIR;
  else process.env.PROXY_STATE_DIR = oldStateDir;
  await rm(root, { recursive: true, force: true });
});

type Tokens = { input: number; output: number; read: number; write: number };

/** A JSONL row shaped like Claude Code's: per-turn usage, cumulative modelUsage. */
function row(
  worker: string,
  workerTurn: number,
  turn: Tokens,
  cumulative: Tokens & { cost: number },
  extra: Record<string, unknown> = {},
) {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 29, 12, workerTurn)).toISOString(),
    requestId: crypto.randomUUID(),
    workerId: worker,
    workerTurn,
    model: "claude-opus-5-5",
    effort: "medium",
    attempt: 1,
    launchMode: "minimal",
    resumed: false,
    isError: false,
    subtype: "success",
    usage: {
      input_tokens: turn.input,
      output_tokens: turn.output,
      cache_read_input_tokens: turn.read,
      cache_creation_input_tokens: turn.write,
    },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: cumulative.input,
        outputTokens: cumulative.output,
        cacheReadInputTokens: cumulative.read,
        cacheCreationInputTokens: cumulative.write,
        costUSD: cumulative.cost,
      },
    },
    ...extra,
  };
}

function writeLog(rows: unknown[], partial = "") {
  const directory = process.env.PROXY_STATE_DIR!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "usage.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join("") + partial);
}

function costs(): Array<[string, number, number | null]> {
  return (
    openUsageDb()
      .query("SELECT worker_id, worker_turn, cost_usd FROM turns ORDER BY ts, worker_id")
      .all() as Array<{ worker_id: string; worker_turn: number; cost_usd: number | null }>
  ).map((r) => [r.worker_id, r.worker_turn, r.cost_usd]);
}

test("derives per-turn cost from cumulative totals, including resumed forks", () => {
  writeLog([
    // Fresh worker: turn 1 cumulative equals its own usage.
    row("a", 1, { input: 2, output: 10, read: 0, write: 100 }, { input: 2, output: 10, read: 0, write: 100, cost: 0.5 }),
    row("a", 2, { input: 1, output: 20, read: 100, write: 5 }, { input: 3, output: 30, read: 100, write: 105, cost: 0.6 }),
    // Fork of a's session: inherits a's final totals.
    row("b", 1, { input: 1, output: 5, read: 105, write: 0 }, { input: 4, output: 35, read: 205, write: 105, cost: 0.62 }, { resumed: true }),
    // Mid-worker turn whose usage undercounts: still exact via the previous turn.
    row("b", 2, { input: 1, output: 1, read: 1, write: 0 }, { input: 9, output: 99, read: 999, write: 105, cost: 0.9 }),
    // Fork whose parent totals were never recorded.
    row("c", 1, { input: 1, output: 5, read: 10, write: 0 }, { input: 50, output: 50, read: 50, write: 50, cost: 3 }, { resumed: true }),
    // Failed turn: no tokens, empty modelUsage.
    { ...row("d", 1, { input: 0, output: 0, read: 0, write: 0 }, { input: 0, output: 0, read: 0, write: 0, cost: 0 }), modelUsage: {}, isError: true },
  ]);
  expect(syncUsage()).toBe(6);
  expect(costs()).toEqual([
    ["a", 1, 0.5],
    ["b", 1, 0.02],
    ["c", 1, null],
    ["d", 1, 0],
    ["a", 2, 0.1],
    ["b", 2, 0.28],
  ]);
});

test("fork costs use the recorded parent rather than unrelated matching totals", () => {
  const tokens = { input: 100, output: 0, read: 0, write: 0 };
  writeLog([
    row("parent", 1, tokens, { ...tokens, cost: 0.01 }, { sessionId: "parent-session" }),
    row("unrelated", 2, tokens, { ...tokens, cost: 0.1 }, { sessionId: "other-session" }),
    row("child", 1, { ...tokens, input: 10 }, { ...tokens, input: 110, cost: 0.015 }, {
      resumed: true, resumedFrom: "parent-session", sessionId: "child-session",
    }),
  ]);
  syncUsage();
  expect(openUsageDb().query("SELECT cost_usd FROM turns WHERE worker_id = 'child'").get())
    .toEqual({ cost_usd: 0.005 });
});

test("ambiguous legacy fork totals remain unpriced", () => {
  const tokens = { input: 100, output: 0, read: 0, write: 0 };
  writeLog([
    row("a", 1, tokens, { ...tokens, cost: 0.01 }),
    row("b", 2, tokens, { ...tokens, cost: 0.1 }),
    row("child", 1, { ...tokens, input: 10 }, { ...tokens, input: 110, cost: 0.015 }, { resumed: true }),
  ]);
  syncUsage();
  expect(openUsageDb().query("SELECT cost_usd FROM turns WHERE worker_id = 'child'").get())
    .toEqual({ cost_usd: null });
});

test("sync is incremental, idempotent, and waits for a complete last line", () => {
  const first = row("a", 1, { input: 1, output: 1, read: 0, write: 0 }, { input: 1, output: 1, read: 0, write: 0, cost: 0.1 });
  const second = row("a", 2, { input: 1, output: 1, read: 1, write: 0 }, { input: 2, output: 2, read: 1, write: 0, cost: 0.15 });
  const text = JSON.stringify(second);
  writeLog([first], text.slice(0, 20));
  expect(syncUsage()).toBe(1);
  expect(syncUsage()).toBe(0);
  appendFileSync(join(process.env.PROXY_STATE_DIR!, "usage.jsonl"), text.slice(20) + "\n");
  expect(syncUsage()).toBe(1);
  expect(costs().map((r) => r[2])).toEqual([0.1, 0.05]);

  // A replaced log is re-read from the start without duplicating rows.
  writeLog([first]);
  expect(syncUsage()).toBe(0);
  expect(costs()).toHaveLength(2);
});

test("records thread, session, durations, and token breakdown", () => {
  recordUsage(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1200,
      duration_api_ms: 900,
      usage: {
        input_tokens: 2,
        output_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 60,
        output_tokens_details: { thinking_tokens: 12 },
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 60 },
      } as never,
      modelUsage: {
        "claude-opus-5-5": { inputTokens: 2, outputTokens: 40, cacheReadInputTokens: 1000, cacheCreationInputTokens: 60, costUSD: 0.07 },
      },
    },
    {
      requestId: "r",
      workerId: "w",
      workerTurn: 1,
      model: "claude-opus-5-5",
      effort: "high",
      attempt: 1,
      launchMode: "minimal",
      resumed: false,
      threadId: "thread-1",
      sessionId: "session-1",
    },
  );
  const logged = JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!, "usage.jsonl"), "utf8"));
  expect(logged.threadId).toBe("thread-1");
  expect(openUsageDb().query("SELECT * FROM turns").get()).toMatchObject({
    thread_id: "thread-1",
    session_id: "session-1",
    thinking_tokens: 12,
    cache_write_1h_tokens: 60,
    duration_ms: 1200,
    duration_api_ms: 900,
    cost_usd: 0.07,
  });
  expect(openUsageDb().query("SELECT thread_id, turns, cost_usd FROM usage_by_thread").all()).toEqual([
    { thread_id: "thread-1", turns: 1, cost_usd: 0.07 },
  ]);
});
