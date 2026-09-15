import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../src/app";

let directory = "";
let oldClaudeBin: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-proxy-test-"));
  const mock = join(directory, "claude");
  await writeFile(mock, `#!/bin/sh
turn=0
while IFS= read -r input; do
  if [ "$turn" -eq 1 ]; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"continued-in-worker","tool_calls":[]}}'
  elif printf '%s' "$input" | grep -q 'persistent-first'; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"lookup","arguments":"{\\"query\\":\\"value\\"}"}]}}'
    turn=1
  else
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]},"usage":{"input_tokens":440960,"output_tokens":2,"cache_read_input_tokens":180000}}'
  fi
done
`);
  await chmod(mock, 0o755);
  oldClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
});

afterAll(async () => {
  if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = oldClaudeBin;
  await rm(directory, { recursive: true, force: true });
});

describe("HTTP app", () => {
  test("serves health and models", async () => {
    expect(await (await handleRequest(new Request("http://local/health"))).json()).toEqual({ status: "ok" });
    const models = await (await handleRequest(new Request("http://local/v1/models"))).json() as { data: unknown[]; models: Array<Record<string, unknown>> };
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
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", input: "hello" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<{ content: Array<{ text: string }> }>; usage: { input_tokens: number } };
    expect(body.output[0].content[0].text).toBe("mock-ok");
    expect(body.usage.input_tokens).toBeLessThan(1_000);
  });

  test("continues a tool loop in the same Claude worker", async () => {
    const tools = [{
      type: "function", name: "lookup", description: "Look up a value",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }];
    const first = await (await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", input: "persistent-first", tools }),
    }))).json() as { output: Array<{ type: string; name?: string; call_id?: string; arguments?: string }> };
    const call = first.output.find((item) => item.type === "function_call")!;

    const second = await (await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sonnet", tools,
        input: [
          { role: "user", content: "persistent-first" },
          { type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments },
          { type: "function_call_output", call_id: call.call_id, output: "result" },
        ],
      }),
    }))).json() as { output: Array<{ content?: Array<{ text: string }> }> };
    expect(second.output[0].content?.[0].text).toBe("continued-in-worker");
  });
});
