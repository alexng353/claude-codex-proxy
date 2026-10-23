import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perpetualThread, preparePerpetual, setPerpetualDeps } from "../src/perpetual";
import type { PerpetualConfig } from "../src/perpetual/config";
import { itemKeys } from "../src/perpetual/messages";
import { ThreadStore } from "../src/perpetual/store";
import type { SummaryRunner } from "../src/perpetual/summarizer";
import { leadingContextCount } from "../src/request";
import { responseObject } from "../src/responses";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "../src/types";

// A turn's final answer is logged when the turn ends, not when Codex echoes it
// on the next request; the echo then maps onto the same ids.

const config: PerpetualConfig = { titlePrefix: "Today", viewMin: 64_000, viewMax: 128_000, summaryModel: "haiku" };
const runner: SummaryRunner = () => ({ ask: async () => "S", close() {} });
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "perpetual-final-"));
  setPerpetualDeps({ config: () => config, title: () => "Today (beta)", runner, root });
});

afterAll(() => setPerpetualDeps({}));

const CONTEXT: ResponseInputItem[] = [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "codex developer context" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nbe nice" }] },
];
const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];

function request(threadId: string, input: ResponseInputItem[]): ResponsesRequest {
  return { model: "claude-opus-5-5", instructions: "x", tools, prompt_cache_key: threadId, input };
}

/** One Codex request through the real plan/run path; returns what Codex appends to its history. */
async function turn(
  threadId: string,
  history: ResponseInputItem[],
  ...replies: Array<ProxyOutput | AbortSignal>
): Promise<ResponseInputItem[]> {
  const body = request(threadId, history);
  const plan = preparePerpetual(body);
  if (!plan) throw new Error("not perpetual");
  const signal = replies.find((reply): reply is AbortSignal => reply instanceof AbortSignal);
  const outputs = replies.filter((reply): reply is ProxyOutput => !(reply instanceof AbortSignal));
  let hop = 0;
  const output = await plan.run(async () => outputs[Math.min(hop++, outputs.length - 1)], signal);
  return responseObject(body, output).output.map((item) => {
    const { id: _id, status: _status, ...rest } = item as Record<string, unknown>;
    return rest as ResponseInputItem;
  });
}

