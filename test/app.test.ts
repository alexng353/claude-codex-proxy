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
  await writeFile(mock, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]},"usage":{"input_tokens":5,"output_tokens":2}}'\n`);
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
    const models = await (await handleRequest(new Request("http://local/v1/models"))).json() as { data: unknown[]; models: unknown[] };
    expect(models.data).toHaveLength(3);
    expect(models.models).toHaveLength(3);
  });

  test("runs a non-streaming response", async () => {
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", input: "hello" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0].content[0].text).toBe("mock-ok");
  });
});
