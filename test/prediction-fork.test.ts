import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { forkArgs, parseForkResult } from "../src/prediction-fork";

test("a fork swaps every session flag of the worker for a resume that persists nothing", () => {
  const worker = [
    "--effort", "high", "-p", "--dangerously-skip-permissions",
    "--resume", "older", "--fork-session", "--session-id", "live", "--resume-session-at", "old-checkpoint",
    "--model", "claude-opus-5-5", "--system-prompt-file", "/p/abc.txt", "--json-schema", "{}",
  ];
  const args = forkArgs(worker, "live", "checkpoint", "low");
  expect(args).not.toContain("--session-id");
  expect(args).not.toContain("older");
  expect(args).not.toContain("old-checkpoint");
  expect(args.slice(args.indexOf("-p") + 1, args.indexOf("-p") + 7)).toEqual([
    "--resume", "live", "--fork-session", "--no-session-persistence", "--resume-session-at", "checkpoint",
  ]);
  // Everything that shapes the cached prefix is kept as the worker had it.
  for (const kept of ["--model", "claude-opus-5-5", "--system-prompt-file", "/p/abc.txt", "--json-schema", "{}"])
    expect(args).toContain(kept);
  expect(args[args.indexOf("--effort") + 1]).toBe("low");
  expect(forkArgs(["-p", "--model", "m"], "s", undefined, "low")).toEqual([
    "-p", "--resume", "s", "--fork-session", "--no-session-persistence", "--model", "m", "--effort", "low",
  ]);
});

test("a fork's answer counts only as one plain line of text with no tool call", () => {
  const result = (output: unknown) => ({ type: "result", is_error: false, structured_output: output });
  expect(parseForkResult(result({ text: " sounds good ", tool_calls: [] }))).toMatchObject({ kind: "suggested", text: "sounds good" });
  expect(parseForkResult(result({ text: "", tool_calls: [] })).kind).toBe("declined");
  expect(parseForkResult(result({ text: "ok", tool_calls: [{ name: "exec_command", arguments: "{}" }] }))).toMatchObject({ kind: "failed", reason: "tool call" });
  expect(parseForkResult(result({ text: "two\nlines", tool_calls: [] })).kind).toBe("failed");
  expect(parseForkResult(result({ text: "x".repeat(501), tool_calls: [] })).kind).toBe("failed");
  expect(parseForkResult({ type: "result", is_error: true, result: "rate limited" })).toMatchObject({ kind: "failed", reason: "error" });
  const usage = parseForkResult({
    ...result({ text: "ok", tool_calls: [] }),
    usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 7 },
  }).usage;
  expect(usage).toEqual({ inputTokens: 4, cacheReadTokens: 1000, cacheWriteTokens: 20, outputTokens: 7 });
});

