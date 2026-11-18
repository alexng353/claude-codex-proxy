import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";
import { codexToolFor } from "../src/native-tools";
import type { ResponsesRequest } from "../src/types";

// Synthetic fixtures. Only the shape of the failure is replayed: a native tool_use of a
// Codex tool name, Claude Code's "No such tool available" result, then StructuredOutput.
// The sentinels prove that arguments, model text and tool_result text never leak.
const ARGS_SENTINEL = "ARGS-SENTINEL-7f3a";
const MODEL_SENTINEL = "MODEL-SENTINEL-41c9";
const NO_SUCH_TOOL = "No such tool available";

type Step = { native?: string[]; text: string; tool_calls?: Array<{ name: string; arguments: string }> };

const TOOLS: ResponsesRequest["tools"] = [
  { type: "tool_search" },
  { type: "function", name: "exec_command", parameters: { type: "object" } },
  {
    type: "namespace",
    name: "today",
    tools: [
      { type: "function", name: "create_thread", parameters: { type: "object" } },
      { type: "function", name: "machine_exec", parameters: { type: "object" } },
    ],
  },
];

let root = "";
let saved: Record<string, string | undefined> = {};
let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-nudge-"));
  saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"].map((key) => [key, process.env[key]]));
  await mkdir(join(root, "base"));
  await mkdir(join(root, "state"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  process.env.PROXY_STATE_DIR = join(root, "state");
  closeIdleWorkers();
  resetAccountState();
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  closeIdleWorkers();
  resetAccountState();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

/** A fake Claude Code that plays `steps`, one per stdin message (the last repeats). */
async function fakeClaude(steps: Step[]): Promise<{ messages: () => Promise<string[]>; sessionId: () => Promise<string> }> {
  const fake = join(root, `fake-${crypto.randomUUID()}.mjs`);
  const inbox = join(root, `inbox-${crypto.randomUUID()}`);
  const session = join(root, `session-${crypto.randomUUID()}`);
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const steps = ${JSON.stringify(steps)};
writeFileSync(${JSON.stringify(session)}, process.argv[process.argv.indexOf("--session-id") + 1]);
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const content = JSON.parse(line).message.content;
  appendFileSync(${JSON.stringify(inbox)}, JSON.stringify(content.map((block) => block.text ?? "").join("")) + "\\n");
  const step = steps[Math.min(count++, steps.length - 1)];
  const say = (role, blocks) => console.log(JSON.stringify({ type: role, message: { role, content: blocks } }));
  for (const [index, name] of (step.native ?? []).entries()) {
    const id = "toolu_" + count + "_" + index;
    say("assistant", [{ type: "tool_use", id, name, input: { note: ${JSON.stringify(ARGS_SENTINEL)} } }]);
    say("user", [{ type: "tool_result", tool_use_id: id, is_error: true,
      content: "<tool_use_error>Error: ${NO_SUCH_TOOL}: " + name + "</tool_use_error>" }]);
  }
  const output = { text: step.text, tool_calls: step.tool_calls ?? [] };
  say("assistant", [{ type: "tool_use", id: "toolu_so_" + count, name: "StructuredOutput", input: output }]);
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: output }));
}
`);
  await chmod(fake, 0o755);
  process.env.CLAUDE_BIN = fake;
  return {
    messages: async () =>
      (await readFile(inbox, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    sessionId: async () => readFile(session, "utf8"),
  };
}

const ask = (input: ResponsesRequest["input"] = "start the worker") =>
  runClaude({ model: "sonnet", input, tools: TOOLS, prompt_cache_key: crypto.randomUUID() });

const nudgeLines = () =>
  logs.filter((line) => line.includes("nativeToolNudge")).map((line) => JSON.parse(line).nativeToolNudge);

test("codexToolFor maps native spellings to the exact Codex name in the list", () => {
  const allowed = new Set(["__codex_tool_search", "exec_command", "today.create_thread", "today.machine_exec"]);
  expect(codexToolFor("mcp__today.create_thread", allowed)).toBe("today.create_thread");
  expect(codexToolFor("mcp__today__machine_exec", allowed)).toBe("today.machine_exec");
  expect(codexToolFor("mcp__today.machine_exec", allowed)).toBe("today.machine_exec");
  expect(codexToolFor("create_thread", allowed)).toBe("today.create_thread");
  expect(codexToolFor("__codex_tool_search", allowed)).toBe("__codex_tool_search");
  expect(codexToolFor("exec_command", allowed)).toBe("exec_command");
  expect(codexToolFor("WebFetch", allowed)).toBeUndefined();
  expect(codexToolFor("mcp__other__create_thread", allowed)).toBeUndefined();
  expect(codexToolFor("StructuredOutput", allowed)).toBeUndefined();
});

test("(a) adb13227 shape: one corrective turn names the exact Codex tool, then tool_calls pass through", async () => {
  const fake = await fakeClaude([
    { native: ["mcp__today.create_thread"], text: `${MODEL_SENTINEL} my tools look broken` },
    { text: "Starting it.", tool_calls: [{ name: "today.create_thread", arguments: '{"title":"worker"}' }] },
  ]);
  const output = await ask();
  expect(output.toolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })))
    .toEqual([{ name: "today.create_thread", arguments: '{"title":"worker"}' }]);
  expect(output.text).toBe("Starting it.");
  const messages = await fake.messages();
  expect(messages).toHaveLength(2);
  expect(messages[1]).toContain("`today.create_thread` is a Codex tool");
  expect(messages[1]).toContain('{"name":"today.create_thread","arguments":"<json string>"}');
  expect(messages[1]).not.toContain(ARGS_SENTINEL);
  expect(messages[1]).not.toContain("mcp__");
});

test("(b) tool search and a bare namespaced name are nudged by their Codex names", async () => {
  const fake = await fakeClaude([
    { native: ["__codex_tool_search", "create_thread"], text: "" },
    { text: "", tool_calls: [{ name: "__codex_tool_search", arguments: '{"query":"x"}' }] },
  ]);
  const output = await ask();
  expect(output.toolCalls.map((call) => call.name)).toEqual(["__codex_tool_search"]);
  const messages = await fake.messages();
  expect(messages).toHaveLength(2);
  expect(messages[1]).toContain("`__codex_tool_search` is a Codex tool");
  expect(messages[1]).toContain("`today.create_thread` is a Codex tool");
});

test("(c) a native name not in the tool list sends no nudge and returns what main returns", async () => {
  const steps = (native?: string[]): Step[] => [
    { native, text: `${MODEL_SENTINEL} answered anyway`, tool_calls: [] },
    { text: "a nudge was sent", tool_calls: [] },
  ];
  const control = await fakeClaude(steps());
  const expected = await ask();
  expect(await control.messages()).toHaveLength(1);
  logs = [];
  const fake = await fakeClaude(steps(["WebFetch", "mcp__other__create_thread"]));
  const output = await ask();
  expect(await fake.messages()).toHaveLength(1);
  expect(output).toEqual(expected);
  expect(output.text).toBe(`${MODEL_SENTINEL} answered anyway`);
  expect(output.toolCalls).toEqual([]);
  expect(nudgeLines()).toEqual([]);
});

test("(d) the same native call after its nudge ends the turn with a visible error", async () => {
  const fake = await fakeClaude([
    { native: ["create_thread"], text: `${MODEL_SENTINEL} first` },
    { native: ["mcp__today.create_thread"], text: `${MODEL_SENTINEL} second` },
    { text: "never reached", tool_calls: [{ name: "today.create_thread", arguments: "{}" }] },
  ]);
  const error = await ask().then(
    () => undefined,
    (cause: Error) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  const sessionId = await fake.sessionId();
  expect(error!.message).toContain("today.create_thread");
  expect(error!.message).toContain(sessionId);
  for (const leak of [ARGS_SENTINEL, MODEL_SENTINEL, NO_SUCH_TOOL, "mcp__"]) expect(error!.message).not.toContain(leak);
  expect(await fake.messages()).toHaveLength(2);
});

test("(e) a model that already returned the tool in tool_calls is not nudged", async () => {
  const fake = await fakeClaude([
    { native: ["mcp__today.create_thread"], text: "", tool_calls: [{ name: "today.create_thread", arguments: "{}" }] },
    { text: "a nudge was sent" },
  ]);
  const output = await ask();
  expect(output.toolCalls.map((call) => call.name)).toEqual(["today.create_thread"]);
  expect(await fake.messages()).toHaveLength(1);
});

test("(f) the nudge log line carries the tool name and session id only", async () => {
  const fake = await fakeClaude([
    { native: ["mcp__today.machine_exec"], text: `${MODEL_SENTINEL} tools broken` },
    { text: "", tool_calls: [{ name: "today.machine_exec", arguments: "{}" }] },
  ]);
  await ask();
  const sessionId = await fake.sessionId();
  expect(nudgeLines()).toEqual([{ sessionId, name: "today.machine_exec" }]);
  const raw = logs.filter((line) => line.includes("nativeToolNudge")).join("\n");
  for (const leak of [ARGS_SENTINEL, MODEL_SENTINEL, NO_SUCH_TOOL, "mcp__"]) expect(raw).not.toContain(leak);
});

test("(g) at most two nudges per Codex turn; a third native call fails even for a new name", async () => {
  const fake = await fakeClaude([
    { native: ["create_thread"], text: `${MODEL_SENTINEL} one` },
    { native: ["machine_exec"], text: `${MODEL_SENTINEL} two` },
    { native: ["exec_command"], text: `${MODEL_SENTINEL} three` },
    { text: "never reached", tool_calls: [{ name: "exec_command", arguments: "{}" }] },
  ]);
  const error = await ask().then(
    () => undefined,
    (cause: Error) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain("exec_command");
  expect(error!.message).toContain(await fake.sessionId());
  for (const leak of [ARGS_SENTINEL, MODEL_SENTINEL, NO_SUCH_TOOL]) expect(error!.message).not.toContain(leak);
  const messages = await fake.messages();
  expect(messages).toHaveLength(3);
  expect(messages[1]).toContain("`today.create_thread`");
  expect(messages[2]).toContain("`today.machine_exec`");
  expect(messages[2]).not.toContain("`today.create_thread`");
  expect(nudgeLines().map((line) => line.name)).toEqual(["today.create_thread", "today.machine_exec"]);
});

test("(h) a native call during compaction sends no nudge", async () => {
  const fake = await fakeClaude([
    { native: ["mcp__today.create_thread"], text: "the summary" },
    { text: "a nudge was sent" },
  ]);
  const output = await ask([{ role: "user", content: "summarize" }, { type: "compaction_trigger" }]);
  expect(output.compaction).toBe("the summary");
  expect(await fake.messages()).toHaveLength(1);
  expect(nudgeLines()).toEqual([]);
});

test("third-person reply text is logged with session id, verb and count, never the text", async () => {
  const fake = await fakeClaude([{ text: `Told Alex the plan. ${MODEL_SENTINEL}` }]);
  const output = await ask();
  expect(output.text).toBe(`Told Alex the plan. ${MODEL_SENTINEL}`);
  const lines = logs.filter((line) => line.includes("thirdPersonText"));
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]!).thirdPersonText;
  expect(Object.keys(entry).sort()).toEqual(["count", "sessionId", "verb"]);
  expect(entry.sessionId).toBe(await fake.sessionId());
  expect(entry.verb).toBe("Told");
  expect(entry.count).toBeGreaterThanOrEqual(1);
  expect(lines[0]).not.toContain(MODEL_SENTINEL);
  expect(lines[0]).not.toContain("the plan");
});
