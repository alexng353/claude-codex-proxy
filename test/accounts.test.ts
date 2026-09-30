import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markLimited, listAccounts, resetAccountState } from "../src/accounts";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { openUsageDb, syncUsage } from "../src/usage";

let directory = "";
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string) {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-proxy-accounts-"));
  const base = join(directory, "claude-config");
  const state = join(directory, "state");
  await mkdir(join(base, "projects"), { recursive: true });
  await writeFile(join(base, "settings.json"), "{}");
  await writeFile(join(base, ".credentials.json"), "{}");
  const spare = join(state, "accounts", "spare");
  await mkdir(spare, { recursive: true });
  await writeFile(join(spare, ".credentials.json"), "{}");
  // The base account is out of quota; any other config dir answers.
  const mock = join(directory, "claude");
  await writeFile(
    mock,
    `#!/bin/sh
printf '%s\\n' "$CLAUDE_CONFIG_DIR $*" >> '${directory}/launches'
while IFS= read -r input; do
  printf '%s\\n' "$CLAUDE_CONFIG_DIR $input" >> '${directory}/inputs'
  if { [ "$CLAUDE_CONFIG_DIR" = "${base}" ] && [ ! -e '${directory}/allow-base' ]; } || [ "$(basename "$CLAUDE_CONFIG_DIR")" = "blocked" ]; then
    printf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800}}'
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You have hit your limit"}'
  else
    printf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.42,"resetsAt":1790759400},"seven_day":{"utilization":0.08,"resetsAt":1791028800}}}}'
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"from-'"$(basename "$CLAUDE_CONFIG_DIR")"'","tool_calls":[]}}'
  fi
done
`,
  );
  await chmod(mock, 0o755);
  setEnv("CLAUDE_BIN", mock);
  setEnv("CLAUDE_CONFIG_DIR", base);
  setEnv("PROXY_STATE_DIR", state);
  resetAccountState();
});

afterAll(async () => {
  closeIdleWorkers();
  resetAccountState();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

async function sendRaw(input: string) {
  const response = await handleRequest(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", instructions: "accounts", input }),
    }),
  );
  return response;
}

async function send(input: string) {
  return (await (await sendRaw(input)).json()) as any;
}

test("fails over to the next account when one hits its limit", async () => {
  const first = await send("hello");
  expect(first.output[0].content[0].text).toBe("from-spare");

  const status = (await (
    await handleRequest(new Request("http://local/accounts"))
  ).json()) as any;
  expect(status.accounts.map((a: any) => a.name)).toEqual(["default", "spare"]);
  expect(status.accounts[0].limitedUntil).toBe("2100-01-01T00:00:00.000Z");
  expect(status.accounts[1].limitedUntil).toBeNull();

  // New conversations go straight to the account that is not limited.
  const second = await send("another");
  expect(second.output[0].content[0].text).toBe("from-spare");

  // The spare account shares everything except its credentials.
  const spare = join(directory, "state", "accounts", "spare");
  expect((await lstat(join(spare, "projects"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(spare, "settings.json"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(spare, ".credentials.json"))).isSymbolicLink()).toBe(false);
});

test("reports the answering account's usage in Codex rate-limit headers", async () => {
  const response = await sendRaw("headers");
  expect(response.headers.get("x-codex-limit-name")).toBe("Claude (spare)");
  expect(response.headers.get("x-codex-primary-used-percent")).toBe("42");
  expect(response.headers.get("x-codex-primary-window-minutes")).toBe("300");
  expect(response.headers.get("x-codex-primary-reset-at")).toBe("1790759400");
  expect(response.headers.get("x-codex-secondary-used-percent")).toBe("8");
  expect(response.headers.get("x-codex-secondary-window-minutes")).toBe("10080");
});

test("records which account produced each turn", () => {
  syncUsage();
  const rows = openUsageDb()
    .query("SELECT account, is_error FROM turns ORDER BY id")
    .all() as Array<{ account: string; is_error: number }>;
  expect(rows[0]).toEqual({ account: "default", is_error: 1 });
  expect(rows.slice(1).every((row) => row.account === "spare")).toBe(true);
  const byAccount = openUsageDb()
    .query("SELECT account, turns FROM usage_by_account ORDER BY account")
    .all();
  expect(byAccount).toEqual([
    { account: "default", turns: 1 },
    { account: "spare", turns: rows.length - 1 },
  ]);
});

test("resumes the original session and sends only the delta across two limited accounts", async () => {
  closeIdleWorkers();
  resetAccountState();
  await writeFile(join(directory, "allow-base"), "");
  const request = async (input: unknown) => (await (await handleRequest(new Request("http://local/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", instructions: "failover-resume", input }),
  }))).json()) as any;
  const first = await request("cache-first");
  expect(first.output[0].content[0].text).toBe("from-claude-config");
  const launchesBefore = (await readFile(join(directory, "launches"), "utf8")).trim().split("\n");
  const originalId = launchesBefore.at(-1)!.match(/--session-id ([a-f0-9-]+)/)![1];
  closeIdleWorkers();
  const checkpoint = crypto.randomUUID();
  const project = join(directory, "claude-config", "projects", "-tmp-resume");
  await mkdir(project);
  await writeFile(join(project, `${originalId}.jsonl`), [
    { type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "answer" }] } },
    { type: "user", uuid: checkpoint, message: { content: [{ type: "tool_result", tool_use_id: "answer" }] } },
    { type: "user", uuid: crypto.randomUUID(), message: { content: [{ type: "text", text: "failed-attempt" }] } },
    { type: "assistant", uuid: crypto.randomUUID(), isApiErrorMessage: true },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  await rm(join(directory, "allow-base"));
  const blocked = join(directory, "state", "accounts", "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, ".credentials.json"), "{}");
  const second = await request([
    { role: "user", content: "cache-first" },
    { role: "assistant", content: "from-claude-config" },
    { role: "user", content: "cache-next" },
  ]);
  expect(second.output[0].content[0].text).toBe("from-spare");
  const launches = (await readFile(join(directory, "launches"), "utf8")).trim().split("\n").slice(launchesBefore.length);
  expect(launches).toHaveLength(3);
  for (const launch of launches) {
    expect(launch).toContain(`--resume ${originalId} --fork-session`);
    expect(launch).toContain(`--resume-session-at ${checkpoint}`);
  }
  const inputs = (await readFile(join(directory, "inputs"), "utf8")).trim().split("\n").slice(-3);
  for (const input of inputs) {
    expect(input).toContain("cache-next");
    expect(input).not.toContain("cache-first");
  }
});


