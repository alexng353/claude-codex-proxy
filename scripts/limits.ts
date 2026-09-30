#!/usr/bin/env bun
/**
 * Show each Claude account's five-hour and weekly usage.
 *
 * Reads what the running proxy last saw, otherwise Claude Code's local /usage
 * command. --probe refreshes every account. No model turn is needed.
 * --record appends each account's row to limits-history.jsonl so a timer can
 * build a continuous history, including idle accounts the proxy never sees.
 * --quiet suppresses the display.
 */
import { listAccounts, type Account } from "../src/accounts";
import { stateDir } from "../src/sessions";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Window = { usedPercent: number; resetsAt: string | null; observedAt?: string | null };
type Row = {
  name: string;
  limitedUntil?: string | null;
  observedAt?: string | null;
  windows: Record<string, Window>;
  source: string;
};

const probeAll = process.argv.includes("--probe");
const record = process.argv.includes("--record");
const quiet = process.argv.includes("--quiet");
const proxyUrl = `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3456}`;
const claude = process.env.CLAUDE_BIN ?? "claude";
const CACHE_MS = 5 * 60_000;
type Child = { pid: number; kill(signal: "SIGKILL"): void };
const activeChildren = new Set<Child>();
let usageSupport: Promise<boolean> | undefined;

function supportsUsage(account: Account): Promise<boolean> {
  return usageSupport ??= runClaude(account, ["--version"], 5000).then((result) => {
    const match = result.text.match(/^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/);
    if (result.timedOut || result.code !== 0 || !match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    // Older CLIs may send an unknown slash command to the model.
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 282)));
  }).catch(() => false);
}

function kill(child: Child): void {
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
  }
  child.kill("SIGKILL");
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    for (const child of activeChildren) kill(child);
    process.exit(code);
  });
}

function cachePath(account: Account): string {
  return join(stateDir(), "limits-cache", `${encodeURIComponent(account.name)}.json`);
}

function crossedReset(row: Row): boolean {
  const at = Date.parse(row.observedAt ?? "");
  const resets = [row.limitedUntil, ...Object.values(row.windows).map((w) => w.resetsAt)];
  return resets.some((reset) => !!reset && Date.parse(reset) > at && Date.parse(reset) <= Date.now());
}

function supplement(live: Row, cached: Row): Row {
  const missing = Object.entries(cached.windows).filter(([name]) => !(name in live.windows));
  if (!missing.length) return live;
  return {
    ...live,
    source: "proxy + cache",
    windows: {
      ...live.windows,
      ...Object.fromEntries(missing.map(([name, window]) => [name, { ...window, observedAt: cached.observedAt }])),
    },
  };
}

function fromCache(account: Account, label: string): Row | undefined {
  if (label === "unknown" || label === "not logged in") return;
  try {
    const cached = JSON.parse(readFileSync(cachePath(account), "utf8"));
    if (cached.dir !== account.dir || cached.email !== label) return;
    const row: Row = cached.row;
    const at = Date.parse(row.observedAt ?? "");
    const age = Date.now() - at;
    if (!Number.isFinite(age) || age < 0 || age >= CACHE_MS) return;
    if (!row.windows || Object.keys(row.windows).length === 0) return;
    // Don't carry a pre-reset utilization into a new quota window.
    if (crossedReset(row)) return;
    return { ...row, source: "cache" };
  } catch { return; }
}

function saveCache(account: Account, label: string, row: Row): void {
  if (!Object.keys(row.windows).length || label === "unknown" || label === "not logged in") return;
  const path = cachePath(account);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(join(stateDir(), "limits-cache"), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ dir: account.dir, email: label, row }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // A read-only state directory should still allow a live limits query.
  } finally {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

async function runClaude(account: Account, args: string[], timeoutMs: number) {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[key];
  if (!account.isDefault) env.CLAUDE_CONFIG_DIR = account.dir;
  const child = Bun.spawn([claude, ...args], {
    env, cwd: "/tmp", stdout: "pipe", stderr: "ignore", stdin: "ignore",
    detached: process.platform !== "win32",
  });
  activeChildren.add(child);
  const stdout = child.stdout.getReader();
  async function read() {
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await stdout.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { stdout.releaseLock(); }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stdout.cancel().catch(() => {});
    // CLI helpers can hold the pipes open after their parent dies.
    kill(child);
  }, timeoutMs);
  try {
    const [text, code] = await Promise.all([
      read(), child.exited,
    ]);
    return { text, code, timedOut };
  } finally {
    clearTimeout(timer);
    activeChildren.delete(child);
  }
}

async function fromProxy(): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  try {
    const headers: Record<string, string> = {};
    if (process.env.PROXY_API_KEY)
      headers.authorization = `Bearer ${process.env.PROXY_API_KEY}`;
    const response = await fetch(`${proxyUrl}/accounts`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return rows;
    const body = (await response.json()) as { accounts: Row[] };
    for (const row of body.accounts)
      if (Object.keys(row.windows ?? {}).length > 0 || (row.limitedUntil && Date.parse(row.limitedUntil) > Date.now()))
        rows.set(row.name, { ...row, windows: row.windows ?? {}, source: "proxy" });
  } catch {}
  return rows;
}

