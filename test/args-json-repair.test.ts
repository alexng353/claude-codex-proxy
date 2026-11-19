import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { responseObject, streamResponse } from "../src/responses";
import type { ResponsesRequest } from "../src/types";

// proxy-args-json-repair: Claude sometimes writes tool-call arguments that are not
// valid JSON (a lone backslash before $, | or (, or a raw newline inside a string).
// Codex answers "failed to parse function arguments" and the model pays a full
// request to retry. The proxy repairs those two deterministic shapes before emitting.

/**
 * The exact bytes under test hold backslashes and control characters, and every
 * layer of escaping (TS, JSON, the tool call that wrote this file) blurs which ones
 * are real. So the sources here hold none: ⧵ is one backslash, ⏎ a raw LF,
 * ⇥ a raw tab, ␍ a raw CR, ␁ a raw U+0001. Cooked strings, not String.raw:
 * Bun's String.raw returns non-ASCII as a \uXXXX escape sequence.
 */
const j = (strings: TemplateStringsArray, ...values: unknown[]) =>
  strings.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ""), "")
    .replaceAll("⧵", String.fromCharCode(92))
    .replaceAll("⏎", String.fromCharCode(10))
    .replaceAll("⇥", String.fromCharCode(9))
    .replaceAll("␍", String.fromCharCode(13))
    .replaceAll("␁", String.fromCharCode(1));

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const request = {
  model: "sonnet", input: "hi", stream: true, prompt_cache_key: "thread-abc",
  tools: [
    { type: "function", name: "exec_command" },
    { type: "custom", name: "apply_patch" },
    { type: "tool_search" },
    { type: "computer" },
  ],
} as unknown as ResponsesRequest;

function emit(name: string, args: string) {
  return responseObject(request, { text: "", toolCalls: [{ name, arguments: args, callId: "call_x" }], usage })
    .output[0] as Record<string, unknown>;
}
const execArgs = (args: string) => emit("exec_command", args).arguments as string;

let logs: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
});
afterEach(() => spy.mockRestore());
const repairLogs = () => logs.filter((line) => line.includes("argsRepaired")).map((line) => JSON.parse(line));

