import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUnavailable,
  listAccounts,
  observeRateLimit,
  pickAccount,
  resetAccountState,
} from "../src/accounts";

const keys = ["CLAUDE_ACCOUNT_ORDER", "CLAUDE_ACCOUNT_WEEKLY_CAP", "PROXY_STATE_DIR", "CLAUDE_CONFIG_DIR"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAccountState();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "claude-codex-proxy-policy-"));
  for (const name of ["hinson", "martin"]) {
    const dir = join(directory, "state", "accounts", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), "{}");
  }
  process.env.PROXY_STATE_DIR = join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "base");
}

const week = (utilization: number, resetsAt = Date.now() / 1000 + 86_400) => ({
  status: "allowed",
  unifiedWindows: { seven_day: { utilization, resetsAt } },
});

test("order puts named accounts first", async () => {
  await setup();
  expect(listAccounts().map((a) => a.name)).toEqual(["default", "hinson", "martin"]);
  process.env.CLAUDE_ACCOUNT_ORDER = "martin,default";
  expect(listAccounts().map((a) => a.name)).toEqual(["martin", "default", "hinson"]);
  expect(pickAccount()?.name).toBe("martin");
});

test("weekly cap benches an account at its threshold", async () => {
  await setup();
  process.env.CLAUDE_ACCOUNT_ORDER = "martin,default";
  process.env.CLAUDE_ACCOUNT_WEEKLY_CAP = "martin=50";
  const martin = listAccounts()[0];
  expect(isUnavailable(martin)).toBe(false); // unknown usage: allowed
  observeRateLimit(martin, week(0.49));
  expect(pickAccount()?.name).toBe("martin");
  observeRateLimit(martin, week(0.5));
  expect(isUnavailable(martin)).toBe(true);
  expect(pickAccount()?.name).toBe("default");
  // A reading whose window already reset no longer counts.
  observeRateLimit(martin, week(0.9, Date.now() / 1000 - 1));
  expect(pickAccount()?.name).toBe("martin");
});
