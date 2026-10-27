/**
 * Learn every account's five-hour and weekly usage without spending quota.
 *
 * Real turns report usage through `rate_limit_event`, so an account the proxy
 * has not used lately reads as unknown and the weekly caps cannot hold it
 * back. Claude Code's local `/usage` command reports the same meters with no
 * model turn, so the proxy runs it for each account at start and then on a
 * timer, and feeds the result through `observeRateLimit` like a turn's report.
 * The parsing matches `scripts/limits.ts --probe`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  accountEnv,
  accountStatus,
  listAccounts,
  observeRateLimit,
  type Account,
  type RateLimitInfo,
} from "./accounts";
import { tryLock, unlock } from "./filelock";
import { legacyRunning } from "./handoff";
import { stateDir } from "./sessions";

export type ProbeWindow = { usedPercent: number; resetsAt: string | null };

const DEFAULT_INTERVAL_MS = 12 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;
const STRIPPED_ENV = ["CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

/** Windows from `claude -p /usage --output-format stream-json`, keyed like `rate_limit_event`. */
export function parseUsageReport(text: string): Record<string, ProbeWindow> | undefined {
  for (const line of text.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "assistant" || event.local_command_run?.command !== "usage") continue;
    const limits = event.usage_report?.rate_limits?.limits;
    if (!Array.isArray(limits)) continue;
    const windows: Record<string, ProbeWindow> = {};
    for (const window of limits) {
      if (typeof window?.kind !== "string") continue;
      if (typeof window.percent !== "number" || !Number.isFinite(window.percent) || window.percent < 0) continue;
      const scopes = [window.scope?.model?.display_name, window.scope?.surface?.display_name]
        .filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
      let key = window.kind;
      if (key === "session") key = "five_hour";
      else if (key === "weekly_all") key = "seven_day";
      const name = scopes.length ? `${key} (${scopes.join(", ")})` : key;
      const resets = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
      windows[name] = {
        usedPercent: window.percent,
        resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null,
      };
    }
    if (Object.keys(windows).length) return windows;
  }
  return undefined;
}

/**
 * The probe as a `rate_limit_event` payload. Windows that have already reset
 * are dropped. No status is set: only a real turn's "rejected" may block an
 * account.
 */
export function toRateLimitInfo(
  windows: Record<string, ProbeWindow>,
  now = Date.now(),
): RateLimitInfo | undefined {
  const unifiedWindows: NonNullable<RateLimitInfo["unifiedWindows"]> = {};
  for (const [name, window] of Object.entries(windows)) {
    const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(resetsAtMs) && resetsAtMs <= now) continue;
    unifiedWindows[name] = {
      utilization: window.usedPercent / 100,
      ...(Number.isFinite(resetsAtMs) ? { resetsAt: Math.floor(resetsAtMs / 1000) } : {}),
    };
  }
  return Object.keys(unifiedWindows).length ? { unifiedWindows } : undefined;
}

/**
 * Record a probe taken at `startedAt` unless the account reported newer usage
 * meanwhile (a real turn that finished during the probe wins).
 */
export function applyProbe(
  account: Account,
  windows: Record<string, ProbeWindow>,
  startedAt: number,
  now = Date.now(),
): boolean {
  const info = toRateLimitInfo(windows, now);
  if (!info) return false;
  const seen = accountStatus().find((status) => status.name === account.name)?.observedAt;
  if (seen && Date.parse(seen) > startedAt) return false;
  observeRateLimit(account, info, startedAt);
  return true;
}

type RunResult = { text: string; code: number | null; timedOut: boolean };

