import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts } from "../src/accounts";
import { handleRequest } from "../src/app";
import { pinThreadAccount, threadAccount } from "../src/sessions";
import { openUsageDb } from "../src/usage";

let directory = "";
let state = "";
const saved: Record<string, string | undefined> = {};
const ENV = {
  CLAUDE_ACCOUNT_ORDER: "spare,default",
  CLAUDE_ACCOUNT_WEEKLY_CAP: "spare=80",
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-pins-"));
  state = join(directory, "state");
  await mkdir(join(state, "accounts", "spare"), { recursive: true });
  await mkdir(join(directory, "claude"), { recursive: true });
  const env: Record<string, string> = {
    ...ENV,
    PROXY_STATE_DIR: state,
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    TODAY_DB_PATH: join(directory, "today.sqlite"),
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  for (const name of ["PROXY_API_KEY"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  const today = new Database(env.TODAY_DB_PATH, { create: true });
  today.exec(`CREATE TABLE threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL,
    engine_thread_id TEXT, archived INTEGER NOT NULL DEFAULT 0)`);
  today.exec(`CREATE TABLE engine_bindings (engine_thread_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL)`);
  today.exec(`INSERT INTO threads VALUES ('today-a', 'Chat A', 'eng-a', 0)`);
  today.exec(`INSERT INTO engine_bindings VALUES ('eng-old', 'today-a')`);
  today.close();
  pinThreadAccount("eng-a", "default");
  pinThreadAccount("eng-b", "default");
  pinThreadAccount("eng-old", "spare");
  const usage = openUsageDb();
  usage.query(`INSERT INTO turns (ts, request_id, attempt, worker_id, worker_turn, thread_id, model, is_error, account)
    VALUES (?, 'r', 1, 'w1', 1, 'eng-a', 'opus', 0, 'default')`).run(Date.now());
  usage.query(`INSERT INTO turns (ts, request_id, attempt, worker_id, worker_turn, thread_id, model, is_error, account)
    VALUES (?, 'r', 1, 'w2', 1, 'eng-b', 'opus', 0, 'default')`).run(Date.now() - 3 * 3600_000);
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const call = async (path: string, body?: unknown, init: RequestInit = {}) => {
  const response = await handleRequest(new Request(`http://127.0.0.1:3456${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as any };
};

const backups = async () => (await readdir(state)).filter((file) => file.startsWith("sessions.sqlite.bak-api-"));

test("lists pins with last use and the Today chat", async () => {
  const { status, body } = await call("/pins");
  expect(status).toBe(200);
  expect(body.accounts.sort()).toEqual(["default", "spare"]);
  expect(body.counts).toEqual({ default: 2, spare: 1 });
  const a = body.pins.find((pin: any) => pin.threadId === "eng-a");
  expect(a).toMatchObject({ account: "default", lastUsedAccount: "default", todayThreadId: "today-a", title: "Chat A", archived: false });
  expect(a.lastUsedAt).toBeString();
  expect(body.pins.find((pin: any) => pin.threadId === "eng-old").todayThreadId).toBe("today-a");
  expect(body.pins[0].threadId).toBe("eng-a");
  const filtered = await call("/pins?account=spare");
  expect(filtered.body.pins.map((pin: any) => pin.threadId)).toEqual(["eng-old"]);
});

test("sets pins after a checked backup and reports what changed", async () => {
  const before = (await backups()).length;
  const { status, body } = await call("/pins", {
    pins: [{ threadId: "eng-a", account: "spare" }, { threadId: "eng-new", account: "spare" }, { threadId: "eng-old", account: "spare" }],
    reason: "Test set!",
  });
  expect(status).toBe(200);
  expect(body.changes).toEqual([
    { threadId: "eng-a", from: "default", to: "spare" },
    { threadId: "eng-new", from: null, to: "spare" },
  ]);
  expect(body.backup).toContain("sessions.sqlite.bak-api-test-set-");
  expect((await backups()).length).toBe(before + 1);
  const copy = new Database(body.backup, { readonly: true });
  expect(copy.query("SELECT account FROM thread_accounts WHERE thread_id = 'eng-a'").get()).toEqual({ account: "default" });
  copy.close();
  // Read straight from the table on the next turn: nothing caches pins.
  expect(threadAccount("eng-a")).toBe("spare");
  expect(threadAccount("eng-new")).toBe("spare");
});

test("a turn that started before a move does not undo it", () => {
  // runClaude saves its pin with the account it read at the start as `expected`.
  pinThreadAccount("eng-a", "default", "default");
  expect(threadAccount("eng-a")).toBe("spare");
});

test("dry run changes nothing and takes no backup", async () => {
  const before = (await backups()).length;
  const { body } = await call("/pins/move", { from: "spare", to: "default", dryRun: true });
  expect(body.dryRun).toBe(true);
  expect(body.changed).toBe(3);
  expect(threadAccount("eng-a")).toBe("spare");
  expect((await backups()).length).toBe(before);
});

test("bulk move honours thread and idle filters", async () => {
  pinThreadAccount("eng-b", "spare");
  const idle = await call("/pins/move", { from: "spare", to: "default", idleForMs: 3600_000 });
  // eng-a was used just now; eng-b 3 h ago; eng-new and eng-old never.
  expect(idle.body.changes.map((change: any) => change.threadId).sort()).toEqual(["eng-b", "eng-new", "eng-old"]);
  expect(threadAccount("eng-a")).toBe("spare");
  const only = await call("/pins/move", { from: "default", to: "spare", threadIds: ["eng-b", "eng-missing"] });
  expect(only.body.changes).toEqual([{ threadId: "eng-b", from: "default", to: "spare" }]);
  const all = await call("/pins/move", { from: "spare", to: "default" });
  expect(all.body.changes.map((change: any) => change.threadId).sort()).toEqual(["eng-a", "eng-b"]);
  expect((await call("/pins")).body.counts).toEqual({ default: 4 });
});

test("clears pins", async () => {
  const { body } = await call("/pins/clear", { threadIds: ["eng-new", "eng-never"] });
  expect(body.changes).toEqual([{ threadId: "eng-new", from: "default", to: null }]);
  expect(threadAccount("eng-new")).toBeUndefined();
});

test("rolls back every edit when one write fails", async () => {
  const db = new Database(join(state, "sessions.sqlite"));
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON thread_accounts WHEN NEW.thread_id = 'eng-boom'
    BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const { status, body } = await call("/pins", {
    pins: [{ threadId: "eng-a", account: "spare" }, { threadId: "eng-boom", account: "spare" }],
  });
  db.exec("DROP TRIGGER boom");
  db.close();
  expect(status).toBe(500);
  expect(body.error.message).toContain("boom");
  expect(threadAccount("eng-a")).toBe("default");
  expect(threadAccount("eng-boom")).toBeUndefined();
});

test("refuses unknown accounts and bad input without writing", async () => {
  const before = (await backups()).length;
  for (const [path, body] of [
    ["/pins", { pins: [{ threadId: "eng-a", account: "hinson" }] }],
    ["/pins/move", { from: "default", to: "nobody" }],
    ["/pins/move", { from: "default", to: "default" }],
    ["/pins", { pins: [{ threadId: "eng-a", account: "spare" }, { threadId: "eng-a", account: "default" }] }],
    ["/pins/clear", { threadIds: ["bad id;"] }],
    ["/pins/clear", { threadIds: [] }],
  ] as const) {
    const response = await call(path, body);
    expect(response.status).toBe(400);
  }
  expect(threadAccount("eng-a")).toBe("default");
  expect((await backups()).length).toBe(before);
});

test("refuses order, caps, credentials and login; leaves them untouched", async () => {
  const order = listAccounts().map((account) => account.name);
  for (const field of ["order", "accountOrder", "weeklyCap", "caps", "credentials", "login", "token"]) {
    const response = await call("/pins", { pins: [{ threadId: "eng-a", account: "spare" }], [field]: "x" });
    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("pins only");
  }
  expect(threadAccount("eng-a")).toBe("default");
  expect(process.env.CLAUDE_ACCOUNT_ORDER).toBe(ENV.CLAUDE_ACCOUNT_ORDER);
  expect(process.env.CLAUDE_ACCOUNT_WEEKLY_CAP).toBe(ENV.CLAUDE_ACCOUNT_WEEKLY_CAP);
  expect(listAccounts().map((account) => account.name)).toEqual(order);
  expect((await call("/pins/order", {})).status).toBe(404);
});

test("is unreachable through a forwarded hop", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3456/pins", {
    headers: { "x-forwarded-for": "100.64.0.1" },
  }));
  expect(response.status).toBe(403);
});