test("pins a thread across worker loss and quota reset, including fresh history", async () => {
  closeIdleWorkers();
  resetAccountState();
  await rm(join(directory, "allow-base"), { force: true });
  const thread = crypto.randomUUID();
  const request = async (input: string, id = thread) => {
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", instructions: "pinning", prompt_cache_key: id, input }),
    }));
    return await response.json() as any;
  };
  expect((await request("pin-first")).output[0].content[0].text).toBe("from-spare");
  closeIdleWorkers();
  resetAccountState();
  await writeFile(join(directory, "allow-base"), "");
  expect((await request("compacted-history")).output[0].content[0].text).toBe("from-spare");
  expect((await request("new-thread", crypto.randomUUID())).output[0].content[0].text).toBe("from-claude-config");
});


test("a limited pinned account fails over durably and a removed account can be replaced", async () => {
  closeIdleWorkers();
  resetAccountState();
  await writeFile(join(directory, "allow-base"), "");
  const { pinThreadAccount, threadAccount } = await import("../src/sessions");
  const thread = crypto.randomUUID();
  pinThreadAccount(thread, "spare");
  markLimited(listAccounts().find((a) => a.name === "spare")!, Date.now() + 60_000);
  const request = async (id: string) => {
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", prompt_cache_key: id, input: "replacement" }),
    }));
    expect(response.status).toBe(200);
  };
  await request(thread);
  expect(threadAccount(thread)).toBe("default");
  closeIdleWorkers();
  resetAccountState();
  await request(thread);
  expect(threadAccount(thread)).toBe("default");
  pinThreadAccount(thread, "removed");
  await request(thread);
  expect(threadAccount(thread)).toBe("default");
});


test("a pin update failure preserves the completed model response", async () => {
  closeIdleWorkers();
  resetAccountState();
  await writeFile(join(directory, "allow-base"), "");
  const { pinThreadAccount } = await import("../src/sessions");
  const thread = crypto.randomUUID();
  pinThreadAccount(thread, "default");
  const db = new Database(join(directory, "state", "sessions.sqlite"));
  db.exec("CREATE TRIGGER reject_pin_update BEFORE UPDATE ON thread_accounts BEGIN SELECT RAISE(FAIL, 'pin unavailable'); END");
  try {
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", prompt_cache_key: thread, input: "write-failure" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.output[0].content[0].text).toBe("from-claude-config");
  } finally {
    db.exec("DROP TRIGGER reject_pin_update");
    db.close();
  }
});


test("an initial pin write failure blocks inference", async () => {
  closeIdleWorkers();
  const { threadAccount } = await import("../src/sessions");
  const thread = crypto.randomUUID();
  threadAccount(thread);
  const launches = await readFile(join(directory, "launches"), "utf8");
  const db = new Database(join(directory, "state", "sessions.sqlite"));
  db.exec("CREATE TRIGGER reject_pin_insert BEFORE INSERT ON thread_accounts BEGIN SELECT RAISE(FAIL, 'pin unavailable'); END");
  try {
    const response = await handleRequest(new Request("http://local/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", prompt_cache_key: thread, input: "initial-write-failure" }),
    }));
    expect(response.status).toBe(502);
    expect(await readFile(join(directory, "launches"), "utf8")).toBe(launches);
  } finally {
    db.exec("DROP TRIGGER reject_pin_insert");
    db.close();
  }
});