async function runClaude(account: Account, args: string[], timeoutMs: number): Promise<RunResult> {
  const env = { ...process.env, ...accountEnv(account) } as Record<string, string>;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn([process.env.CLAUDE_BIN ?? "claude", ...args], {
    env,
    cwd: "/tmp",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // CLI helpers can hold the pipe open after their parent dies.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { text, code, timedOut };
  } catch {
    return { text: "", code: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

let usageSupported: boolean | undefined;

/** Older CLIs may send an unknown slash command to the model, which would spend quota. */
async function supportsUsage(account: Account): Promise<boolean> {
  if (usageSupported) return true;
  const result = await runClaude(account, ["--version"], 5000);
  const match = result.text.match(/^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/);
  if (result.timedOut || result.code !== 0 || !match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  usageSupported = major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 282)));
  return usageSupported;
}

export type ProbeOutcome = { account: string; result: "applied" | "newer data" | "unavailable" };

/** Probe one account and record what it reports. */
export async function probeAccount(account: Account): Promise<ProbeOutcome> {
  if (!(await supportsUsage(account))) return { account: account.name, result: "unavailable" };
  const startedAt = Date.now();
  const result = await runClaude(
    account,
    ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--safe-mode", "--tools", "", "--strict-mcp-config"],
    PROBE_TIMEOUT_MS,
  );
  const windows = !result.timedOut && result.code === 0 ? parseUsageReport(result.text) : undefined;
  if (!windows) return { account: account.name, result: "unavailable" };
  return { account: account.name, result: applyProbe(account, windows, startedAt) ? "applied" : "newer data" };
}

let running: Promise<ProbeOutcome[]> | undefined;
/** Set once this copy drains: a running batch probes no further accounts. */
let stopping = false;

/** Held while a batch runs, so two copies (during a handoff) never probe at once. */
function leasePath(): string {
  return join(stateDir(), "usage-probe.lock");
}

/**
 * Probe every account, one at a time so CLI token refreshes never overlap, in this
 * copy or another (alex-0230). Probes nothing while another copy's batch runs.
 */
export function probeAllAccounts(): Promise<ProbeOutcome[]> {
  // The body starts on a later tick, so its cleanup (running = undefined) always
  // runs after this assignment, even when it returns at once (alex-0230 N4).
  running ??= Promise.resolve().then(async () => {
    const outcomes: ProbeOutcome[] = [];
    let leased = false;
    try {
      mkdirSync(stateDir(), { recursive: true });
      leased = tryLock(leasePath()).held;
      if (!leased) return outcomes;
      for (const account of listAccounts()) {
        if (stopping) break;
        try {
          outcomes.push(await probeAccount(account));
        } catch {
          outcomes.push({ account: account.name, result: "unavailable" });
        }
      }
    } finally {
      if (leased) unlock(leasePath());
      running = undefined;
    }
    return outcomes;
  });
  return running;
}

/**
 * Probe shortly after start, then every `USAGE_PROBE_INTERVAL_MS` (default 12
 * minutes). `USAGE_PROBE_DISABLE=1` turns it off. Returns a stop function.
 */
export function startUsageProbe(
  env: Record<string, string | undefined> = process.env,
): () => Promise<unknown> {
  if (env.USAGE_PROBE_DISABLE === "1") return async () => {};
  const number = (value: string | undefined, fallback: number) =>
    value && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  const intervalMs = Math.max(60_000, number(env.USAGE_PROBE_INTERVAL_MS, DEFAULT_INTERVAL_MS));
  const initialDelayMs = number(env.USAGE_PROBE_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = async () => {
    // The old copy (first move) probes without the lease: wait until it is gone.
    if (legacyRunning(env)) {
      if (!stopped) schedule(30_000);
      return;
    }
    const outcomes = await probeAllAccounts().catch(() => []);
    if (outcomes.length)
      console.log(`Usage probe: ${outcomes.map((o) => `${o.account} ${o.result}`).join(", ")}`);
    if (!stopped) schedule(intervalMs);
  };
  const schedule = (delay: number) => {
    timer = setTimeout(() => void tick(), delay);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule(initialDelayMs);
  // Stops the timer and any batch after its current account; resolves once that
  // account's probe (and its token refresh) has finished.
  return () => {
    stopped = true;
    stopping = true;
    if (timer) clearTimeout(timer);
    return running ?? Promise.resolve();
  };
}

/** For tests. */
export function resetUsageProbe(): void {
  usageSupported = undefined;
  running = undefined;
  stopping = false;
}