describe("tool-call argument JSON repair", () => {
  test("the 2026-11-11 13:03:56 wakeup-add call reaches Codex as valid JSON with a literal backslash-dollar", () => {
    const original = readFileSync(join(import.meta.dir, "fixtures/args-invalid-escape-1303.txt"), "utf8");
    expect(() => JSON.parse(original)).toThrow();
    // The fixture holds exactly one backslash, the lone one before "$ prices".
    expect(original.split(String.fromCharCode(92)).length - 1).toBe(1);
    const args = execArgs(original);
    expect(args).toBe(original.replace(j`⧵$ prices`, j`⧵⧵$ prices`));
    const parsed = JSON.parse(args) as { cmd: string };
    expect(parsed.cmd).toContain(j`⧵$ prices bold fix`);
    expect(parsed.cmd).toStartWith("~/.local/share/today-ops/bin/wakeup-add 'Mac Today OTA done");
    expect(parsed.cmd).toEndWith("; echo EXIT=$?");
  });

  test("grep 'a backslash-pipe b' keeps its backslash", () => {
    const args = execArgs(j`{"cmd":"grep -n 'a⧵|b' src/x.ts"}`);
    expect(JSON.parse(args)).toEqual({ cmd: j`grep -n 'a⧵|b' src/x.ts` });
  });

  test("backslash-paren keeps its backslash", () => {
    const args = execArgs(j`{"cmd":"grep -n 'f⧵(x⧵)' a.ts","workdir":"/w"}`);
    expect(JSON.parse(args)).toEqual({ cmd: j`grep -n 'f⧵(x⧵)' a.ts`, workdir: "/w" });
  });

  test("a string with only lone backslashes is repaired byte-exact", () => {
    expect(execArgs(j`{"cmd":"grep 'a⧵|b⧵(c⧵)' ⧵$x ⧵q"}`)).toBe(j`{"cmd":"grep 'a⧵⧵|b⧵⧵(c⧵⧵)' ⧵⧵$x ⧵⧵q"}`);
  });

  test("a string with only raw control characters is repaired byte-exact", () => {
    expect(execArgs(j`{"cmd":"a⏎b⇥c␁d"}`)).toBe(j`{"cmd":"a⧵nb⧵tc⧵u0001d"}`);
  });

  test("the rule is per string: a properly encoded key does not block a repair in another", () => {
    const args = execArgs(j`{"msg":"line⧵nnext ⧵"q⧵"","cmd":"echo ⧵$HOME"}`);
    expect(args).toBe(j`{"msg":"line⧵nnext ⧵"q⧵"","cmd":"echo ⧵⧵$HOME"}`);
    expect(JSON.parse(args)).toEqual({ msg: j`line⏎next "q"`, cmd: j`echo ⧵$HOME` });
  });

  // PAJR-H1: a lone backslash or raw control character shows the model wrote that
  // string as raw text, so its valid-looking escapes were raw too. Decoding them would
  // run a different command than the one written; Codex rejecting it is the safe outcome.
  for (const [name, original] of [
    ["rm with backslash-n and a lone backslash (would split at a newline)", j`{"cmd":"rm -rf /tmp/reports⧵note⧵ files"}`],
    ["backslash-u003b with a lone backslash-q (would inject a ;)", j`{"cmd":"echo ⧵u003b echo SECOND ⧵q"}`],
    ["grep with backslash-b and a lone backslash-pipe (would grep for a backspace)", j`{"cmd":"grep -E '⧵bfoo⧵|bar⧵b' f"}`],
    ["heredoc with raw newlines and a backslash-n in a Python string", j`{"cmd":"python3 - <<'EOF'⏎print('a⧵nb ⧵$x')⏎EOF"}`],
    ["a lone backslash-dollar beside an escaped quote", j`{"cmd":"echo ⧵"hi⧵" ⧵$x"}`],
    ["a lone backslash-dollar beside an escaped backslash", j`{"cmd":"echo ⧵⧵ ⧵$x"}`],
    ["an odd backslash run (a valid pair, then a lone backslash)", j`{"cmd":"echo ⧵⧵⧵$HOME"}`],
  ] as const) {
    test(`mixed valid and invalid escapes in one string pass through unchanged: ${name}`, () => {
      expect(execArgs(original)).toBe(original);
      expect(repairLogs()).toEqual([]);
    });
  }

  test("a backslash-u without four hex digits is a bad escape", () => {
    const args = execArgs(j`{"cmd":"printf ⧵u12"}`);
    expect(JSON.parse(args)).toEqual({ cmd: j`printf ⧵u12` });
  });

  test("a raw newline in a string (python heredoc, 2026-11-19 08:00 repro) becomes an escaped newline", () => {
    const original = j`{"cmd":"cd ~/.cache/agent-tmp/x && python3 - <<'EOF'⏎import json⏎print(json.dumps({'a': 1}))⏎EOF","yield_time_ms":10000}`;
    expect(() => JSON.parse(original)).toThrow(); // "control character ... at line 1 column 66" in Codex
    const args = execArgs(original);
    expect(args).toBe(j`{"cmd":"cd ~/.cache/agent-tmp/x && python3 - <<'EOF'⧵nimport json⧵nprint(json.dumps({'a': 1}))⧵nEOF","yield_time_ms":10000}`);
    expect(JSON.parse(args)).toEqual({
      cmd: j`cd ~/.cache/agent-tmp/x && python3 - <<'EOF'⏎import json⏎print(json.dumps({'a': 1}))⏎EOF`,
      yield_time_ms: 10000,
    });
  });

  test("raw tab and other control characters become escaped tab and backslash-u00XX", () => {
    const args = execArgs(j`{"cmd":"a⇥b␁c␍d"}`);
    expect(args).toBe(j`{"cmd":"a⧵tb⧵u0001c⧵u000dd"}`);
    expect(JSON.parse(args)).toEqual({ cmd: j`a⇥b␁c␍d` });
  });

  test("whitespace between tokens is left alone; only string contents are repaired", () => {
    expect(execArgs(j`{⏎  "cmd": "x⏎y",⏎  "a": 1⏎}`)).toBe(j`{⏎  "cmd": "x⧵ny",⏎  "a": 1⏎}`);
  });

  test("valid JSON with real escapes is byte-identical and not logged", () => {
    const original = j`{"cmd":"printf 'a⧵nb' | grep -c ⧵"a⧵" ⧵⧵","n":"⧵u00e9⧵/"}`;
    expect(execArgs(original)).toBe(original);
    expect(repairLogs()).toEqual([]);
  });

  test("an unrepairable string passes through unchanged and is not logged", () => {
    for (const original of [
      j`{"cmd":"echo "quoted" ⧵$x"}`, // an unescaped quote: no deterministic repair
      j`{"cmd":"truncated ⧵$`,
      j`{"cmd":"ends in a lone backslash⧵`,
      j`"a string, not an object ⧵$"`, // repairs to valid JSON, but not an object
      j`["an array ⧵$"]`,
    ]) {
      expect(execArgs(original)).toBe(original);
    }
    expect(repairLogs()).toEqual([]);
  });

  test("custom (freeform) tool input is untouched", () => {
    const patch = j`*** Begin Patch⏎*** Add File: a.sh⏎+grep 'a⧵|b' ⧵$x⏎*** End Patch`;
    expect(emit("apply_patch", patch)).toMatchObject({ type: "custom_tool_call", input: patch });
    // Freeform text shaped like repairable JSON is still the tool's own input.
    const jsonish = j`{"note":"a ⧵$ b⏎c"}`;
    expect(emit("apply_patch", jsonish)).toMatchObject({ type: "custom_tool_call", input: jsonish });
    expect(repairLogs()).toEqual([]);
  });

  test("tool_search and computer arguments are repaired too", () => {
    const search = emit("__codex_tool_search", j`{"query":"gmail ⧵$ search","limit":8}`);
    expect(search).toMatchObject({ type: "tool_search_call", arguments: { query: j`gmail ⧵$ search`, limit: 8 } });
    const computer = emit("__codex_computer_use", j`{"type":"type","text":"line one⏎line two"}`);
    expect(computer).toMatchObject({ type: "computer_call", action: { type: "type", text: j`line one⏎line two` } });
    expect(repairLogs().map((line) => [line.tool, line.kind])).toEqual([
      ["__codex_tool_search", "escape"],
      ["__codex_computer_use", "control"],
    ]);
  });

  test("tool_search and computer still reject unrepairable JSON", () => {
    expect(() => emit("__codex_tool_search", `{"query":"x"`)).toThrow("Tool search arguments must be valid JSON");
    expect(() => emit("__codex_computer_use", `{"type":"click"`)).toThrow("Computer tool arguments must be valid JSON");
  });

  test("logs one JSON line per repair with kind, tool and thread, never the argument text", () => {
    execArgs(j`{"cmd":"grep 'secret⧵|b'"}`);
    execArgs(j`{"cmd":"secret⏎b"}`);
    execArgs(j`{"cmd":"secret⧵$⏎b"}`);
    expect(repairLogs()).toEqual([
      { argsRepaired: 1, kind: "escape", tool: "exec_command", threadId: "thread-abc" },
      { argsRepaired: 1, kind: "control", tool: "exec_command", threadId: "thread-abc" },
      { argsRepaired: 2, kind: "escape+control", tool: "exec_command", threadId: "thread-abc" },
    ]);
    expect(logs.join(" ")).not.toContain("secret");
  });

  test("the SSE stream carries the repaired arguments", async () => {
    const response = responseObject(request, { text: "", toolCalls: [{ name: "exec_command", arguments: j`{"cmd":"a⧵|b"}` }], usage });
    const events = (await streamResponse(response).text()).split(String.fromCharCode(10))
      .filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    const done = events.find((event) => event.type === "response.function_call_arguments.done");
    expect(JSON.parse(done.arguments)).toEqual({ cmd: j`a⧵|b` });
  });
});