/** A fake Claude CLI: records argv and stdin, keeps a transcript, answers each line. */
async function fakeCli(root: string, forkAnswer: unknown) {
  const fake = join(root, "fake.mjs");
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const fork = argv.includes("--no-session-persistence");
appendFileSync(${JSON.stringify(join(root, "launches.jsonl"))}, JSON.stringify({ argv, fork }) + "\\n");
if (fork && existsSync(${JSON.stringify(join(root, "hang"))})) {
  appendFileSync(${JSON.stringify(join(root, "hang.pid"))}, String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const id = argv[argv.indexOf("--session-id") + 1];
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  count++;
  appendFileSync(${JSON.stringify(join(root, "inputs.jsonl"))}, JSON.stringify({ fork, line }) + "\\n");
  if (fork) {
    console.log(JSON.stringify({ type: "result", is_error: false, structured_output: ${JSON.stringify(forkAnswer)},
      usage: { input_tokens: 4, cache_read_input_tokens: 5000, cache_creation_input_tokens: 30, output_tokens: 9 } }));
    continue;
  }
  const file = join(process.env.CLAUDE_CONFIG_DIR, "projects", "probe", id + ".jsonl");
  appendFileSync(file, JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "answer" + count }] } }) + "\\n");
  appendFileSync(file, JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-00000000000" + count, message: { content: [{ type: "tool_result", tool_use_id: "answer" + count }] } }) + "\\n");
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { text: "done for now", tool_calls: [] },
    usage: { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900, output_tokens: 40 } }));
}
`);
  await chmod(fake, 0o755);
  return fake;
}

async function withProxyState<T>(forkAnswer: unknown, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "prediction-fork-"));
  const base = join(root, "base");
  const state = join(root, "state");
  await mkdir(join(base, "projects", "probe"), { recursive: true });
  await mkdir(state, { recursive: true });
  const keys = ["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR", "PREDICTION_SOURCE"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CLAUDE_BIN = await fakeCli(root, forkAnswer);
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PROXY_STATE_DIR = state;
  const { closeIdleWorkers } = await import("../src/claude");
  const { resetAccountState } = await import("../src/accounts");
  try {
    return await body(root);
  } finally {
    closeIdleWorkers();
    resetAccountState();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const lines = async (path: string) =>
  existsSync(path) ? (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("a fork resumes the chat's parked session at its last answer and leaves no record of itself", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    const tools = [{ type: "function", name: "valid", parameters: { type: "object", properties: {} } }];
    await runClaude({ model: "sonnet", input: "do the thing", prompt_cache_key: thread, tools, reasoning: { effort: "high" } });
    const state = process.env.PROXY_STATE_DIR!;
    const usageBefore = await lines(join(state, "usage.jsonl"));
    const sessions = () =>
      (new Database(join(state, "sessions.sqlite"), { readonly: true }).query("SELECT session_id FROM sessions").all() as unknown[]).length;
    const sessionsBefore = sessions();
    const [worker] = await lines(join(root, "launches.jsonl"));
    const session = worker.argv[worker.argv.indexOf("--session-id") + 1];

    const outcome = await forkPrediction(thread, new AbortController().signal, Date.now() + 10_000);
    expect(outcome).toMatchObject({ kind: "suggested", text: "ship it" });
    expect(outcome.usage?.cacheReadTokens).toBe(5000);

    const launches = await lines(join(root, "launches.jsonl"));
    const fork = launches.find((launch) => launch.fork)!;
    expect(fork.argv[fork.argv.indexOf("--resume") + 1]).toBe(session);
    expect(fork.argv[fork.argv.indexOf("--resume-session-at") + 1]).toBe("00000000-0000-4000-8000-000000000001");
    expect(fork.argv).toContain("--fork-session");
    expect(fork.argv).not.toContain("--session-id");
    // Same prefix as the chat: system prompt file, schema and model.
    for (const flag of ["--system-prompt-file", "--json-schema", "--model"])
      expect(fork.argv[fork.argv.indexOf(flag) + 1]).toBe(worker.argv[worker.argv.indexOf(flag) + 1]);
    const inputs = await lines(join(root, "inputs.jsonl"));
    expect(inputs.filter((input) => input.fork)).toHaveLength(1);
    expect(inputs.find((input) => input.fork).line).toContain("composer_prediction");

    // Invisible: no usage row, no stored session, no transcript, no turn on the worker.
    expect(await lines(join(state, "usage.jsonl"))).toEqual(usageBefore);
    expect(sessions()).toBe(sessionsBefore);
    expect((await readdir(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "probe"))).length).toBe(1);

    // The chat's next turn still continues its own worker, untouched by the fork.
    const next = await runClaude({
      model: "sonnet",
      input: [{ role: "user", content: "do the thing" }, { role: "assistant", content: "done for now" }, { role: "user", content: "next" }],
      prompt_cache_key: thread,
      tools,
      reasoning: { effort: "high" },
    });
    expect(next.text).toBe("done for now");
    expect((await lines(join(root, "launches.jsonl"))).filter((launch) => !launch.fork)).toHaveLength(1);
  });
});

test("no fork without a parked final answer for the chat, or past its account's cap", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const signal = new AbortController().signal;
    expect(await forkPrediction(crypto.randomUUID(), signal, Date.now() + 5000)).toMatchObject({ kind: "failed", reason: "no session" });
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    const { markLimited, listAccounts } = await import("../src/accounts");
    markLimited(listAccounts()[0]!);
    expect(await forkPrediction(thread, signal, Date.now() + 5000)).toMatchObject({ kind: "failed", reason: "account unavailable" });
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("a later tool-call park, or age, retires the chat's fork record", async () => {
  const { recordForkSource, forkPrediction } = await import("../src/prediction-fork");
  const { listAccounts } = await import("../src/accounts");
  const source = {
    bin: "/nonexistent/claude",
    args: ["-p"],
    sessionId: crypto.randomUUID(),
    account: listAccounts()[0]!,
    contextTokens: 10,
    parkedAt: Date.now(),
  };
  const signal = new AbortController().signal;
  recordForkSource("tool-call", source);
  recordForkSource("tool-call", undefined);
  expect(await forkPrediction("tool-call", signal, Date.now() + 5000)).toMatchObject({ reason: "no session" });
  recordForkSource("stale", { ...source, parkedAt: Date.now() - 11 * 60_000 });
  expect(await forkPrediction("stale", signal, Date.now() + 5000)).toMatchObject({ reason: "no session" });
  recordForkSource("large", { ...source, contextTokens: 300_001 });
  expect(await forkPrediction("large", signal, Date.now() + 5000)).toMatchObject({ reason: "context too large" });
});

test("cancelling a fork kills it", async () => {
  await withProxyState({ text: "never", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    // The fork never answers.
    await writeFile(join(root, "hang"), "");
    const controller = new AbortController();
    const pending = forkPrediction(thread, controller.signal, Date.now() + 10_000);
    for (let i = 0; i < 100 && !existsSync(join(root, "hang.pid")); i++) await Bun.sleep(20);
    controller.abort();
    expect(await pending).toMatchObject({ kind: "failed", reason: "cancelled" });
    const pid = Number(await readFile(join(root, "hang.pid"), "utf8"));
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

test("the route asks the fork only when switched on, and falls back to Haiku when it fails", async () => {
  const { createPredictionService } = await import("../src/prediction-route");
  const calls: string[] = [];
  const make = (source: "fork" | "haiku", fork: () => Promise<Record<string, unknown>>) =>
    createPredictionService({
      prepare: async () => ({ prompt: "haiku prompt", retrievalMs: 0, guardMs: 0 }),
      generate: async () => (calls.push("haiku"), "from haiku"),
      guardReply: async () => true,
      refresh: () => {},
      source: () => source,
      fork: async () => (calls.push("fork"), fork() as never),
    } as never);
  const input = (turn: string, engine?: string) => ({ threadId: "t", turnId: turn, context: "Assistant: done", ...(engine ? { engineThreadId: engine } : {}) });
  const suggested = async () => ({ kind: "suggested", text: "from fork" });

  expect(await make("haiku", suggested).predict(input("1", "e"))).toBe("from haiku");
  expect(calls.splice(0)).toEqual(["haiku"]);
  expect(await make("fork", suggested).predict(input("2", "e"))).toBe("from fork");
  expect(calls.splice(0)).toEqual(["fork"]);
  // An old daemon sends no engine thread: Haiku, as before.
  expect(await make("fork", suggested).predict(input("3"))).toBe("from haiku");
  expect(calls.splice(0)).toEqual(["haiku"]);
  expect(await make("fork", async () => ({ kind: "failed", reason: "account unavailable" })).predict(input("4", "e"))).toBe("from haiku");
  expect(calls.splice(0)).toEqual(["fork", "haiku"]);
  // The fork saw the whole chat and chose nothing: no second opinion.
  expect(await make("fork", async () => ({ kind: "declined" })).predict(input("5", "e"))).toBeNull();
  expect(calls.splice(0)).toEqual(["fork"]);
});

test("every attempt logs its path, why, latency and tokens, keyed by chat and turn, never text", async () => {
  const { createPredictionService, handlePredictionRoute } = await import("../src/prediction-route");
  const root = await mkdtemp(join(tmpdir(), "prediction-usage-"));
  const saved = process.env.PREDICTION_INDEX;
  const savedKey = process.env.PROXY_API_KEY;
  process.env.PROXY_API_KEY = "prediction-usage-test";
  process.env.PREDICTION_INDEX = join(root, "index.sqlite");
  const haikuTokens = { inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 12 };
  const forkTokens = { inputTokens: 4, cacheReadTokens: 120_000, cacheWriteTokens: 300, outputTokens: 40 };
  const service = (fork: () => Promise<Record<string, unknown>>) =>
    createPredictionService({
      prepare: async () => ({ prompt: "p", retrievalMs: 0, guardMs: 0 }),
      generate: async (_prompt: string, _signal: AbortSignal, onMetrics?: (m: Record<string, unknown>) => void) => {
        onMetrics?.({ warm: true, spawnMs: 0, modelMs: 1, totalMs: 1, tokens: haikuTokens });
        return "secret haiku text";
      },
      guardReply: async () => true,
      refresh: () => {},
      source: () => "fork",
      fork: fork as never,
    } as never);
  const call = async (engine: ReturnType<typeof service>, turnId: string) => {
    const body = JSON.stringify({ threadId: "today-chat", turnId, context: "Assistant: done", engineThreadId: "engine-chat" });
    const request = new Request("http://127.0.0.1:3456/composer-predictions", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", authorization: "Bearer prediction-usage-test" },
    });
    const response = await handlePredictionRoute(request, new URL(request.url), "127.0.0.1", engine);
    return JSON.parse((await response!.text()).trim());
  };
  try {
    const forked = await call(service(async () => ({ kind: "suggested", text: "secret fork text", usage: forkTokens, account: "work" })), "turn-1");
    expect(forked).toEqual({ prediction: "secret fork text", source: "fork" });
    const fellBack = await call(service(async () => ({ kind: "failed", reason: "account unavailable" })), "turn-2");
    expect(fellBack).toEqual({ prediction: "secret haiku text", source: "haiku" });
    const raw = await readFile(join(root, "prediction-usage.jsonl"), "utf8");
    expect(raw).not.toContain("secret");
    const [first, second] = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(first).toMatchObject({ threadId: "today-chat", turnId: "turn-1", model: "fork", forkUsage: forkTokens, forkAccount: "work", suggested: true });
    expect(typeof first.forkMs).toBe("number");
    expect(first.fallback).toBeUndefined();
    expect(second).toMatchObject({ threadId: "today-chat", turnId: "turn-2", model: "haiku", fallback: "account unavailable", haikuUsage: haikuTokens });
    expect(typeof second.elapsedMs).toBe("number");
  } finally {
    if (saved === undefined) delete process.env.PREDICTION_INDEX;
    else process.env.PREDICTION_INDEX = saved;
    if (savedKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = savedKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("the switch defaults to Haiku and is read on every request", async () => {
  const { predictionSource } = await import("../src/prediction-fork");
  const root = await mkdtemp(join(tmpdir(), "prediction-switch-"));
  const saved = { state: process.env.PROXY_STATE_DIR, source: process.env.PREDICTION_SOURCE };
  delete process.env.PREDICTION_SOURCE;
  process.env.PROXY_STATE_DIR = root;
  try {
    expect(predictionSource()).toBe("haiku");
    await writeFile(join(root, "prediction-source"), "fork\n");
    expect(predictionSource()).toBe("fork");
    await writeFile(join(root, "prediction-source"), "something else");
    expect(predictionSource()).toBe("haiku");
    process.env.PREDICTION_SOURCE = "fork";
    expect(predictionSource()).toBe("fork");
  } finally {
    if (saved.state === undefined) delete process.env.PROXY_STATE_DIR;
    else process.env.PROXY_STATE_DIR = saved.state;
    if (saved.source === undefined) delete process.env.PREDICTION_SOURCE;
    else process.env.PREDICTION_SOURCE = saved.source;
    await rm(root, { recursive: true, force: true });
  }
});
