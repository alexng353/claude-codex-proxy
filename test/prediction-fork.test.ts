import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { answerDigest, forkArgs, parseForkResult } from "../src/prediction-fork";

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
  // "use a tool" in the input makes this turn end in a tool call, as a working turn does.
  // "prose answer": the model writes its answer as plain text and submits an empty
  // StructuredOutput, which the proxy replaces with the prose (the transcript keeps "").
  // "slow turn": the answer takes a moment, so a prediction can run while it is going.
  if (line.includes("slow turn")) {
    appendFileSync(${JSON.stringify(join(root, "slow.started"))}, "1");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const prose = line.includes("prose answer");
  if (prose) console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "prose reply" }] } }));
  const output = line.includes("use a tool")
    ? { text: "", tool_calls: [{ name: "valid", arguments: "{}" }] }
    : { text: prose ? "" : "done for now", tool_calls: [] };
  appendFileSync(file, JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "answer" + count, input: output }] } }) + "\\n");
  appendFileSync(file, JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-00000000000" + count, message: { content: [{ type: "tool_result", tool_use_id: "answer" + count }] } }) + "\\n");
  // Totals add up every API call of the query; iterations holds the last call only.
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: output,
    usage: { input_tokens: 15, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 40,
      iterations: [
        { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900, output_tokens: 20 },
      ] } }));
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

/** What Today sends after the fake chat's turn: the digest of the answer it ended on. */
const DONE = answerDigest("done for now");

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

    const outcome = await forkPrediction(thread, new AbortController().signal, Date.now() + 10_000, DONE);
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
    // The chat's own effort: forcing low measured no faster and had a longer tail.
    expect(fork.argv[fork.argv.indexOf("--effort") + 1]).toBe("high");
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
    expect(await forkPrediction(crypto.randomUUID(), signal, Date.now() + 5000, DONE)).toMatchObject({ kind: "failed", reason: "no session" });
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    // The daemon's turn ended on another answer (a newer turn served by another proxy copy).
    expect(await forkPrediction(thread, signal, Date.now() + 5000, answerDigest("something else"))).toMatchObject({ kind: "failed", reason: "stale" });
    // ...even one that ends with the same words, quoted role marker and all.
    expect(await forkPrediction(thread, signal, Date.now() + 5000, answerDigest("Here is the earlier transcript:\n\nAssistant: done for now"))).toMatchObject({ kind: "failed", reason: "stale" });
    // A daemon that sends no digest gets no fork.
    expect(await forkPrediction(thread, signal, Date.now() + 5000, undefined)).toMatchObject({ kind: "failed", reason: "stale" });
    const { markLimited, listAccounts } = await import("../src/accounts");
    markLimited(listAccounts()[0]!);
    expect(await forkPrediction(thread, signal, Date.now() + 5000, DONE)).toMatchObject({ kind: "failed", reason: "account unavailable" });
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("the answer digest is the wire contract Today pins", () => {
  // The same vectors as predictions.rs the_answer_digest_names_the_last_agent_message_exactly.
  expect(answerDigest("  done\n")).toBe("a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211");
  // Only ASCII whitespace is trimmed: a BOM stays, as in Rust.
  expect(answerDigest("﻿done \t\r\n")).toBe("f95c98c274500e4c8b8da54a12a612d3f1286249769fdf1b0b4f1892678cf4b8");
});