async function probe(account: Account): Promise<Row> {
  if (!await supportsUsage(account)) return {
    name: account.name, windows: {}, source: "usage unavailable (requires Claude Code 2.1.282+)",
  };
  let text: string;
  try {
    const result = await runClaude(account,
      ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--safe-mode", "--tools", "", "--strict-mcp-config"], 15_000);
    if (result.timedOut) return { name: account.name, windows: {}, source: "usage timed out" };
    if (result.code !== 0) return { name: account.name, windows: {}, source: "usage unavailable" };
    text = result.text;
  } catch { return { name: account.name, windows: {}, source: "usage unavailable" }; }
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "assistant" || event.local_command_run?.command !== "usage") continue;
      const info = event.usage_report?.rate_limits;
      if (!Array.isArray(info?.limits)) continue;
      const windows: Record<string, Window> = {};
      for (const window of info.limits) {
        if (typeof window.kind !== "string" || typeof window.percent !== "number" || !Number.isFinite(window.percent) || window.percent < 0) continue;
        const scopes = [window.scope?.model?.display_name, window.scope?.surface?.display_name]
          .filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
        let key = window.kind;
        if (key === "session") key = "five_hour";
        else if (key === "weekly_all") key = "seven_day";
        const name = scopes.length ? `${key} (${scopes.join(", ")})` : key;
        windows[name] = {
          usedPercent: window.percent,
          resetsAt: typeof window.resets_at === "string" && Number.isFinite(Date.parse(window.resets_at))
            ? new Date(window.resets_at).toISOString() : null,
        };
      }
      if (!Object.keys(windows).length) continue;
      return {
        name: account.name,
        limitedUntil: null,
        windows,
        source: "usage",
        observedAt: new Date().toISOString(),
      };
    } catch {}
  }
  return { name: account.name, windows: {}, source: "usage unavailable (requires structured /usage support)" };
}

function bar(percent: number): string {
  const filled = Math.round(Math.min(100, percent) / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function resetIn(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const when = new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const span = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return `resets in ${span} (${when})`;
}

async function email(account: Account): Promise<string> {
  try {
    const result = await runClaude(account, ["auth", "status"], 5000);
    if (result.timedOut || result.code !== 0) return "unknown";
    const status = JSON.parse(result.text);
    return status.loggedIn ? status.email ?? "unknown" : "not logged in";
  } catch {
    return "unknown";
  }
}

const proxyRows = await fromProxy();
const accounts = listAccounts();
const emails = await Promise.all(accounts.map(email));
const rows = await Promise.all(
  accounts.map(async (account, index) => {
    const cached = probeAll ? undefined : fromCache(account, emails[index]);
    const observed = proxyRows.get(account.name);
    const live = !probeAll && observed && !crossedReset(observed) ? observed : undefined;
    let row: Row;
    if (cached && (!live?.observedAt || Date.parse(cached.observedAt!) > Date.parse(live.observedAt))) row = cached;
    else if (live && cached) row = supplement(live, cached);
    else {
      // Proxy turn headers omit model-specific weekly meters; /usage fills them.
      const refreshed = await probe(account);
      saveCache(account, emails[index], refreshed);
      row = Object.keys(refreshed.windows).length ? refreshed : live ?? refreshed;
    }
    // A meter refresh cannot establish that an explicit rejection has cleared.
    if (observed?.limitedUntil && Date.parse(observed.limitedUntil) > Date.now()) {
      row = { ...row, limitedUntil: observed.limitedUntil,
        source: row.source.includes("proxy") ? row.source : `${row.source} + proxy` };
    }
    return row;
  }),
);

const labels: Record<string, string> = { five_hour: "5-hour", seven_day: "weekly" };

if (record) {
  const recordedAt = new Date().toISOString();
  const lines = rows.map((row, index) => JSON.stringify({
    recordedAt, account: row.name, email: emails[index], source: row.source,
    observedAt: row.observedAt ?? null, limitedUntil: row.limitedUntil ?? null, windows: row.windows,
  }));
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  // One write keeps a sample's accounts together if two recorders overlap.
  appendFileSync(join(stateDir(), "limits-history.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

if (!quiet) rows.forEach((row, index) => {
  const limited = row.limitedUntil ? `  LIMITED until ${new Date(row.limitedUntil).toLocaleString()}` : "";
  const age = row.observedAt
    ? `, seen ${Math.round((Date.now() - Date.parse(row.observedAt)) / 60_000)}m ago`
    : "";
  console.log(`${row.name}  ${emails[index]}  [${row.source}${age}]${limited}`);
  for (const [name, window] of Object.entries(row.windows)) {
    const label = (labels[name] ?? name).padEnd(7);
    const percent = `${window.usedPercent}%`.padStart(6);
    const cachedAge = window.observedAt
      ? `  (cache, seen ${Math.round((Date.now() - Date.parse(window.observedAt)) / 60_000)}m ago)` : "";
    console.log(`  ${label} ${bar(window.usedPercent)} ${percent}  ${resetIn(window.resetsAt)}${cachedAge}`);
  }
});
