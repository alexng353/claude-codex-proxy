import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountStatus,
  isUnavailable,
  listAccounts,
  markTurn,
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

// alex-0234: the window's green dot is the account a new unpinned turn takes now.
test("exactly one account is active: the one a turn would pick, past the caps", async () => {
  await setup();
  process.env.CLAUDE_ACCOUNT_ORDER = "martin,default";
  process.env.CLAUDE_ACCOUNT_WEEKLY_CAP = "martin=50";
  const active = () => accountStatus().filter((a) => a.active).map((a) => a.name);
  expect(active()).toEqual(["martin"]);
  const martin = listAccounts()[0];
  observeRateLimit(martin, week(0.6));
  expect(active()).toEqual(["default"]);
  expect(accountStatus().every((a) => a.lastTurnAt === null)).toBe(true);
  markTurn(martin);
  expect(accountStatus().find((a) => a.name === "martin")!.lastTurnAt).not.toBeNull();
});

test("last-known usage survives a restart, marked stale, and still caps", async () => {
  await setup();
  process.env.CLAUDE_ACCOUNT_WEEKLY_CAP = "hinson=90";
  const hinson = listAccounts().find((a) => a.name === "hinson")!;
  observeRateLimit(hinson, week(0.94));
  const live = accountStatus().find((a) => a.name === "hinson")!;
  expect(live.stale).toBe(false);
  // A restart: memory gone, the file stays.
  resetAccountState();
  const restored = accountStatus().find((a) => a.name === "hinson")!;
  expect(restored.stale).toBe(true);
  expect(restored.observedAt).toBe(live.observedAt);
  expect(restored.windows.seven_day?.usedPercent).toBe(94);
  expect(isUnavailable(hinson)).toBe(true);
  // Reported again: fresh.
  observeRateLimit(hinson, week(0.95));
  expect(accountStatus().find((a) => a.name === "hinson")!.stale).toBe(false);
});

test("a restored window that has since reset is dropped", async () => {
  await setup();
  process.env.CLAUDE_ACCOUNT_WEEKLY_CAP = "martin=50";
  const martin = listAccounts().find((a) => a.name === "martin")!;
  observeRateLimit(martin, week(0.9, Date.now() / 1000 + 1));
  resetAccountState();
  await Bun.sleep(1_100);
  expect(isUnavailable(martin)).toBe(false);
  expect(accountStatus().find((a) => a.name === "martin")!.windows).toEqual({});
});

// alex-0230: during a handoff another proxy copy writes the same usage file.
test("another copy's newer report is used for caps and never rolled back", async () => {
  await setup();
  process.env.CLAUDE_ACCOUNT_WEEKLY_CAP = "martin=50";
  const [hinson, martin] = ["hinson", "martin"].map((n) => listAccounts().find((a) => a.name === n)!);
  observeRateLimit(martin, week(0.3));
  expect(isUnavailable(martin)).toBe(false);
  // The other copy saw martin cross its cap a moment later and saved it.
  const file = join(process.env.PROXY_STATE_DIR!, "account-usage.json");
  const onDisk = JSON.parse(await Bun.file(file).text());
  onDisk.martin = { info: week(0.6), at: Date.now() + 5 };
  await Bun.sleep(10);
  await writeFile(file, JSON.stringify(onDisk));
  expect(isUnavailable(martin)).toBe(true);
  // Our next save (another account) keeps it.
  observeRateLimit(hinson, week(0.1));
  const saved = JSON.parse(await Bun.file(file).text());
  expect(saved.martin.info.unifiedWindows.seven_day.utilization).toBe(0.6);
  expect(saved.hinson.info.unifiedWindows.seven_day.utilization).toBe(0.1);
  expect(accountStatus().find((a) => a.name === "martin")!.stale).toBe(false);
});

test("a probe that started before a turn's report does not replace it", async () => {
  await setup();
  const martin = listAccounts().find((a) => a.name === "martin")!;
  const probeStarted = Date.now();
  await Bun.sleep(5);
  observeRateLimit(martin, week(0.4)); // a real turn, during the probe
  observeRateLimit(martin, week(0.2), probeStarted); // the probe lands late
  expect(accountStatus().find((a) => a.name === "martin")!.windows.seven_day?.usedPercent).toBe(40);
});