test("a later park of the chat on another proxy copy makes this copy's record stale", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const { recordThreadPark } = await import("../src/sessions");
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    // The other copy served the next turn, ending with the same words.
    recordThreadPark(thread, crypto.randomUUID());
    expect(await forkPrediction(thread, new AbortController().signal, Date.now() + 5000, DONE)).toMatchObject({ kind: "failed", reason: "stale" });
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("a later turn that ends in a tool call retires the chat's fork record", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    const tools = [{ type: "function", name: "valid", parameters: { type: "object", properties: {} } }];
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread, tools });
    await runClaude({
      model: "sonnet",
      input: [{ role: "user", content: "go" }, { role: "assistant", content: "done for now" }, { role: "user", content: "use a tool" }],
      prompt_cache_key: thread,
      tools,
    });
    expect(await forkPrediction(thread, new AbortController().signal, Date.now() + 5000, DONE)).toMatchObject({ reason: "no session" });
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("an old or too large record makes no fork", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async () => {
    const { recordForkSource, forkPrediction } = await import("../src/prediction-fork");
    const { listAccounts } = await import("../src/accounts");
    const source = {
      bin: "/nonexistent/claude",
      args: ["-p"],
      sessionId: crypto.randomUUID(),
      account: listAccounts()[0]!,
      answer: "done for now",
      checkpointText: "done for now",
      contextTokens: 10,
      parkedAt: Date.now(),
    };
    const signal = new AbortController().signal;
    recordForkSource("stale", { ...source, parkedAt: Date.now() - 11 * 60_000 });
    expect(await forkPrediction("stale", signal, Date.now() + 5000, DONE)).toMatchObject({ reason: "no session" });
    const { recordThreadPark } = await import("../src/sessions");
    recordThreadPark("large", source.sessionId);
    recordForkSource("large", { ...source, contextTokens: 300_001 });
    expect(await forkPrediction("large", signal, Date.now() + 5000, DONE)).toMatchObject({ reason: "context too large" });
  });
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
    const pending = forkPrediction(thread, controller.signal, Date.now() + 10_000, DONE);
    for (let i = 0; i < 100 && !existsSync(join(root, "hang.pid")); i++) await Bun.sleep(20);
    controller.abort();
    // It ran but reported no usage: its context (the last call's input, not the
    // query's total) is logged as an estimate of what it read.
    expect(await pending).toMatchObject({ kind: "failed", reason: "cancelled", unmeteredContextTokens: 4910 });
    const pid = Number(await readFile(join(root, "hang.pid"), "utf8"));
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

test("a turn in progress on the chat retires its fork record from its start", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    const next = runClaude({
      model: "sonnet",
      input: [{ role: "user", content: "go" }, { role: "assistant", content: "done for now" }, { role: "user", content: "slow turn" }],
      prompt_cache_key: thread,
    });
    for (let i = 0; i < 200 && !existsSync(join(root, "slow.started")); i++) await Bun.sleep(10);
    expect(await forkPrediction(thread, new AbortController().signal, Date.now() + 5000, DONE)).toMatchObject({ reason: "no session" });
    await next;
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("the fork resumes only at the parked answer's own transcript entry", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    await runClaude({ model: "sonnet", input: "go", prompt_cache_key: thread });
    const [worker] = await lines(join(root, "launches.jsonl"));
    const session = worker.argv[worker.argv.indexOf("--session-id") + 1];
    const transcript = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "probe", `${session}.jsonl`);
    const signal = new AbortController().signal;
    // An unreadable transcript is a failed fork (Haiku answers), never a thrown request.
    // Checked while its checkpoint would otherwise match; root reads it anyway.
    if (process.getuid?.() !== 0) {
      await chmod(transcript, 0o000);
      expect(await forkPrediction(thread, signal, Date.now() + 5000, DONE)).toMatchObject({ kind: "failed", reason: "no checkpoint" });
      await chmod(transcript, 0o600);
    }
    // A later answer in the transcript that is not the one parked: never resume past it.
    const later = (await readFile(transcript, "utf8")) +
      JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "later", input: { text: "a later answer", tool_calls: [] } }] } }) + "\n" +
      JSON.stringify({ type: "user", uuid: "00000000-0000-4000-8000-000000000009", message: { content: [{ type: "tool_result", tool_use_id: "later" }] } }) + "\n";
    await writeFile(transcript, later);
    expect(await forkPrediction(thread, signal, Date.now() + 5000, DONE)).toMatchObject({ reason: "no checkpoint" });
    expect((await lines(join(root, "launches.jsonl"))).some((launch) => launch.fork)).toBe(false);
  });
});

