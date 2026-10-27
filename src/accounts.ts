import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withLock } from "./filelock";
import { stateDir } from "./sessions";

/**
 * Claude subscription accounts the proxy can spread work across.
 *
 * The default account is whatever `claude login` wrote to the base config
 * directory. Each extra account is a directory under
 * `<state>/accounts/<name>` holding its own `.credentials.json` and
 * `.claude.json`; every other entry is a symlink into the base directory.
 * Sharing `projects/` is what lets a conversation resume its transcript on
 * another account after a switch.
 */
export type Account = { name: string; dir: string; isDefault: boolean };

/** Per-account files; everything else is shared with the base directory. */
const PRIVATE_ENTRIES = [".credentials.json", ".claude.json"];
const FALLBACK_LIMIT_MS = 15 * 60_000;

const limitedUntil = new Map<string, number>();
const authFailedUntil = new Map<string, number>();
/** When each account last started a turn in this process (`/accounts` lastTurnAt). */
const lastTurn = new Map<string, number>();

export function markTurn(account: Account): void {
  lastTurn.set(account.name, Date.now());
}
const failedCredentials = new Map<string, string>();
const linkedAt = new Map<string, number>();
/**
 * Latest `rate_limit_info` Claude reported for each account. `stale` marks one
 * restored from disk after a restart and not reported again since.
 */
const lastInfo = new Map<string, { info: RateLimitInfo; at: number; stale?: boolean }>();
/** The usage file `lastInfo` last synced from, and that file's mtime then (alex-0217, 0230). */
let restoredFrom: string | undefined;
let restoredMtime = -1;
/** Reports older than this copy are from before its start: shown as stale. */
let startedAt = Date.now();

function usageFile(): string {
  return join(stateDir(), "account-usage.json");
}

type SavedUsage = Record<string, { info?: RateLimitInfo; at?: number }>;

/** Take every account report on disk that is newer than ours. */
function adopt(saved: SavedUsage): void {
  for (const [name, entry] of Object.entries(saved ?? {})) {
    if (!entry?.info || typeof entry.at !== "number") continue;
    const mine = lastInfo.get(name);
    if (mine && mine.at >= entry.at) continue;
    lastInfo.set(name, { info: entry.info, at: entry.at, stale: entry.at < startedAt });
  }
}

/**
 * Load the last-known usage, so percentages and the weekly cap survive a restart
 * instead of reading as unknown until each account is used. Re-read whenever the
 * file changes: during a handoff the other copy may have seen a newer report, and
 * routing and caps must use it (alex-0230).
 */
function restoreUsage(): void {
  const file = usageFile();
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    restoredFrom = file;
    return;
  }
  if (restoredFrom === file && restoredMtime === mtime) return;
  try {
    adopt(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return; // mid-replace or damaged: try again next time
  }
  restoredFrom = file;
  restoredMtime = mtime;
}

function saveUsage(): void {
  const file = usageFile();
  const next = `${file}.${process.pid}.next`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    // Two copies run at once during a handoff (alex-0230). Read, merge and replace
    // under one cross-process lock, newest report per account winning, so neither
    // copy rolls the other's fresher numbers back.
    withLock(`${file}.lock`, () => {
      let onDisk: SavedUsage = {};
      try {
        onDisk = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      adopt(onDisk);
      const data: Record<string, { info: RateLimitInfo; at: number }> = {};
      for (const [name, { info, at }] of lastInfo) data[name] = { info, at };
      writeFileSync(next, JSON.stringify(data));
      renameSync(next, file);
      restoredFrom = file;
      restoredMtime = statSync(file).mtimeMs;
    });
  } catch (error) {
    console.error("Unable to save Claude account usage:", (error as Error).message);
  }
}

/** An account's last report, with windows that have since reset dropped. */
function seenInfo(name: string, now = Date.now()) {
  restoreUsage();
  const seen = lastInfo.get(name);
  if (!seen) return undefined;
  const windows = Object.fromEntries(
    Object.entries(seen.info.unifiedWindows ?? {}).filter(
      ([, window]) => !(window?.resetsAt && window.resetsAt * 1000 <= now),
    ),
  );
  return { ...seen, info: { ...seen.info, unifiedWindows: windows } };
}

export function baseConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function accountsDir(): string {
  return join(stateDir(), "accounts");
}

export function listAccounts(): Account[] {
  const accounts: Account[] = [
    { name: "default", dir: baseConfigDir(), isDefault: true },
  ];
  const root = accountsDir();
  if (!existsSync(root)) return orderAccounts(accounts);
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (existsSync(join(dir, ".credentials.json")))
      accounts.push({ name, dir, isDefault: false });
  }
  return orderAccounts(accounts);
}

