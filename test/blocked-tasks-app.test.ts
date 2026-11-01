import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";

// The /v1/responses hook (app.ts noteBlockedTasks): a Claude child's encrypted
// task is counted after the request, and a failing counter never touches it.
let directory = "";
const saved: Record<string, string | undefined> = {};
const env = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "blocked-tasks-app-"));
  const mock = join(directory, "claude");
  await writeFile(
    mock,
    `#!/bin/sh
while IFS= read -r input; do
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]}}'
done
`,
  );
  await chmod(mock, 0o755);
  env("CLAUDE_BIN", mock);
  env("PROXY_STATE_DIR", join(directory, "state"));
  env("CLAUDE_CONFIG_DIR", join(directory, "claude-config"));
  env("AGENT_TASKS_DIR", join(directory, "agent-tasks"));
});

afterAll(async () => {
  closeIdleWorkers();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const send = (blob: string, instructions: string) =>
  handleRequest(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        instructions,
        prompt_cache_key: "01a19825-0000-7000-8000-0000000000a1",
        input: [
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/p1_claude",
            content: [
              { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/p1_claude\nSender: /root\nPayload:\n" },
              { type: "encrypted_content", encrypted_content: blob },
            ],
          },
        ],
      }),
    }),
  );

async function eventually<T>(read: () => Promise<T | undefined>, ms = 2000): Promise<T | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined || Date.now() > until) return value;
    await Bun.sleep(20);
  }
}

test("a Claude request carrying an unreadable encrypted task is answered and then counted", async () => {
  const state = join(directory, "counted.json");
  env("COMB_BLOCKED_STATE", state);
  const response = await send("gAAAA-app-1", "blocked-app-count");
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body.output[0].content[0].text).toBe("mock-ok");
  const count = await eventually(async () => (JSON.parse(await readFile(state, "utf8")) as { count: number }).count);
  expect(count).toBe(1);
});

test("a counter that fails leaves the request intact", async () => {
  // A state path under a regular file: every write the counter tries throws ENOTDIR.
  const blocker = join(directory, "not-a-dir");
  await writeFile(blocker, "");
  env("COMB_BLOCKED_STATE", join(blocker, "blocked-tasks.json"));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const response = await send("gAAAA-app-2", "blocked-app-fail");
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).output[0].content[0].text).toBe("mock-ok");
    expect(await eventually(async () => errors.find((line) => line.startsWith("blocked-tasks:")))).toBeDefined();
  } finally {
    console.error = original;
  }
});
