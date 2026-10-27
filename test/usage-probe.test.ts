import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountStatus, listAccounts, observeRateLimit, resetAccountState } from "../src/accounts";
import {
  applyProbe,
  parseUsageReport,
  probeAllAccounts,
  resetUsageProbe,
  startUsageProbe,
  toRateLimitInfo,
} from "../src/usage-probe";

const KEYS = ["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR", "CLAUDE_ACCOUNT_ORDER"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let root = "";

const HOUR = 3_600_000;
const report = (limits: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    local_command_run: { command: "usage", args: "" },
    usage_report: { rate_limits: { limits } },
  });

async function fakeCli(version = "2.1.285") {
  const cli = join(root, "claude");
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("${version} (Claude Code)"); process.exit(0); }
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({ args: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
const weekly = process.env.CLAUDE_CONFIG_DIR?.endsWith("/second") ? 100 : 95;
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(JSON.stringify({ type: "assistant", local_command_run: { command: "usage", args: "" }, usage_report: { rate_limits: { limits: [
  { kind: "session", percent: 7, resets_at: new Date(Date.now() + ${HOUR}).toISOString() },
  { kind: "weekly_all", percent: weekly, resets_at: new Date(Date.now() + ${48 * HOUR}).toISOString() },
] } } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
`,
  );
  await chmod(cli, 0o755);
  process.env.CLAUDE_BIN = cli;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "usage-probe-"));
});
afterAll(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(join(root, "state"), { recursive: true, force: true });
  await rm(join(root, "calls"), { force: true });
  await mkdir(join(root, "base"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  process.env.PROXY_STATE_DIR = join(root, "state");
  delete process.env.CLAUDE_ACCOUNT_ORDER;
  resetAccountState();
  resetUsageProbe();
});
afterEach(() => {
  resetAccountState();
  resetUsageProbe();
});

test("parses /usage into rate_limit_event window names", () => {
  const resets = new Date(Date.now() + HOUR).toISOString();
  const text = [
    "not json",
    JSON.stringify({ type: "assistant", message: {} }),
    report([
      { kind: "session", percent: 42, resets_at: resets },
      { kind: "weekly_all", percent: 95.5, resets_at: null },
      { kind: "weekly_scoped", percent: 3, resets_at: "garbage", scope: { model: { display_name: "Fable" } } },
      { kind: "broken", percent: -1 },
      { percent: 5 },
    ]),
  ].join("\n");
  expect(parseUsageReport(text)).toEqual({
    five_hour: { usedPercent: 42, resetsAt: resets },
    seven_day: { usedPercent: 95.5, resetsAt: null },
    "weekly_scoped (Fable)": { usedPercent: 3, resetsAt: null },
  });
  expect(parseUsageReport(JSON.stringify({ type: "result", is_error: true }))).toBeUndefined();
});

test("converts to utilization and drops windows that already reset", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  expect(
    toRateLimitInfo(
      {
        five_hour: { usedPercent: 50, resetsAt: "2026-10-26T11:00:00Z" },
        seven_day: { usedPercent: 95, resetsAt: "2026-10-28T12:00:00Z" },
        other: { usedPercent: 10, resetsAt: null },
      },
      now,
    ),
  ).toEqual({
    unifiedWindows: {
      seven_day: { utilization: 0.95, resetsAt: Date.parse("2026-10-28T12:00:00Z") / 1000 },
      other: { utilization: 0.1 },
    },
  });
  expect(toRateLimitInfo({ five_hour: { usedPercent: 1, resetsAt: "2026-10-26T11:00:00Z" } }, now)).toBeUndefined();
});

test("a probe fills an unknown account; a turn reported during the probe wins", () => {
  const [account] = listAccounts();
  // Whole seconds: the proxy stores resets as epoch seconds.
  const resetsAt = new Date(Math.floor((Date.now() + 48 * HOUR) / 1000) * 1000).toISOString();
  const startedAt = Date.now() - 1000;
  expect(applyProbe(account, { seven_day: { usedPercent: 95, resetsAt } }, startedAt)).toBe(true);
  let status = accountStatus().find((row) => row.name === account.name)!;
  expect(status.windows.seven_day).toEqual({ usedPercent: 95, resetsAt });
  expect(status.limitedUntil).toBeNull();

  // A real turn lands after this second probe started, so the probe is older.
  const probeStart = Date.now() - 1;
  observeRateLimit(account, { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.97 } } });
  expect(applyProbe(account, { seven_day: { usedPercent: 50, resetsAt } }, probeStart - 1000)).toBe(false);
  status = accountStatus().find((row) => row.name === account.name)!;
  expect(status.windows.seven_day.usedPercent).toBe(97);

  // A probe that started after the turn replaces it.
  expect(applyProbe(account, { seven_day: { usedPercent: 98, resetsAt } }, Date.now() + 1)).toBe(true);
  expect(accountStatus().find((row) => row.name === account.name)!.windows.seven_day.usedPercent).toBe(98);
});

test("probes every account in order through its own config dir", async () => {
  await fakeCli();
  const second = join(root, "state", "accounts", "second");
  await mkdir(second, { recursive: true });
  await writeFile(join(second, ".credentials.json"), "{}");
  const outcomes = await probeAllAccounts();
  expect(outcomes).toEqual([
    { account: "default", result: "applied" },
    { account: "second", result: "applied" },
  ]);
  const calls = (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.map((call) => call.dir)).toEqual([join(root, "base"), second]);
  for (const call of calls) {
    expect(call.args).toContain("/usage");
    expect(call.args).toContain("--no-session-persistence");
    expect(call.args).not.toContain("--model");
  }
  const weekly = Object.fromEntries(accountStatus().map((row) => [row.name, row.windows.seven_day?.usedPercent]));
  expect(weekly).toEqual({ default: 95, second: 100 });
  expect(accountStatus().every((row) => row.windows.five_hour?.usedPercent === 7)).toBe(true);
});

test("an old CLI is never sent /usage", async () => {
  await fakeCli("2.1.100");
  expect(await probeAllAccounts()).toEqual([{ account: "default", result: "unavailable" }]);
  expect(existsSync(join(root, "calls"))).toBe(false);
  expect(accountStatus()[0].windows).toEqual({});
});

test("the timer probes once at start and can be disabled", async () => {
  await fakeCli();
  startUsageProbe({ USAGE_PROBE_DISABLE: "1", USAGE_PROBE_INITIAL_DELAY_MS: "0" })();
  await Bun.sleep(300);
  expect(existsSync(join(root, "calls"))).toBe(false);
  const stop = startUsageProbe({ USAGE_PROBE_INITIAL_DELAY_MS: "0" });
  for (let i = 0; i < 50 && !accountStatus()[0].observedAt; i++) await Bun.sleep(50);
  stop();
  expect(accountStatus()[0].windows.seven_day?.usedPercent).toBe(95);
});

// alex-0230: two proxy copies during a handoff share one probe lease.
test("a batch skipped for another copy's lease does not stop later probes", async () => {
  await fakeCli();
  await mkdir(join(root, "state"), { recursive: true });
  const lease = join(root, "state", "usage-probe.lock");
  const other = Bun.spawn(["flock", "-o", lease, "sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  await Bun.sleep(150);
  expect(await probeAllAccounts()).toEqual([]);
  other.kill("SIGKILL");
  await other.exited;
  expect(await probeAllAccounts()).toEqual([{ account: "default", result: "applied" }]);
});
