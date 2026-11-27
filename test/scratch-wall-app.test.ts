import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { __test } from "../src/scratch-wall";

// The /v1/responses wiring (app.ts): a declared reader's tool calls are walled and
// its final answer schedules a report-only sweep after the response is built; a chat
// without a declaration gets Claude's calls as is.
let directory = "";
let base = "";
let fakeTmp = "";
const saved: Record<string, string | undefined> = {};
const env = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "scratch-wall-app-"));
  base = join(directory, "agent-tmp");
  fakeTmp = join(directory, "fake-tmp");
  mkdirSync(base, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  // The mock answers with a /tmp write while its stdin line mentions "tool", else a final answer.
  const mock = join(directory, "claude");
  await writeFile(
    mock,
    `#!/bin/sh
while IFS= read -r input; do
  case "$input" in
    *want-tool*) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"exec_command","arguments":"{\\"cmd\\":\\"echo x > /tmp/probe.out\\"}"}]}}' ;;
    *) printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"NONCE n\\nSTATUS: COMPLETE\\nwrote /tmp/probe.out","tool_calls":[]}}' ;;
  esac
done
`,
  );
  await chmod(mock, 0o755);
  env("CLAUDE_BIN", mock);
  env("PROXY_STATE_DIR", join(directory, "state"));
  env("CLAUDE_CONFIG_DIR", join(directory, "claude-config"));
  env("SCRATCH_WALL_BASE", base);
  env("SCRATCH_WALL_TMP", fakeTmp);
});

afterAll(async () => {
  closeIdleWorkers();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const send = async (thread: string, text: string) => {
  const reply = await handleRequest(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        prompt_cache_key: thread,
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
      }),
    }),
  );
  expect(reply.status).toBe(200);
  return (await reply.json()) as { output: Array<{ type: string; arguments?: string }> };
};
const cmdIn = (body: { output: Array<{ type: string; arguments?: string }> }) =>
  JSON.parse(body.output.find((item) => item.type === "function_call")!.arguments!).cmd as string;

test("a declared reader's /tmp write comes back as a refusal naming its root", async () => {
  const root = join(base, "comb-app/p1");
  const cmd = cmdIn(await send("01a2aaaa-0000-7000-8000-00000000000a", `want-tool\nScratch root: ${root}`));
  expect(cmd).toContain("scratch-tmp-wall: refused");
  expect(cmd).toContain(`Scratch root: ${root}`);
  expect(cmd).not.toContain("echo x >");
});

test("a chat without a declared root gets Claude's command unchanged", async () => {
  expect(cmdIn(await send("01a2aaaa-0000-7000-8000-00000000000b", "want-tool, no declaration"))).toBe("echo x > /tmp/probe.out");
});

test("a declared reader's final answer is answered first, then swept, and nothing moves (R1-M1, R1-H2)", async () => {
  const root = join(base, "comb-app/p2");
  mkdirSync(root, { recursive: true });
  const thread = "01a2aaaa-0000-7000-8000-00000000000c";
  await send(thread, `want-tool\nScratch root: ${root}`); // first sight starts the run
  await writeFile(join(fakeTmp, "probe.out"), "x");
  const before = __test.sweeps.length;
  const reply = await handleRequest(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        prompt_cache_key: thread,
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: `finish\nScratch root: ${root}` }] },
          { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "echo x > /tmp/probe.out" }) },
          { type: "function_call_output", call_id: "c1", output: "" },
        ],
      }),
    }),
  );
  // The response exists and no sweep has started: it waits for a later tick.
  expect(reply.status).toBe(200);
  expect(__test.sweeps.length).toBe(before);
  for (let i = 0; i < 100 && __test.sweeps.length === before; i++) await Bun.sleep(10);
  expect(__test.sweeps.length).toBe(before + 1);
  const result = await __test.sweeps.at(-1);
  expect(result?.left).toEqual([join(fakeTmp, "probe.out")]);
  expect(await readFile(join(fakeTmp, "probe.out"), "utf8")).toBe("x");
  expect(existsSync(join(root, "tmp-swept"))).toBe(false);
});
