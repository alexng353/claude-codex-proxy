import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const linkedAt = new Map<string, number>();
/** Latest `rate_limit_info` Claude reported for each account. */
const lastInfo = new Map<string, { info: RateLimitInfo; at: number }>();

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
  if (!existsSync(root)) return accounts;
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (existsSync(join(dir, ".credentials.json")))
      accounts.push({ name, dir, isDefault: false });
  }
  return accounts;
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

/** First account in order that is not rate limited, or undefined if none. */
export function pickAccount(): Account | undefined {
  const now = Date.now();
  return listAccounts().find((account) => !isLimited(account, now));
}

/** The account to use when all are limited: the one that resets first. */
export function soonestAccount(): Account {
  const accounts = listAccounts();
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
export function observeRateLimit(account: Account, info: RateLimitInfo): void {
  lastInfo.set(account.name, { info, at: Date.now() });
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
  return listAccounts().map((account) => {
    const until = limitedUntil.get(account.name) ?? 0;
    const seen = lastInfo.get(account.name);
    const windows = seen?.info.unifiedWindows ?? {};
    return {
      name: account.name,
      dir: account.dir,
      limitedUntil: until > now ? new Date(until).toISOString() : null,
      observedAt: seen ? new Date(seen.at).toISOString() : null,
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
  const windows = name ? lastInfo.get(name)?.info.unifiedWindows : undefined;
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
  linkedAt.clear();
  lastInfo.clear();
}
