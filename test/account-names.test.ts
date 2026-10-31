import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as health from "../src/auth-health";
import { listAccounts, markAuthFailed, resetAccountState } from "../src/accounts";

const original = { state: process.env.PROXY_STATE_DIR, config: process.env.CLAUDE_CONFIG_DIR };
let root = "";

function setup(): string {
  root = mkdtempSync(join(tmpdir(), "proxy-account-names-"));
  process.env.PROXY_STATE_DIR = join(root, "state");
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const accounts = join(root, "state", "accounts");
  mkdirSync(accounts, { recursive: true });
  return accounts;
}

afterEach(() => {
  resetAccountState();
  for (const [key, value] of [["PROXY_STATE_DIR", original.state], ["CLAUDE_CONFIG_DIR", original.config]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

// Alex 21:57 Oct 30: `claude /login` with CLAUDE_CONFIG_DIR=accounts/stanford takes
// its lock as the directory `accounts/stanford.lock`. The proxy listed that as an
// account, its usage probe ran claude in it (so the lock could never be removed),
// and Alex was told to log in to "stanford.lock".
test("lock directories and other dotted names are not accounts", () => {
  const accounts = setup();
  for (const name of ["stanford", "stanford.lock", ".hidden", "x.bak", "val", "with-dash_1"]) {
    mkdirSync(join(accounts, name));
    writeFileSync(join(accounts, name, ".credentials.json"), "{}");
  }
  writeFileSync(join(accounts, "plainfile"), "");
  expect(listAccounts().map((a) => a.name).sort()).toEqual(["default", "stanford", "val", "with-dash_1"]);
});

test("an auth incident for a lock directory is forgotten, never sent", async () => {
  const accounts = setup();
  const dir = join(accounts, "stanford.lock");
  mkdirSync(dir);
  // An incident recorded by an older proxy that listed the lock directory.
  markAuthFailed({ name: "stanford.lock", dir, isDefault: false });
  const sent: string[] = [];
  await health.flushAuthWarnings(async (message) => { sent.push(message); return true; }, "test");
  expect(sent).toEqual([]);
  expect(health.authHealth({ name: "stanford.lock", dir, isDefault: false }).authFailedSince).toBeNull();
  // The record itself is gone, so no later proxy copy picks the incident up again.
  const saved = readFileSync(join(root, "state", "account-auth.json"), "utf8");
  expect(saved).not.toContain("stanford.lock");
});