const say = (text: string): ProxyOutput => ({ text, toolCalls: [], usage });
const store = (threadId: string) => perpetualThread(threadId)!.store;
const log = (threadId: string) => store(threadId).messages.map((m) => `${m.i}|${m.kind}|${m.text}${m.part !== undefined ? `#${m.part}` : ""}`);
const mainLines = (threadId: string) =>
  readdirSync(join(root, threadId, "main")).flatMap((name) =>
    readFileSync(join(root, threadId, "main", name), "utf8").split("\n").filter(Boolean),
  );
/** The item key Codex's history gives the item at `index` of `history`. */
const keyAt = (history: ResponseInputItem[], index: number) => {
  const lead = leadingContextCount(history);
  return itemKeys(history.slice(lead))[index - lead];
};

test("a final answer is logged at turn end and its echo maps onto it", async () => {
  const id = "final-echo";
  let history = [...CONTEXT, user("first")];
  const answer = await turn(id, history, say("the answer"));
  // Logged before Codex sends anything else.
  expect(log(id)).toEqual(["0|user|first", "1|assistant|the answer"]);
  expect(store(id).messages[1].key).toStartWith("final:");

  history = [...history, ...answer, user("second")];
  await turn(id, history, say("another"));
  // Same ids, kinds and texts the echo-time logging produced; no duplicate.
  expect(log(id)).toEqual(["0|user|first", "1|assistant|the answer", "2|user|second", "3|assistant|another"]);
  const echoKey = keyAt(history, CONTEXT.length + 1);
  expect(store(id).idsOf(echoKey)).toEqual([1]);
  expect(mainLines(id)).toHaveLength(4);

  // The alias survives a new store over the same directory.
  setPerpetualDeps({ config: () => config, title: () => "Today (beta)", runner, root });
  const reopened = new ThreadStore(join(root, id));
  expect(reopened.idsOf(echoKey)).toEqual([1]);
  expect(reopened.length).toBe(4);
});

test("a long answer is split the same way and its echo maps onto every part", async () => {
  const id = "final-long";
  const text = "a".repeat(30_000) + "b".repeat(30_000) + "c".repeat(5);
  let history = [...CONTEXT, user("write a lot")];
  const answer = await turn(id, history, say(text));
  expect(store(id).messages.map((m) => [m.i, m.kind, m.part, m.text.length])).toEqual([
    [0, "user", undefined, 11],
    [1, "assistant", 0, 30_000],
    [2, "assistant", 1, 30_000],
    [3, "assistant", 2, 5],
  ]);
  history = [...history, ...answer, user("thanks")];
  await turn(id, history, say("np"));
  expect(store(id).idsOf(keyAt(history, CONTEXT.length + 1))).toEqual([1, 2, 3]);
  expect(log(id).slice(4)).toEqual(["4|user|thanks", "5|assistant|np"]);
});

test("identical answers in a row each get their own entry, and a retry gets none", async () => {
  const id = "final-repeat";
  let history = [...CONTEXT, user("one")];
  history = [...history, ...(await turn(id, history, say("ok"))), user("two")];
  // Codex retries the same request (say its stream broke): the answer is the same message.
  await turn(id, history, say("ok"));
  history = [...history, ...(await turn(id, history, say("ok"))), user("three")];
  await turn(id, history, say("done"));
  expect(log(id)).toEqual(["0|user|one", "1|assistant|ok", "2|user|two", "3|assistant|ok", "4|user|three", "5|assistant|done"]);
  expect(store(id).idsOf(keyAt(history, CONTEXT.length + 1))).toEqual([1]);
  expect(store(id).idsOf(keyAt(history, CONTEXT.length + 3))).toEqual([3]);
});

test("a restart between the answer and its echo still maps the echo", async () => {
  const id = "final-restart";
  let history = [...CONTEXT, user("before restart")];
  const answer = await turn(id, history, say("answered"));
  // A new process: the open chats are forgotten and the store reloads from disk.
  setPerpetualDeps({ config: () => config, title: () => "Today (beta)", runner, root });
  history = [...history, ...answer, user("after restart")];
  await turn(id, history, say("fine"));
  expect(log(id)).toEqual(["0|user|before restart", "1|assistant|answered", "2|user|after restart", "3|assistant|fine"]);
  expect(existsSync(join(root, id, "aliases"))).toBe(true);
});

test("proxy-answered lookups are not logged twice, and the final answer still maps", async () => {
  const id = "final-local";
  let history = [...CONTEXT, user("hello")];
  history = [...history, ...(await turn(id, history, say("hi"))), user("look it up")];
  const zoom: ProxyOutput = { text: "checking", toolCalls: [{ name: "zoom", arguments: '{"id":0,"n":1}', callId: "z1" }], usage };
  const answer = await turn(id, history, zoom, say("found it"));
  history = [...history, ...answer, user("bye")];
  await turn(id, history, say("later"));
  expect(log(id).map((line) => line.split("|").slice(0, 2).join("|"))).toEqual([
    "0|user",
    "1|assistant",
    "2|user",
    "3|assistant", // "checking", logged with the lookup
    "4|tool",
    "5|echo",
    "6|assistant", // "found it"
    "7|user",
    "8|assistant",
  ]);
  expect(store(id).messages[6].text).toBe("found it");
});

test("an echo whose text differs is logged as before, after the provisional answer", async () => {
  const id = "final-differs";
  let history = [...CONTEXT, user("q")];
  const answer = await turn(id, history, say("original"));
  const edited = { ...answer[0], content: [{ type: "output_text", annotations: [], text: "edited" }] } as ResponseInputItem;
  history = [...history, edited, user("next")];
  await turn(id, history, say("r"));
  expect(log(id)).toEqual(["0|user|q", "1|assistant|original", "2|assistant|edited", "3|user|next", "4|assistant|r"]);
});

test("tool-call results and commentary are untouched", async () => {
  const id = "final-tools";
  const history = [...CONTEXT, user("call it")];
  await turn(id, history, { text: "calling", toolCalls: [{ name: "lookup", arguments: "{}", callId: "c1" }], usage });
  expect(log(id)).toEqual(["0|user|call it"]);
});

test("an answer finished after Codex hung up is not logged, as before", async () => {
  const id = "final-aborted";
  let history = [...CONTEXT, user("long task")];
  const gone = new AbortController();
  gone.abort();
  await turn(id, history, say("too late"), gone.signal);
  expect(log(id)).toEqual(["0|user|long task"]);
  const aborted = "<turn_aborted>\nThe user interrupted the previous turn.</turn_aborted>";
  history = [...history, user(aborted), user("again")];
  await turn(id, history, say("here"));
  expect(log(id)).toEqual(["0|user|long task", `1|user|${aborted}`, "2|user|again", "3|assistant|here"]);
});
