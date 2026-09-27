import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";

let directory = "";
let oldClaudeBin: string | undefined;
let oldStateDir: string | undefined;
let oldConfigDir: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-proxy-test-"));
  const mock = join(directory, "claude");
  await writeFile(
    mock,
    `#!/bin/sh
resumed=0
case "$*" in *--resume*) resumed=1 ;; esac
turn=0
while IFS= read -r input; do
  if [ "$resumed" -eq 1 ]; then
    if printf '%s' "$input" | grep -q 'persistent-first'; then
      printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"resumed-with-full-history","tool_calls":[]}}'
    else
      printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"resumed-worker","tool_calls":[]}}'
    fi
  elif [ "$turn" -eq 1 ]; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"continued-in-worker","tool_calls":[]}}'
  elif printf '%s' "$input" | grep -q 'persistent-first' && ! printf '%s' "$input" | grep -q 'tool_result'; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"lookup","arguments":"{\\"query\\":\\"value\\"}"}]}}'
    turn=1
  else
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]},"usage":{"input_tokens":440960,"output_tokens":2,"cache_read_input_tokens":180000}}'
  fi
done
`,
  );
  await chmod(mock, 0o755);
  oldStateDir = process.env.PROXY_STATE_DIR;
  process.env.PROXY_STATE_DIR = join(directory, "state");
  oldConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude-config");
  oldClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
});

afterAll(async () => {
  if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = oldClaudeBin;
  if (oldStateDir === undefined) delete process.env.PROXY_STATE_DIR;
  else process.env.PROXY_STATE_DIR = oldStateDir;
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir;
  await rm(directory, { recursive: true, force: true });
});

test("resumes a persisted session with only new items after its process is gone", async () => {
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
  const base = { model: "claude-opus-5-5", instructions: "resume-test", tools };
  async function send(body: unknown) {
    return (await (
      await handleRequest(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).json()) as any;
  }
  const first = await send({ ...base, input: "persistent-first" });
  const call = first.output.find((item: any) => item.type === "function_call");
  // Simulate idle expiry or a proxy restart.
  closeIdleWorkers();
  const second = await send({
    ...base,
    input: [
      { role: "user", content: "persistent-first" },
      { type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: "result" },
    ],
  });
  expect(second.output[0].content[0].text).toBe("resumed-worker");
});

describe("HTTP app", () => {
  test("serves health and models", async () => {
    expect(
      await (await handleRequest(new Request("http://local/health"))).json(),
    ).toEqual({ status: "ok" });
    const models = (await (
      await handleRequest(new Request("http://local/v1/models"))
    ).json()) as { data: unknown[]; models: Array<Record<string, unknown>> };
    expect(models.data).toHaveLength(3);
    expect(models.models).toHaveLength(3);
    expect(models.models[0]).toMatchObject({
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: true,
      node_repl_disabled: false,
      supports_search_tool: true,
    });
  });

  test("runs a non-streaming response", async () => {
    const response = await handleRequest(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", input: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: Array<{ content: Array<{ text: string }> }>;
      usage: { input_tokens: number };
    };
    expect(body.output[0].content[0].text).toBe("mock-ok");
    expect(body.usage.input_tokens).toBeLessThan(1_000);
  });

  test("continues a tool loop in the same Claude worker", async () => {
    const tools = [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const first = (await (
      await handleRequest(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "sonnet",
            input: "persistent-first",
            tools,
          }),
        }),
      )
    ).json()) as {
      output: Array<{
        type: string;
        name?: string;
        call_id?: string;
        arguments?: string;
      }>;
    };
    const call = first.output.find((item) => item.type === "function_call")!;

    const second = (await (
      await handleRequest(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "sonnet",
            tools,
            input: [
              { role: "user", content: "persistent-first" },
              {
                type: "function_call",
                name: call.name,
                call_id: call.call_id,
                arguments: call.arguments,
              },
              {
                type: "function_call_output",
                call_id: call.call_id,
                output: "result",
              },
            ],
          }),
        }),
      )
    ).json()) as { output: Array<{ content?: Array<{ text: string }> }> };
    expect(second.output[0].content?.[0].text).toBe("continued-in-worker");
  });
});

test("logs exact usage with request and worker identities without prompt content", async () => {
  const rows = (await readFile(join(directory, "state/usage.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const row = rows.find((row) => row.usage?.cache_read_input_tokens === 180000);
  expect(row.usage.input_tokens).toBe(440960);
  expect(row.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(row.timestamp).toMatch(/^\d{4}-/);
  expect(row.launchMode).toBe("minimal");
  expect(row).not.toHaveProperty("prompt");
  const continuation = rows.find((row) => row.workerTurn === 2);
  expect(
    rows.some(
      (row) => row.workerId === continuation.workerId && row.workerTurn === 1,
    ),
  ).toBe(true);
});

for (const change of ["order", "schema", "instructions", "effort"]) {
  test(`worker reuse respects ${change}`, async () => {
    const tools = [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      { type: "function", name: "other" },
    ];
    const base = {
      model: "claude-opus-5-5",
      instructions: "original",
      reasoning: { effort: "low" },
      tools,
    };
    async function send(body: unknown) {
      return (await (
        await handleRequest(
          new Request("http://local/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      ).json()) as any;
    }
    const first = await send({ ...base, input: "persistent-first" });
    const call = first.output.find(
      (item: any) => item.type === "function_call",
    );
    const second = await send({
      ...base,
      tools:
        change === "schema"
          ? [{ ...tools[0], description: "changed" }, tools[1]]
          : [...tools].reverse(),
      instructions: change === "instructions" ? "changed" : base.instructions,
      reasoning: { effort: change === "effort" ? "high" : "low" },
      input: [
        // Codex resends the whole history; reuse requires the exact prefix.
        { role: "user", content: "persistent-first" },
        {
          type: "function_call",
          name: call.name,
          call_id: call.call_id,
          arguments: call.arguments,
        },
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "result",
        },
      ],
    });
    expect(second.output[0].content[0].text).toBe(
      change === "order" ? "continued-in-worker" : "mock-ok",
    );
  });
}
