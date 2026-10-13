import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import {
  COMPACTION_NOTE,
  currentTurnStart,
  perpetualThread,
  preparePerpetual,
  setPerpetualDeps,
} from "../src/perpetual";
import type { PerpetualConfig } from "../src/perpetual/config";
import { inScope } from "../src/perpetual/config";
import { ThreadStore } from "../src/perpetual/store";
import { Compactor, type SummaryRunner } from "../src/perpetual/summarizer";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "../src/types";

let directory = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["CLAUDE_BIN", "PROXY_STATE_DIR", "CLAUDE_CONFIG_DIR", "PLATE_ACTIVITY_CONFIG"];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "perpetual-test-"));
  const mock = join(directory, "claude");
  // Records what each Claude process receives and answers by keyword.
  await writeFile(
    mock,
    `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
let turn = 0;
let pending = "";
const log = ${JSON.stringify(join(directory, "inputs.jsonl"))};
const fs = require("node:fs");
const reply = (text, tool_calls = []) =>
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { text, tool_calls } }) + "\\n");
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line).message;
    turn++;
    fs.appendFileSync(log, JSON.stringify({ pid: process.pid, turn, content: message.content }) + "\\n");
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    // Keywords count only in the newest user message, not in the view or raw tail.
    const at = text.lastIndexOf("<user>");
    const newest = at >= 0 ? text.slice(at) : "";
    const fresh = !text.includes("<tool_result");
    if (pending === "date") {
      pending = "";
      reply("", [{ name: "date", arguments: '{"id":0}' }]);
    } else if (fresh && newest.includes("please-zoom-twice")) {
      pending = "date";
      reply("looking", [{ name: "zoom", arguments: '{"id":0,"n":1}' }]);
    } else if (fresh && newest.includes("please-zoom")) reply("", [{ name: "zoom", arguments: '{"id":0,"n":1}' }]);
    else if (fresh && newest.includes("please-both")) reply("both", [{ name: "zoom", arguments: '{"id":0,"n":1}' }, { name: "lookup", arguments: "{}" }]);
    else if (fresh && newest.includes("please-lookup")) reply("", [{ name: "lookup", arguments: "{}" }]);
    else reply("ok " + turn);
  }
}
`,
  );
  await chmod(mock, 0o755);
  for (const name of ENV) saved[name] = process.env[name];
  process.env.CLAUDE_BIN = mock;
  process.env.PROXY_STATE_DIR = join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude-config");
  process.env.PLATE_ACTIVITY_CONFIG = join(directory, "no-plate.json");
});

afterAll(async () => {
  closeIdleWorkers();
  setPerpetualDeps({});
  for (const name of ENV)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  await rm(directory, { recursive: true, force: true });
});

const TITLES: Record<string, string> = {};
let config: PerpetualConfig | undefined;
let summaries = 0;
/** A summarizer that writes a short tagged line per call. */
const fakeRunner: SummaryRunner = () => ({
  async ask(content) {
    summaries++;
    const task = content.filter((block) => block.type === "text").at(-1);
    const text = task?.type === "text" ? task.text : "";
    const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(text)?.[1] ?? "";
    return `S[${input.replace(/\s+/g, " ").slice(0, 60)}]`;
  },
  close() {},
});

let root = "";
beforeEach(async () => {
  closeIdleWorkers();
  root = await mkdtemp(join(directory, "perpetual-"));
  config = { titlePrefix: "Today", threads: undefined, viewMin: 64_000, viewMax: 128_000, summaryModel: "haiku" };
  setPerpetualDeps({ config: () => config, title: (id) => TITLES[id], runner: fakeRunner, root });
  await writeFile(join(directory, "inputs.jsonl"), "");
});

type Recorded = { pid: number; turn: number; content: Array<{ type: string; text?: string; cache_control?: unknown }> };
async function recorded(): Promise<Recorded[]> {
  return (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const textOf = (entry: Recorded) => entry.content.map((block) => block.text ?? "").join("");

const CONTEXT: ResponseInputItem[] = [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "codex developer context" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nbe nice" }] },
];
const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];

async function send(threadId: string, input: ResponseInputItem[], extra: Record<string, unknown> = {}) {
  const response = await handleRequest(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        instructions: "perpetual-test",
        tools,
        prompt_cache_key: threadId,
        input,
        ...extra,
      }),
    }),
  );
  const body = (await response.json()) as any;
  if (!body.output) throw new Error(JSON.stringify(body));
  return body;
}

