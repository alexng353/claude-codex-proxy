import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAccounts, resetAccountState } from "../src/accounts";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { pinsToken } from "../src/pins";
import { processStartTime } from "../src/handoff";
import { inFlightPath, sharedThreadsInFlight } from "../src/in-flight";
import { pinThreadAccount, threadAccount, threadPin } from "../src/sessions";
import { openUsageDb } from "../src/usage";

let directory = "";
let state = "";
const saved: Record<string, string | undefined> = {};
const ENV = {
  CLAUDE_ACCOUNT_ORDER: "default,spare",
  CLAUDE_ACCOUNT_WEEKLY_CAP: "spare=80",
};
let work = "";
let SLUG = "";

function setEnv(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claude-codex-pins-"));
  state = join(directory, "state");
  work = join(directory, "work");
  await mkdir(work);
  // Claude Code's project folder name for its working directory.
  SLUG = work.replace(/[^a-zA-Z0-9]/g, "-");
  const base = join(directory, "claude");
  const shared = join(base, "projects", SLUG);
  await mkdir(shared, { recursive: true });
  await writeFile(join(base, ".credentials.json"), "{}");
  // spare: linked and logged in; loose: its own transcripts; nocreds: linked, logged out.
  for (const name of ["spare", "loose", "nocreds"]) {
    const dir = join(state, "accounts", name);
    await mkdir(join(dir, "projects"), { recursive: true });
    if (name !== "nocreds") await writeFile(join(dir, ".credentials.json"), "{}");
    if (name === "loose") await mkdir(join(dir, "projects", SLUG));
    else await symlink(shared, join(dir, "projects", SLUG));
  }
  // whole: its entire projects folder links to the base one (linkSharedEntries' layout).
  const whole = join(state, "accounts", "whole");
  await mkdir(whole, { recursive: true });
  await writeFile(join(whole, ".credentials.json"), "{}");
  await symlink(join(base, "projects"), join(whole, "projects"));
  const mock = join(directory, "claude-bin");
  // Each turn waits for the test's go-ahead, so the test can edit pins mid-turn.
  await writeFile(mock, `#!/bin/sh
while IFS= read -r input; do
  touch '${directory}/started'
  while [ ! -e '${directory}/go' ]; do sleep 0.05; done
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"ok","tool_calls":[]}}'
done
`);
  await chmod(mock, 0o755);
  for (const [name, value] of Object.entries({
    ...ENV,
    PROXY_STATE_DIR: state,
    CLAUDE_CONFIG_DIR: base,
    CLAUDE_CWD: work,
    CLAUDE_BIN: mock,
    TODAY_DB_PATH: join(directory, "today.sqlite"),
  })) setEnv(name, value);
  setEnv("PROXY_API_KEY", undefined);
  setEnv("PORT", undefined);
  resetAccountState();
  const today = new Database(process.env.TODAY_DB_PATH!, { create: true });
  today.exec(`CREATE TABLE threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL,
    engine_thread_id TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0)`);
  today.exec(`CREATE TABLE engine_bindings (engine_thread_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
    bound_at_ms INTEGER NOT NULL DEFAULT 0)`);
  today.exec(`INSERT INTO threads VALUES ('today-a', 'Chat A', 'eng-a', 0, 5)`);
  today.exec(`INSERT INTO threads VALUES ('today-old', 'Old chat', NULL, 1, 1)`);
  today.exec(`INSERT INTO engine_bindings VALUES ('eng-old', 'today-a', 2)`);
  // A stale binding of eng-a: the thread's own engine id must win.
  today.exec(`INSERT INTO engine_bindings VALUES ('eng-a', 'today-old', 9)`);
  today.close();
  pinThreadAccount("eng-a", "default");
  pinThreadAccount("eng-b", "default");
  pinThreadAccount("eng-old", "spare");
  const usage = openUsageDb();
  const turn = usage.query(`INSERT INTO turns (ts, request_id, attempt, worker_id, worker_turn, thread_id, model, is_error, account)
    VALUES (?, 'r', 1, ?, 1, ?, 'opus', 0, 'default')`);
  turn.run(Date.now(), "w1", "eng-a");
  turn.run(Date.now() - 3 * 3600_000, "w2", "eng-b");
});