test("an answer the proxy rewrote still forks at its raw transcript entry", async () => {
  await withProxyState({ text: "ship it", tool_calls: [] }, async (root) => {
    const { runClaude } = await import("../src/claude");
    const { forkPrediction } = await import("../src/prediction-fork");
    const thread = crypto.randomUUID();
    const answer = await runClaude({ model: "sonnet", input: "prose answer", prompt_cache_key: thread });
    expect(answer.text).toBe("prose reply");
    const outcome = await forkPrediction(thread, new AbortController().signal, Date.now() + 5000, answerDigest("prose reply"));
    expect(outcome).toMatchObject({ kind: "suggested", text: "ship it" });
    const fork = (await lines(join(root, "launches.jsonl"))).find((launch) => launch.fork)!;
    expect(fork.argv[fork.argv.indexOf("--resume-session-at") + 1]).toBe("00000000-0000-4000-8000-000000000001");
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
    // A duplicate of a request still running is skipped, and must not take its record.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = service(async () => {
      await gate;
      return { kind: "suggested", text: "secret slow fork", usage: forkTokens, account: "work" };
    });
    const original = call(slow, "turn-3");
    await Bun.sleep(20);
    expect(await call(slow, "turn-3")).toEqual({ prediction: null, source: "skipped" });
    release();
    expect(await original).toEqual({ prediction: "secret slow fork", source: "fork" });
    // A fork that ran out of time reported no tokens: its context is the upper bound.
    await call(service(async () => ({ kind: "failed", reason: "timed out", unmeteredContextTokens: 250_000, account: "work" })), "turn-4");
    const raw = await readFile(join(root, "prediction-usage.jsonl"), "utf8");
    expect(raw).not.toContain("secret");
    const [first, second, skipped, slowFork, late] = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(first).toMatchObject({ threadId: "today-chat", turnId: "turn-1", model: "fork", forkUsage: forkTokens, forkAccount: "work", suggested: true });
    expect(typeof first.forkMs).toBe("number");
    expect(first.fallback).toBeUndefined();
    expect(second).toMatchObject({ threadId: "today-chat", turnId: "turn-2", model: "haiku", fallback: "account unavailable", haikuUsage: haikuTokens });
    expect(typeof second.elapsedMs).toBe("number");
    expect(skipped).toMatchObject({ turnId: "turn-3", model: "skipped", suggested: false });
    expect(slowFork).toMatchObject({ turnId: "turn-3", model: "fork", forkUsage: forkTokens, forkAccount: "work", suggested: true });
    expect(late).toMatchObject({ turnId: "turn-4", model: "haiku", fallback: "timed out", forkUnmeteredContextTokens: 250_000, forkAccount: "work" });
  } finally {
    if (saved === undefined) delete process.env.PREDICTION_INDEX;
    else process.env.PREDICTION_INDEX = saved;
    if (savedKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = savedKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork cancelled mid-flight is logged as a cancelled fork, never as Haiku", async () => {
  const { createPredictionService, handlePredictionRoute } = await import("../src/prediction-route");
  const root = await mkdtemp(join(tmpdir(), "prediction-cancel-"));
  const saved = { index: process.env.PREDICTION_INDEX, key: process.env.PROXY_API_KEY };
  process.env.PREDICTION_INDEX = join(root, "index.sqlite");
  process.env.PROXY_API_KEY = "prediction-cancel-test";
  const controller = new AbortController();
  let haiku = 0;
  const engine = createPredictionService({
    prepare: async () => ({ prompt: "p", retrievalMs: 0, guardMs: 0 }),
    generate: async () => (haiku++, "never"),
    guardReply: async () => true,
    refresh: () => {},
    source: () => "fork",
    fork: async () => {
      controller.abort();
      await Bun.sleep(5);
      // It answers anyway, after Alex typed: the route alone must call this cancelled.
      return { kind: "suggested", text: "too late", usage: { inputTokens: 4, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 9 }, account: "work" };
    },
  } as never);
  try {
    const body = JSON.stringify({ threadId: "today-chat", turnId: "turn-c", context: "Assistant: done", engineThreadId: "engine-chat" });
    const request = new Request("http://127.0.0.1:3456/composer-predictions", {
      method: "POST",
      body,
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: "Bearer prediction-cancel-test" },
    });
    await handlePredictionRoute(request, new URL(request.url), "127.0.0.1", engine);
    const path = join(root, "prediction-usage.jsonl");
    for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(10);
    const [line] = await lines(path);
    expect(line).toMatchObject({ turnId: "turn-c", model: "haiku", fallback: "cancelled", cancelled: true, forkAccount: "work" });
    expect(line.forkUsage?.cacheReadTokens).toBe(1000);
    expect(typeof line.forkMs).toBe("number");
    expect(haiku).toBe(0);
  } finally {
    for (const [key, value] of [["PREDICTION_INDEX", saved.index], ["PROXY_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork overtaken by the deadline is logged as timed out, not cancelled", async () => {
  const { createPredictionService } = await import("../src/prediction-route");
  const engine = createPredictionService({
    prepare: async () => ({ prompt: "p", retrievalMs: 0, guardMs: 0 }),
    generate: async () => "never",
    guardReply: async () => true,
    refresh: () => {},
    source: () => "fork",
    fork: async () => {
      await Bun.sleep(150);
      return { kind: "suggested", text: "late", account: "work" };
    },
  } as never);
  const { takeAttemptForTest } = await import("../src/prediction-route");
  const attemptId = crypto.randomUUID();
  const result = await engine.predict({ threadId: "t", turnId: "d", context: "Assistant: done", engineThreadId: "e", attemptId, deadlineMs: Date.now() + 50 });
  expect(result).toBeNull();
  expect(takeAttemptForTest(attemptId)).toMatchObject({ source: "haiku", fallback: "timed out" });
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