/** Codex's echo of a response: the items it appends to its history. */
function echo(body: any): ResponseInputItem[] {
  return body.output.map((item: any) => {
    const { id: _id, status: _status, ...rest } = item;
    return rest;
  });
}

function request(threadId: string, input: ResponseInputItem[], extra: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: "claude-opus-5-5", instructions: "x", tools, prompt_cache_key: threadId, input, ...extra };
}

test("scope: title prefix plus optional allowlist", () => {
  const titles: Record<string, string> = { beta: "Today (beta)", today: "Today", other: "Groceries" };
  const lookup = (id: string) => titles[id];
  const base: PerpetualConfig = { titlePrefix: "Today", viewMin: 1, viewMax: 2, summaryModel: "haiku" };
  expect(inScope(base, "beta", lookup)).toBe(true);
  expect(inScope(base, "today", lookup)).toBe(true);
  expect(inScope(base, "other", lookup)).toBe(false);
  expect(inScope(base, "unknown", lookup)).toBe(false);
  const staged = { ...base, threads: ["beta"] };
  expect(inScope(staged, "beta", lookup)).toBe(true);
  expect(inScope(staged, "today", lookup)).toBe(false);
});

test("requests outside scope pass through untouched", async () => {
  TITLES["pt-other"] = "Groceries";
  TITLES["pt-today"] = "Today";
  TITLES["pt-beta"] = "Today (beta)";
  config!.threads = ["pt-beta"];
  const input = [...CONTEXT, user("hello")];
  expect(preparePerpetual(request("pt-other", input))).toBeUndefined();
  expect(preparePerpetual(request("pt-today", input))).toBeUndefined(); // not yet allowlisted
  expect(preparePerpetual(request("pt-beta", input, { input: "string input" }))).toBeUndefined();
  const subagent = { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_source: "subagent" }) } };
  expect(preparePerpetual({ ...request("pt-beta", input), ...subagent } as ResponsesRequest)).toBeUndefined();
  const titleRequest = { client_metadata: { "x-codex-turn-metadata": { request_kind: "title" } } };
  expect(preparePerpetual({ ...request("pt-beta", input), ...titleRequest } as ResponsesRequest)).toBeUndefined();
  expect(preparePerpetual(request("pt-beta", input))).toBeDefined();
  // No log is created for threads out of scope.
  expect(readdirSync(root)).toEqual(["pt-beta"]);

  // Claude receives byte-identical input whether or not perpetual mode exists.
  await send("pt-other", [...CONTEXT, user("identical")]);
  config = undefined;
  await send("pt-other-2", [...CONTEXT, user("identical")]);
  const [withMode, without] = await recorded();
  expect(withMode.content).toEqual(without.content);
  expect(textOf(withMode)).not.toContain("perpetual_memory");
});

test("turn detection: the current turn starts after the last final answer", () => {
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
  const call = { type: "function_call", name: "lookup", arguments: "{}", call_id: "c1" };
  const output = { type: "function_call_output", call_id: "c1", output: "r" };
  const commentary = { ...answer, content: [{ type: "output_text", text: "checking" }] };
  expect(currentTurnStart([user("a")])).toBe(0);
  expect(currentTurnStart([user("a"), answer, user("b")])).toBe(2);
  expect(currentTurnStart([user("a"), answer, user("b"), commentary, call, output])).toBe(2);
  // A message sent mid-turn stays in the turn.
  expect(currentTurnStart([user("a"), answer, user("b"), call, output, user("also")])).toBe(2);
  expect(currentTurnStart([user("a"), call, output, user("<turn_aborted>"), user("c")])).toBe(4);
});