/**
 * `CLAUDE_ACCOUNT_ORDER` (e.g. `martin,default`) puts the named accounts first,
 * in that order; unnamed accounts follow in their usual order.
 */
function orderAccounts(accounts: Account[]): Account[] {
  const order = (process.env.CLAUDE_ACCOUNT_ORDER ?? "")
    .split(",").map((name) => name.trim()).filter(Boolean);
  if (!order.length) return accounts;
  const rank = (account: Account) => {
    const index = order.indexOf(account.name);
    return index < 0 ? order.length : index;
  };
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
    .map(({ account }) => account);
}

/** `CLAUDE_ACCOUNT_WEEKLY_CAP` (e.g. `martin=50`): seven-day percent at which an account stops taking turns. */
function weeklyCap(name: string): number | undefined {
  for (const part of (process.env.CLAUDE_ACCOUNT_WEEKLY_CAP ?? "").split(",")) {
    const [key, value] = part.split("=").map((item) => item.trim());
    if (key === name && value && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/** True once the account's last reported seven-day usage reaches its configured cap. */
export function isOverWeeklyCap(account: Account, now = Date.now()): boolean {
  const cap = weeklyCap(account.name);
  if (cap === undefined) return false;
  const window = seenInfo(account.name, now)?.info.unifiedWindows?.seven_day;
  if (window?.utilization === undefined) return false;
  if (window.resetsAt && window.resetsAt * 1000 <= now) return false;
  return window.utilization * 100 >= cap;
}

function isPrivate(entry: string): boolean {
  return PRIVATE_ENTRIES.some(
    (name) => entry === name || entry.startsWith(`${name}.`),
  );
}

/** Link new shared entries from the base directory; never replace real files. */
export function linkSharedEntries(dir: string): void {
  const base = baseConfigDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(base, "projects"), { recursive: true });
  for (const entry of readdirSync(base)) {
    if (isPrivate(entry)) continue;
    const link = join(dir, entry);
    try {
      lstatSync(link);
      continue;
    } catch {}
    symlinkSync(join(base, entry), link);
  }
}

/** Environment overrides for a worker spawned on this account. */
export function accountEnv(account: Account): Record<string, string> {
  if (account.isDefault) return {};
  // Re-link occasionally so entries created later in the base dir appear.
  if (Date.now() - (linkedAt.get(account.dir) ?? 0) > 60_000) {
    try {
      linkSharedEntries(account.dir);
      linkedAt.set(account.dir, Date.now());
    } catch (error) {
      console.error(
        `Unable to link shared Claude config for ${account.name}:`,
        (error as Error).message,
      );
    }
  }
  return { CLAUDE_CONFIG_DIR: account.dir };
}

export function isLimited(account: Account, now = Date.now()): boolean {
  return (limitedUntil.get(account.name) ?? 0) > now;
}

function credentialVersion(account: Account): string {
  try {
    const stat = statSync(join(account.dir, ".credentials.json"));
    return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return "missing"; }
}

function isAuthBlocked(account: Account, now: number): boolean {
  if ((authFailedUntil.get(account.name) ?? 0) <= now) return false;
  if (credentialVersion(account) === failedCredentials.get(account.name)) return true;
  authFailedUntil.delete(account.name);
  failedCredentials.delete(account.name);
  return false;
}

export function isUnavailable(account: Account, now = Date.now()): boolean {
  return isAuthBlocked(account, now) || isLimited(account, now) || isOverWeeklyCap(account, now);
}

/** Authentication can recover after a CLI refresh or a new login. */
export function markAuthFailed(account: Account): void {
  authFailedUntil.set(account.name, Date.now() + FALLBACK_LIMIT_MS);
  failedCredentials.set(account.name, credentialVersion(account));
  console.error(`Claude account ${account.name} authentication failed; skipping for 15 minutes`);
}

export function isAuthError(status: unknown, text: string | undefined): boolean {
  return status === 401 || /(?:API Error:\s*401\b|failed to authenticate|authentication failed on every account|OAuth (?:access )?token (?:has expired|is invalid)|invalid authentication credentials|not logged in[.\s].*login)/i.test(text ?? "");
}

/** First account in order that can serve a request, or undefined if none. */
export function pickAccount(): Account | undefined {
  const now = Date.now();
  return listAccounts().find((account) => !isUnavailable(account, now));
}

/** The account to use when all are limited: the one that resets first. */
export function soonestAccount(): Account {
  const now = Date.now();
  const accounts = listAccounts().filter((account) => !isAuthBlocked(account, now));
  if (!accounts.length) throw new Error("No Claude accounts available: authentication failed on every account");
  return accounts.reduce((best, account) =>
    (limitedUntil.get(account.name) ?? 0) < (limitedUntil.get(best.name) ?? 0)
      ? account
      : best,
  );
}

export function markLimited(account: Account, resetsAtMs?: number): void {
  // The following error result often has no reset; retain the stream event's reset.
  if (resetsAtMs === undefined && isLimited(account)) return;
  const until =
    resetsAtMs && resetsAtMs > Date.now()
      ? resetsAtMs
      : Date.now() + FALLBACK_LIMIT_MS;
  if ((limitedUntil.get(account.name) ?? 0) >= until) return;
  limitedUntil.set(account.name, until);
  console.error(
    `Claude account ${account.name} is rate limited until ${new Date(until).toISOString()}`,
  );
}

type UsageWindow = { utilization?: number; resetsAt?: number };
export type RateLimitInfo = {
  status?: string;
  resetsAt?: number;
  unifiedWindows?: Record<string, UsageWindow | undefined>;
};

/** Apply a stream-json `rate_limit_event`; only "rejected" blocks the account. */
export function observeRateLimit(account: Account, info: RateLimitInfo, at = Date.now()): void {
  restoreUsage();
  const mine = lastInfo.get(account.name);
  // A probe passes the time it started: a turn that reported after that is newer.
  if (!mine || mine.at <= at) {
    lastInfo.set(account.name, { info, at });
    saveUsage();
  }
  if (info.status !== "rejected") return;
  markLimited(
    account,
    typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined,
  );
}

const LIMIT_TEXT =
  /(usage limit|rate limit|hit your limit|limit reached|out of extra usage)/i;

export function isLimitError(status: unknown, text: string | undefined): boolean {
  return status === 429 || LIMIT_TEXT.test(text ?? "");
}

export function accountStatus() {
  const now = Date.now();
  // The account a new unpinned turn takes now (the window's green dot, alex-0234):
  // the same choice the turn makes, not the configured order.
  let active: string | undefined;
  try {
    active = (pickAccount() ?? soonestAccount()).name;
  } catch {
    active = undefined;
  }
  return listAccounts().map((account) => {
    isAuthBlocked(account, now);
    const until = limitedUntil.get(account.name) ?? 0;
    const seen = seenInfo(account.name, now);
    const authUntil = authFailedUntil.get(account.name) ?? 0;
    const windows = seen?.info.unifiedWindows ?? {};
    const served = lastTurn.get(account.name);
    return {
      name: account.name,
      dir: account.dir,
      active: account.name === active,
      lastTurnAt: served ? new Date(served).toISOString() : null,
      limitedUntil: until > now ? new Date(until).toISOString() : null,
      authFailedUntil: authUntil > now ? new Date(authUntil).toISOString() : null,
      observedAt: seen ? new Date(seen.at).toISOString() : null,
      // Restored from before a restart, not reported again since (alex-0217).
      stale: seen?.stale === true,
      windows: Object.fromEntries(
        Object.entries(windows).map(([name, window]) => [
          name,
          {
            usedPercent: Math.round((window?.utilization ?? 0) * 1000) / 10,
            resetsAt: window?.resetsAt
              ? new Date(window.resetsAt * 1000).toISOString()
              : null,
          },
        ]),
      ),
    };
  });
}

const WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
};

/**
 * Codex rate-limit headers for an account, so Codex's own usage display shows
 * the Claude account's five-hour (primary) and weekly (secondary) windows.
 */
export function usageHeaders(name: string | undefined): Record<string, string> {
  const windows = name ? seenInfo(name)?.info.unifiedWindows : undefined;
  if (!windows) return {};
  const headers: Record<string, string> = {
    "x-codex-limit-name": `Claude (${name})`,
  };
  for (const [slot, key] of [
    ["primary", "five_hour"],
    ["secondary", "seven_day"],
  ] as const) {
    const window = windows[key];
    if (!window) continue;
    headers[`x-codex-${slot}-used-percent`] = String(
      Math.round((window.utilization ?? 0) * 1000) / 10,
    );
    headers[`x-codex-${slot}-window-minutes`] = String(WINDOW_MINUTES[key]);
    if (window.resetsAt)
      headers[`x-codex-${slot}-reset-at`] = String(window.resetsAt);
  }
  return headers;
}

/** For tests. */
export function resetAccountState(): void {
  limitedUntil.clear();
  authFailedUntil.clear();
  failedCredentials.clear();
  linkedAt.clear();
  lastInfo.clear();
  lastTurn.clear();
  restoredFrom = undefined;
  restoredMtime = -1;
  // A restart: every report already on disk is from before it.
  startedAt = Date.now() + 1;
}