afterAll(async () => {
  closeIdleWorkers();
  resetAccountState();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

type Init = { token?: string | null; headers?: Record<string, string>; host?: string; method?: string; peer?: string | null };

const call = async (path: string, body?: unknown, init: Init = {}) => {
  const token = init.token === undefined ? pinsToken() : init.token;
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await handleRequest(new Request(`http://${init.host ?? "127.0.0.1:3456"}${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), init.peer === undefined ? "127.0.0.1" : init.peer ?? undefined);
  return { status: response.status, body: await response.json() as any };
};

const backupDir = () => join(state, "pin-backups");
const backups = async () => existsSync(backupDir()) ? (await readdir(backupDir())).sort() : [];

test("lists pins with last use and the Today chat", async () => {
  const { status, body } = await call("/pins");
  expect(status).toBe(200);
  expect(body.accounts.sort()).toEqual(["default", "loose", "nocreds", "spare", "whole"]);
  expect(body.counts).toEqual({ default: 2, spare: 1 });
  const a = body.pins.find((pin: any) => pin.threadId === "eng-a");
  expect(a).toMatchObject({ account: "default", lastUsedAccount: "default", todayThreadId: "today-a", title: "Chat A", archived: false });
  expect(a.lastUsedAt).toBeString();
  expect(body.pins.find((pin: any) => pin.threadId === "eng-old").todayThreadId).toBe("today-a");
  expect(body.pins[0].threadId).toBe("eng-a");
  const filtered = await call("/pins?account=spare");
  expect(filtered.body.pins.map((pin: any) => pin.threadId)).toEqual(["eng-old"]);
});

test("lists without titles when the Today database is missing or corrupt", async () => {
  const real = process.env.TODAY_DB_PATH;
  try {
    for (const path of [join(directory, "absent.sqlite"), join(directory, "corrupt.sqlite")]) {
      if (path.endsWith("corrupt.sqlite")) await writeFile(path, "not a database at all".repeat(100));
      process.env.TODAY_DB_PATH = path;
      const { status, body } = await call("/pins");
      expect(status).toBe(200);
      expect(body.pins).toHaveLength(3);
      expect(body.pins.every((pin: any) => pin.title === null && pin.todayThreadId === null)).toBe(true);
    }
  } finally {
    process.env.TODAY_DB_PATH = real;
  }
});

test("writes need the local token; browsers, foreign hosts and non-JSON bodies are refused", async () => {
  const write = { pins: [{ threadId: "eng-a", account: "spare" }] };
  expect((await call("/pins", write, { token: null })).status).toBe(401);
  expect((await call("/pins/move", { from: "default", to: "spare" }, { token: "wrong" })).status).toBe(401);
  expect((await call("/pins", write, { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await call("/pins", undefined, { headers: { origin: "http://127.0.0.1:3456" } })).status).toBe(403);
  expect((await call("/pins", undefined, { host: "evil.example:3456" })).status).toBe(403);
  expect((await call("/pins", write, { host: "127.0.0.1:9999" })).status).toBe(403);
  expect((await call("/pins", write, { headers: { "content-type": "text/plain" } })).status).toBe(415);
  expect((await call("/pins", undefined, { host: "localhost:3456" })).status).toBe(200);
  expect(threadAccount("eng-a")).toBe("default");
  const tokenFile = join(state, "pins.token");
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  expect((await readFile(tokenFile, "utf8")).trim()).toBe(pinsToken());
});

test("PROXY_API_KEY is accepted for writes and required for reads when set", async () => {
  process.env.PROXY_API_KEY = "shared-key";
  try {
    expect((await call("/pins", undefined, { token: null })).status).toBe(401);
    expect((await call("/pins", undefined, { token: "shared-key" })).status).toBe(200);
    expect((await call("/pins", undefined)).status).toBe(200);
    const dry = await call("/pins/move", { from: "default", to: "spare", dryRun: true }, { token: "shared-key" });
    expect(dry.status).toBe(200);
  } finally {
    delete process.env.PROXY_API_KEY;
  }
});

test("sets pins after a verified pin backup and reports what changed", async () => {
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
  expect(body.warnings.join("\n")).toContain("eng-new");
  expect(body.warnings.join("\n")).not.toContain("eng-a");
  const files = await backups();
  expect(files.length).toBe(before + 1);
  expect(files.some((file) => file.includes(".tmp"))).toBe(false);
  expect(body.backup).toContain(join("pin-backups", "pins-"));
  expect(body.backup).toContain("-test-set-");
  expect(statSync(body.backup).mode & 0o777).toBe(0o600);
  const copy = JSON.parse(await readFile(body.backup, "utf8"));
  expect(copy.threadAccounts).toContainEqual({ threadId: "eng-a", account: "default" });
  expect(copy.threadAccounts).toHaveLength(3);
  // Read straight from the table on the next turn: nothing caches pins.
  expect(threadAccount("eng-a")).toBe("spare");
  expect(threadAccount("eng-new")).toBe("spare");
  expect(threadPin("eng-a")!.generation).toBe(1);
});

test("a turn that read A does not undo an explicit A -> C -> A", async () => {
  const start = threadPin("eng-b")!;
  expect(start.account).toBe("default");
  await call("/pins", { pins: [{ threadId: "eng-b", account: "spare" }] });
  await call("/pins", { pins: [{ threadId: "eng-b", account: "default" }] });
  // The turn ran elsewhere (failover) and saves with what it read at its start.
  pinThreadAccount("eng-b", "spare", start.account, start.generation);
  expect(threadAccount("eng-b")).toBe("default");
  // With nothing in between, the same save goes through.
  const now = threadPin("eng-b")!;
  pinThreadAccount("eng-b", "spare", now.account, now.generation);
  expect(threadAccount("eng-b")).toBe("spare");
  pinThreadAccount("eng-b", "default");
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
  expect(only.body.warnings.join("\n")).toContain("eng-missing");
  expect(only.body.warnings.join("\n")).not.toContain("eng-b");
  const all = await call("/pins/move", { from: "spare", to: "default" });
  expect(all.body.changes.map((change: any) => change.threadId).sort()).toEqual(["eng-a", "eng-b"]);
  expect((await call("/pins")).body.counts).toEqual({ default: 4 });
});

test("the idle filter fails closed when usage is unreadable", async () => {
  const usage = new Database(join(state, "usage.sqlite"));
  usage.exec("ALTER TABLE turns RENAME TO turns_hidden");
  try {
    const before = (await backups()).length;
    const { status } = await call("/pins/move", { from: "default", to: "spare", idleForMs: 0 });
    expect(status).toBe(503);
    expect((await call("/pins")).body.counts).toEqual({ default: 4 });
    expect((await backups()).length).toBe(before);
  } finally {
    usage.exec("ALTER TABLE turns_hidden RENAME TO turns");
    usage.close();
  }
});

test("clears pins and keeps the generation across a clear", async () => {
  const generation = threadPin("eng-new")!.generation;
  const { body } = await call("/pins/clear", { threadIds: ["eng-new", "eng-never"] });
  expect(body.changes).toEqual([{ threadId: "eng-new", from: "default", to: null }]);
  expect(threadAccount("eng-new")).toBeUndefined();
  pinThreadAccount("eng-new", "default");
  expect(threadPin("eng-new")!.generation).toBe(generation + 1);
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

test("writes nothing when the backup cannot be written", async () => {
  const files = await backups();
  await rm(backupDir(), { recursive: true, force: true });
  await writeFile(backupDir(), "in the way");
  try {
    const { status } = await call("/pins", { pins: [{ threadId: "eng-a", account: "spare" }] });
    expect(status).toBe(500);
    expect(threadAccount("eng-a")).toBe("default");
  } finally {
    await rm(backupDir(), { force: true });
  }
  expect(files.length).toBeGreaterThan(0);
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
    ["/pins", "not json"],
  ] as const) {
    const response = await call(path, body);
    expect(response.status).toBe(400);
  }
  expect(threadAccount("eng-a")).toBe("default");
  expect((await backups()).length).toBe(before);
});

test("refuses moves onto or off an account whose transcripts are not shared", async () => {
  const set = await call("/pins", { pins: [{ threadId: "eng-a", account: "loose" }] });
  expect(set.status).toBe(409);
  expect(set.body.error.message).toContain("claude-account-move");
  expect((await call("/pins/move", { from: "default", to: "loose", force: true })).status).toBe(409);
  pinThreadAccount("eng-loose", "loose");
  expect((await call("/pins/move", { from: "loose", to: "default" })).status).toBe(409);
  expect(threadAccount("eng-loose")).toBe("loose");
  expect(threadAccount("eng-a")).toBe("default");
});

test("accepts an account whose whole projects folder is linked", async () => {
  const onto = await call("/pins", { pins: [{ threadId: "eng-a", account: "whole" }] });
  expect(onto.status).toBe(200);
  expect(threadAccount("eng-a")).toBe("whole");
  const off = await call("/pins/move", { from: "whole", to: "default", threadIds: ["eng-a"] });
  expect(off.status).toBe(200);
  expect(threadAccount("eng-a")).toBe("default");
});

test("refuses an unavailable account unless forced, and warns either way", async () => {
  const refused = await call("/pins", { pins: [{ threadId: "eng-a", account: "nocreds" }] });
  expect(refused.status).toBe(409);
  expect(refused.body.error.message).toContain("unavailable");
  expect(threadAccount("eng-a")).toBe("default");
  const forced = await call("/pins", { pins: [{ threadId: "eng-a", account: "nocreds" }], force: true });
  expect(forced.status).toBe(200);
  expect(forced.body.warnings.join("\n")).toContain("nocreds");
  expect(threadAccount("eng-a")).toBe("nocreds");
  await call("/pins", { pins: [{ threadId: "eng-a", account: "default" }] });
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

test("answers loopback peers only, and refuses when the peer is unknown", async () => {
  for (const peer of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
    expect((await call("/pins", undefined, { peer })).status).toBe(200);
  const before = (await call("/pins")).body.counts;
  for (const peer of ["192.168.1.5", "100.64.0.1", "::ffff:10.0.0.2", "fe80::1", null]) {
    expect((await call("/pins", undefined, { peer })).status).toBe(403);
    const write = await call("/pins/move", { from: "default", to: "spare" }, { peer });
    expect(write.status).toBe(403);
    expect(write.body.error.message).toContain("loopback");
  }
  expect((await call("/pins")).body.counts).toEqual(before);
});

test("the idle filter skips a thread running in another proxy copy, and ignores a dead copy's marks", async () => {
  const thread = `eng-${crypto.randomUUID()}`;
  pinThreadAccount(thread, "nocreds");
  // A live process standing in for the other handoff slot.
  const other = Bun.spawn(["sleep", "60"]);
  try {
    sharedThreadsInFlight(); // creates the table
    const marks = new Database(inFlightPath());
    try {
      marks.query("INSERT INTO threads_in_flight (thread_id, pid, start, count) VALUES (?, ?, ?, 1)")
        .run(thread, other.pid, processStartTime(other.pid) ?? null);
    } finally {
      marks.close();
    }
    const busy = await call("/pins/move", { from: "nocreds", to: "spare", idleForMs: 0, dryRun: true });
    expect(busy.body.changes.map((change: any) => change.threadId)).not.toContain(thread);
    expect(busy.body.warnings.join("\n")).toContain(`${thread}: skipped, a turn is running in another proxy copy (pid ${other.pid})`);
  } finally {
    other.kill();
    await other.exited;
  }
  const free = await call("/pins/move", { from: "nocreds", to: "spare", idleForMs: 0, threadIds: [thread], dryRun: true });
  expect(free.body.changes.map((change: any) => change.threadId)).toEqual([thread]);
});

test("is unreachable through a forwarded hop", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3456/pins", {
    headers: { "x-forwarded-for": "100.64.0.1", authorization: `Bearer ${pinsToken()}` },
  }));
  expect(response.status).toBe(403);
});

/** One real turn through runClaude (mock Claude), with `during` run while it is in flight. */
async function turn(thread: string, during: () => Promise<void> = async () => {}) {
  await rm(join(directory, "started"), { force: true });
  await rm(join(directory, "go"), { force: true });
  const pending = handleRequest(new Request("http://local/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", instructions: "pins", prompt_cache_key: thread, input: `hello ${thread}` }),
  }));
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(directory, "started"))) {
    if (Date.now() > deadline) throw new Error("mock Claude never started");
    await Bun.sleep(20);
  }
  try {
    await during();
  } finally {
    await writeFile(join(directory, "go"), "");
  }
  const response = await pending;
  expect(response.status).toBe(200);
}

test("a turn saves the account it ran on when nobody edited the pin", async () => {
  const thread = `eng-${crypto.randomUUID()}`;
  pinThreadAccount(thread, "nocreds");
  await turn(thread);
  expect(threadAccount(thread)).toBe("default");
}, 30_000);

test("runClaude saves with the pin it read, so a mid-turn move survives", async () => {
  const thread = `eng-${crypto.randomUUID()}`;
  pinThreadAccount(thread, "nocreds");
  await turn(thread, async () => {
    expect((await call("/pins/move", { from: "nocreds", to: "spare", threadIds: [thread] })).body.changed).toBe(1);
  });
  expect(threadAccount(thread)).toBe("spare");
}, 30_000);

test("runClaude saves with the generation it read: a mid-turn A -> C -> A survives; idle moves skip it", async () => {
  const thread = `eng-${crypto.randomUUID()}`;
  pinThreadAccount(thread, "nocreds");
  await turn(thread, async () => {
    // Marked where the other handoff slot can see it too.
    expect(sharedThreadsInFlight().get(thread)).toEqual([process.pid]);
    const idle = await call("/pins/move", { from: "nocreds", to: "spare", idleForMs: 0, dryRun: true });
    expect(idle.body.changes.map((change: any) => change.threadId)).not.toContain(thread);
    expect(idle.body.warnings.join("\n")).toContain(thread);
    await call("/pins", { pins: [{ threadId: thread, account: "default" }] });
    await call("/pins", { pins: [{ threadId: thread, account: "nocreds" }], force: true });
  });
  // The turn ran on default (nocreds is logged out) but must not overwrite the explicit pin.
  expect(threadAccount(thread)).toBe("nocreds");
  expect(sharedThreadsInFlight().has(thread)).toBe(false);
}, 30_000);

test("runClaude balances a start mark that was queued under contention", async () => {
  const thread = `eng-${crypto.randomUUID()}`;
  sharedThreadsInFlight();
  const blocker = new Database(inFlightPath());
  blocker.exec("BEGIN IMMEDIATE");
  let locked = true;
  try {
    await turn(thread, async () => {
      blocker.exec("ROLLBACK");
      locked = false;
      expect(sharedThreadsInFlight().get(thread)).toEqual([process.pid]);
    });
    expect(sharedThreadsInFlight().has(thread)).toBe(false);
  } finally {
    if (locked) blocker.exec("ROLLBACK");
    blocker.close();
  }
}, 30_000);