test("completed turns collapse into the view; whole view blocks stay a cache prefix", async () => {
  const id = "view-thread";
  TITLES[id] = "Today (beta)";
  let history: ResponseInputItem[] = [...CONTEXT];
  const views: Recorded[] = [];
  for (let turn = 0; turn < 12; turn++) {
    history = [...history, user(`message ${turn} ${"x".repeat(turn % 3 === 0 ? 600 : 10)}`)];
    const before = (await recorded()).length;
    const body = await send(id, history);
    history = [...history, ...echo(body)];
    const entries = (await recorded()).slice(before);
    expect(entries).toHaveLength(1);
    views.push(entries[0]);
    await perpetualThread(id)!.compactor.idle();
  }
  const store = perpetualThread(id)!.store;
  // 12 user messages and 11 echoed answers are logged once each, in order
  // (Codex echoes the last answer with the next request).
  expect(store.length).toBe(23);
  expect(store.messages.map((message) => message.kind).slice(0, 4)).toEqual(["user", "assistant", "user", "assistant"]);
  // Long messages went through the summarizer; short ones are their own lines.
  expect(store.node(0, 0)).toStartWith("S[");
  expect(store.node(0, 2)).toBe("user: message 1 xxxxxxxxxx");
  const last = views.at(-1)!;
  const text = textOf(last);
  expect(text).toContain("<chat>\n0+1|S[");
  // Previous turns are covered by the view, not repeated raw.
  expect(text).not.toContain("<user>\nmessage 10");
  expect(text).toContain("message 11");
  // The perpetual prompt and zoom tool sit in the system prompt, not the message.
  expect(text).not.toContain("perpetual_memory");
  expect(text).not.toContain("- name: zoom");
  const prompts = join(directory, "state", "system-prompts");
  const systemPrompts = readdirSync(prompts).map((name) => readFileSync(join(prompts, name), "utf8"));
  expect(systemPrompts.some((prompt) => prompt.includes("<perpetual_memory>") && prompt.includes("- name: zoom"))).toBe(true);
  // Marks: one on the last whole 4-line block, each with Claude Code's 1h TTL.
  const marked = last.content.filter((block) => block.cache_control);
  expect(marked).toHaveLength(1);
  expect(marked[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(marked[0].text!.trimEnd().split("\n").filter((line) => /^\d+\+\d+\|/.test(line))).toHaveLength(4);
  // Every marked prefix of an earlier turn is a prefix of every later turn.
  for (let k = 1; k < views.length; k++) {
    const earlier = views[k - 1].content;
    const mark = earlier.findIndex((block) => block.cache_control);
    if (mark < 0) continue;
    expect(views[k].content.slice(0, mark + 1).map((block) => block.text)).toEqual(
      earlier.slice(0, mark + 1).map((block) => block.text),
    );
  }
  // view.json is the source of truth and survives a reload unchanged.
  const saved = JSON.parse(readFileSync(join(root, id, "view.json"), "utf8"));
  expect(saved.lines).toEqual(store.view.lines);
  expect(saved.end).toBe(22);
});

test("the sawtooth batch rewrites the view once, then it grows at its end again", async () => {
  const id = "batch-thread";
  TITLES[id] = "Today (beta)";
  config = { ...config!, viewMin: 400, viewMax: 1_200 };
  let history: ResponseInputItem[] = [...CONTEXT];
  for (let turn = 0; turn < 20; turn++) {
    history = [...history, user(`m${turn} ${"w".repeat(60)}`)];
    history = [...history, ...echo(await send(id, history))];
    await perpetualThread(id)!.compactor.idle();
  }
  const store = perpetualThread(id)!.store;
  const view = store.view;
  expect(view.lines.some(([level]) => level > 0)).toBe(true);
  const bytes = view.lines.reduce(
    (sum, [level, index]) => sum + 1 + Buffer.byteLength(`${index * 2 ** level}+${2 ** level}|${store.node(level, index)}`),
    0,
  );
  expect(bytes).toBeLessThanOrEqual(1_200);
  expect(view.lines.length).toBeLessThan(view.end);
  let at = 0;
  for (const [level, index] of view.lines) {
    expect(index * 2 ** level).toBe(at);
    at += 2 ** level;
  }
  expect(at).toBe(view.end);
});

test("an in-flight tool loop continues in the same Claude worker with only the new items", async () => {
  const id = "loop-thread";
  TITLES[id] = "Today (beta)";
  let history: ResponseInputItem[] = [...CONTEXT, user("first")];
  history = [...history, ...echo(await send(id, history))];
  await perpetualThread(id)!.compactor.idle();
  history = [...history, user("please-lookup now")];
  const before = (await recorded()).length;
  const body = await send(id, history);
  const call = body.output.find((item: any) => item.type === "function_call");
  expect(call.name).toBe("lookup");
  history = [...history, ...echo(body), { type: "function_call_output", call_id: call.call_id, output: "lookup-result-42" }];
  const done = await send(id, history);
  expect(done.output[0].content[0].text).toStartWith("ok");
  const [start, continuation] = (await recorded()).slice(before);
  expect(continuation.pid).toBe(start.pid);
  expect(textOf(continuation)).toContain("lookup-result-42");
  expect(textOf(continuation)).not.toContain("<chat>");
  // The turn's own items stay raw while it runs; the view holds only the finished turn.
  expect(textOf(start)).toContain("please-lookup now");
  expect(textOf(start)).toContain("0+1|user: first");
});

test("zoom is answered by the proxy and never reaches Codex", async () => {
  const id = "zoom-thread";
  TITLES[id] = "Today (beta)";
  let history: ResponseInputItem[] = [...CONTEXT, user("the secret is PF-1234 at https://github.com/o/r/pull/9")];
  history = [...history, ...echo(await send(id, history))];
  await perpetualThread(id)!.compactor.idle();
  history = [...history, user("please-zoom into the secret")];
  const before = (await recorded()).length;
  const body = await send(id, history);
  expect(body.output.every((item: any) => item.type === "message")).toBe(true);
  const [ask, answered] = (await recorded()).slice(before);
  expect(answered.pid).toBe(ask.pid);
  expect(textOf(answered)).toContain("0+1|user: the secret is PF-1234 at https://github.com/o/r/pull/9");
  // The next Codex request lacks the zoom items; the proxy puts them back so
  // the same worker continues.
  history = [...history, ...echo(body), user("please-lookup next")];
  const next = await send(id, history);
  const call = next.output.find((item: any) => item.type === "function_call");
  history = [...history, ...echo(next), { type: "function_call_output", call_id: call.call_id, output: "r" }];
  await send(id, history);
  const later = (await recorded()).slice(before + 2);
  expect(later).toHaveLength(2);
  expect(later[1].pid).toBe(later[0].pid);
  // The zoom call and a short echo are logged; the memory text is not repeated.
  const kinds = perpetualThread(id)!.store.messages.map((message) => `${message.kind}:${message.text}`);
  expect(kinds).toContain('tool:zoom {"id":0,"n":1}');
  expect(kinds.find((entry) => entry.startsWith("echo:zoom:"))).toMatch(/not repeated in the log/);
});

test("chained zoom and date hops, and mixed calls, keep one worker", async () => {
  const id = "mixed-thread";
  TITLES[id] = "Today (beta)";
  let history: ResponseInputItem[] = [...CONTEXT, user("hello")];
  history = [...history, ...echo(await send(id, history))];
  history = [...history, user("please-zoom-twice")];
  const before = (await recorded()).length;
  const twice = await send(id, history);
  expect(twice.output.filter((item: any) => item.type === "function_call")).toHaveLength(0);
  const hops = (await recorded()).slice(before);
  expect(hops).toHaveLength(3);
  expect(new Set(hops.map((entry) => entry.pid)).size).toBe(1);
  expect(textOf(hops[2])).toMatch(/0: \d{4}-\d\d-\d\dT/);
  history = [...history, ...echo(twice), user("please-both")];
  const both = await send(id, history);
  const calls = both.output.filter((item: any) => item.type === "function_call");
  expect(calls.map((item: any) => item.name)).toEqual(["lookup"]);
  history = [...history, ...echo(both), { type: "function_call_output", call_id: calls[0].call_id, output: "r" }];
  const mark = (await recorded()).length;
  await send(id, history);
  const [continued] = (await recorded()).slice(mark);
  const bothStart = (await recorded()).slice(before + 3)[0];
  expect(continued.pid).toBe(bothStart.pid);
  expect(textOf(continued)).toContain("0+1|user: hello");
});

test("images are logged by path and re-attached by zoom", async () => {
  const id = "image-thread";
  TITLES[id] = "Today (beta)";
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const photo: ResponseInputItem = {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "look at this" },
      { type: "input_image", image_url: `data:image/png;base64,${png}` },
    ],
  };
  const plan = preparePerpetual(request(id, [...CONTEXT, photo]))!;
  const store = perpetualThread(id)!.store;
  const [message] = store.messages;
  expect(message.images).toHaveLength(1);
  expect(message.images![0].path).toStartWith(join(root, id, "images"));
  expect(message.images![0].caption).toBe("image/png, 1 KB");
  expect(message.text).toContain(`[image 1: ${message.images![0].path} (image/png, 1 KB)]`);
  expect(existsSync(message.images![0].path)).toBe(true);
  const sent: ResponsesRequest[] = [];
  let hop = 0;
  await plan.run(async (next): Promise<ProxyOutput> => {
    sent.push(next);
    hop++;
    return hop === 1
      ? { text: "", toolCalls: [{ name: "zoom", arguments: '{"id":0,"n":1}', callId: "call_z" }], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      : { text: "seen", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  });
  const result = (sent[1].input as ResponseInputItem[]).at(-1)!;
  expect(result.type).toBe("function_call_output");
  const parts = result.output as Array<{ type: string; image_url?: string }>;
  expect(parts[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png}` });
});

test("a Codex compaction in a perpetual chat costs no model call", async () => {
  const id = "compact-thread";
  TITLES[id] = "Today (beta)";
  const before = (await recorded()).length;
  const body = await send(id, [...CONTEXT, user("hi"), { type: "compaction_trigger" } as ResponseInputItem]);
  expect((await recorded()).length).toBe(before);
  const item = body.output.find((entry: any) => entry.type === "compaction");
  expect(Buffer.from(item.encrypted_content.split(":")[1], "base64").toString()).toBe(COMPACTION_NOTE);
});

test("summarizer: free nodes, merges, the too-long retry, and failure backoff", async () => {
  const dir = await mkdtemp(join(directory, "compactor-"));
  const store = new ThreadStore(dir);
  store.append([
    { kind: "user", text: "short one", key: "a" },
    { kind: "assistant", text: "y".repeat(900), key: "b" },
    { kind: "user", text: "z".repeat(900), key: "c" },
    { kind: "echo", text: "tiny", key: "d" },
  ]);
  const asks: string[][] = [];
  let failNext = true;
  let now = 0;
  const runner: SummaryRunner = () => {
    const conversation: string[] = [];
    asks.push(conversation);
    return {
      async ask(content) {
        const text = content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
        conversation.push(text);
        if (text.includes("zzzz") && failNext) {
          failNext = false;
          throw new Error("boom");
        }
        if (text.startsWith("Too long")) return "short-y";
        if (text.includes("yyyy")) return "Y".repeat(700);
        if (text.includes("zzzz")) return "short-z";
        return "merged";
      },
      close() {},
    };
  };
  const compactor = new Compactor(store, { threadId: "t", runner, retryMs: 1_000, now: () => now });
  compactor.kick();
  await compactor.idle();
  expect(store.node(0, 0)).toBe("user: short one");
  expect(store.node(0, 3)).toBe("echo: tiny");
  // Over 512 bytes: the same conversation is told the size and shown the cut.
  expect(store.node(0, 1)).toBe("short-y");
  const yConversation = asks.find((conversation) => conversation[0].includes("yyyy"))!;
  expect(yConversation[1]).toContain("Too long: your line is 700 bytes");
  expect(yConversation[1]).toContain("| <- LIMIT");
  // The compaction prompt carries the ruler and the context of earlier lines.
  expect(yConversation[0]).toContain("-".repeat(512));
  expect(yConversation[0]).toContain("<chat>\n0+1|user: short one");
  // The failed call waits for its backoff, then the next kick retries it.
  expect(store.built(0, 2)).toBe(false);
  compactor.kick();
  await compactor.idle();
  expect(store.built(0, 2)).toBe(false);
  now = 1_001;
  compactor.kick();
  await compactor.idle();
  expect(store.node(0, 2)).toBe("short-z");
  // Merges follow once both halves exist; two short lines join without a call.
  expect(store.node(1, 0)).toBe("user: short one\nshort-y");
  expect(store.node(1, 1)).toBe("short-z\necho: tiny");
  expect(store.node(2, 0)).toBe("user: short one\nshort-y\nshort-z\necho: tiny");
  // Reloading reads the logs back; nothing is rebuilt.
  const calls = asks.length;
  const reopened = new ThreadStore(dir);
  expect(reopened.node(1, 1)).toBe("short-z\necho: tiny");
  new Compactor(reopened, { threadId: "t", runner }).kick();
  expect(asks.length).toBe(calls);
});

test("the log is append-only and owned by one process", async () => {
  const dir = await mkdtemp(join(directory, "lock-"));
  const store = new ThreadStore(dir);
  store.append([{ kind: "user", text: "one", key: "k1" }]);
  const file = join(dir, "main", readdirSync(join(dir, "main"))[0]);
  const first = readFileSync(file, "utf8");
  store.append([{ kind: "user", text: "two", key: "k2" }]);
  expect(readFileSync(file, "utf8").startsWith(first)).toBe(true);
  // Another live process holds the lock: opening fails.
  await writeFile(join(dir, "lock"), String(process.ppid));
  expect(() => new ThreadStore(dir)).toThrow(/owned by process/);
  // A dead owner's lock is reclaimed.
  await writeFile(join(dir, "lock"), "999999999");
  expect(new ThreadStore(dir).length).toBe(2);
});
