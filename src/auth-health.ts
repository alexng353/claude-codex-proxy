import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { listAccounts, type Account } from "./accounts";
import { tryLock, unlock, withLock } from "./filelock";
import { stateDir } from "./sessions";

type FailureIncident = { id: string; since: string; delivered?: boolean };
type ExpiryIncident = FailureIncident & { expiresAt: number };
type Delivery = { at: number; credentials: string | undefined };
type Health = { name: string; dir: string; failure?: FailureIncident; expiry?: ExpiryIncident; lastSent?: Delivery };
type State = Record<string, Health>;
export type WarningSender = (message: string, incidentId: string) => Promise<boolean>;
const THREE_DAYS = 3 * 86400_000;
const SIX_HOURS = 6 * 3600_000;
const REFRESH_BUFFER = 5 * 60_000;
const key = (account: Pick<Account, "name" | "dir">) => JSON.stringify([account.name, account.dir]);
function path() { return join(stateDir(), "account-auth.json"); }
function read(): State {
  try {
    const saved = JSON.parse(readFileSync(path(), "utf8"));
    // Preserve incidents created by the first version, before keys included dirs.
    return Object.fromEntries(Object.entries(saved).map(([oldKey, value]) => {
      const health = value as Health;
      const name = health.name ?? oldKey;
      return [key({ name, dir: health.dir }), { ...health, name }];
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error; // Never reset dedupe after an unreadable/corrupt state file.
  }
}
function update<T>(fn: (state: State) => T): T {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  return withLock(`${path()}.lock`, () => {
    const state = read();
    const before = JSON.stringify(state);
    const result = fn(state);
    const after = JSON.stringify(state);
    if (before !== after) {
      const next = `${path()}.${process.pid}.next`;
      writeFileSync(next, after, { mode: 0o600 });
      renameSync(next, path());
    }
    return result;
  }, 2000, false);
}
function safely(fn: () => void): void {
  try { fn(); } catch { console.error("Unable to update account authentication state"); }
}
function entry(state: State, account: Account): Health {
  return state[key(account)] ??= { name: account.name, dir: account.dir };
}
function get(account: Account): Health | undefined {
  try { return read()[key(account)]; } catch { return undefined; }
}
export function recordAuthFailure(account: Account): void {
  safely(() => update((state) => {
    entry(state, account).failure ??= { id: crypto.randomUUID(), since: new Date().toISOString() };
  }));
}
export function authIncidentId(account: Account): string | undefined {
  return get(account)?.failure?.id;
}
/** Compare and clear under the state lock: an older success cannot clear a new incident. */
export function clearAuthIncident(account: Account, observedId: string | undefined): boolean {
  try {
    return update((state) => {
      const health = state[key(account)];
      if (health?.failure?.id !== observedId) return false;
      if (health) delete health.failure;
      return true;
    });
  } catch { console.error("Unable to clear account authentication state"); return false; }
}

const timestamp = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 8.64e15 ? v : null;
function readCredentials(account: Account) {
  let text: string;
  try { text = readFileSync(join(account.dir, ".credentials.json"), "utf8"); }
  catch (error) {
    return { version: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : undefined,
      state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "failed" as const : "unknown" as const };
  }
  const version = createHash("sha256").update(text).digest("hex");
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    if (oauth == null || (typeof oauth === "object" && !Array.isArray(oauth) && Object.keys(oauth).length === 0)
        || oauth.refreshToken === "") return { version, state: "failed" as const };
    if (typeof oauth !== "object" || Array.isArray(oauth)) return { version, state: "unknown" as const };
    return { version, state: "present" as const, oauth };
  } catch { return { version, state: "unknown" as const }; }
}
/** Only metadata leaves the credential reader; tokens never enter state or logs. */
export function credentialStatus(account: Account) {
  const { version, state, oauth } = readCredentials(account);
  return { version, state, expiresAt: timestamp(oauth?.expiresAt), refreshTokenExpiresAt: timestamp(oauth?.refreshTokenExpiresAt) };
}
export function checkAuthExpiry(account: Account, now = Date.now()): void {
  const { expiresAt, refreshTokenExpiresAt: expiry } = credentialStatus(account);
  safely(() => update((state) => {
    if (expiry === null) return; // Unknown does not rearm an existing warning.
    const health = entry(state, account);
    // Match the CLI's stale metadata guard. An already-past deadline is silent.
    if (expiry <= now || expiry > now + THREE_DAYS || (expiresAt !== null && expiresAt > expiry + THREE_DAYS)) {
      delete health.expiry;
      return;
    }
    health.expiry ??= { id: crypto.randomUUID(), since: new Date(now).toISOString(), expiresAt: expiry };
  }));
}
export function authHealth(account: Account) {
  return { authFailedSince: get(account)?.failure?.since ?? null,
    refreshTokenExpiresAt: credentialStatus(account).refreshTokenExpiresAt };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function warningText(machine: string, account: Account, incident: FailureIncident | ExpiryIncident): string {
  const reason = "expiresAt" in incident
    ? `refresh token expires at ${new Date(incident.expiresAt).toISOString()} (within 3 days)`
    : `authentication failed since ${incident.since}`;
  const command = account.isDefault && process.env.CLAUDE_CONFIG_DIR === undefined
    ? "claude" : `CLAUDE_CONFIG_DIR=${quote(account.dir)} claude`;
  return `Claude proxy on ${machine}: account ${account.name} ${reason}. On ${machine}, run \`${command}\`, then /login.`;
}
const sending = new Set<string>();
const delivered = new Set<string>();
const lastSent = new Map<string, Delivery>();
/** Sender accepts the incident ID so a future idempotent Today CLI can use it directly. */
export async function flushAuthWarnings(send: WarningSender, machine = hostname()): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const lease = `${path()}.sender.lock`;
  if (sending.has(lease) || !tryLock(lease, false).held) return;
  sending.add(lease);
  try {
    for (const [accountKey, snapshot] of Object.entries(read())) {
      for (const kind of ["failure", "expiry"] as const) {
        const candidate = snapshot[kind];
        if (!candidate) continue;
        // A send can await for seconds. Re-read each incident and account after the preceding send.
        const account = listAccounts().find((a) => key(a) === accountKey);
        if (!account) continue;
        if (kind === "expiry") checkAuthExpiry(account);
        const health = read()[accountKey];
        const incident = health?.[kind];
        if (!incident || incident.id !== candidate.id || incident.delivered || delivered.has(incident.id)) continue;
        const version = credentialStatus(account).version;
        const remembered = lastSent.get(`${path()}:${accountKey}`);
        const previous = remembered && remembered.at > (health.lastSent?.at ?? 0) ? remembered : health.lastSent;
        if (previous && previous.credentials === version && Date.now() - previous.at < SIX_HOURS) continue;
        let sent = false;
        try { sent = await send(warningText(machine, account, incident), incident.id); } catch {}
        if (!sent) continue;
        // Even if the durable write fails, this process must not resend on every tick.
        delivered.add(incident.id);
        const delivery = { at: Date.now(), credentials: version };
        lastSent.set(`${path()}:${accountKey}`, delivery);
        safely(() => update((state) => {
          const current = state[accountKey];
          if (!current) return;
          current.lastSent = delivery;
          if (current[kind]?.id === incident.id) current[kind]!.delivered = true;
        }));
      }
    }
  } finally { sending.delete(lease); unlock(lease); }
}
async function sendTodayWarning(message: string, _incidentId: string): Promise<boolean> {
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  const child = Bun.spawn([join(homedir(), ".local/bin/today-daemon"), "send", "--socket",
    `/run/user/${process.getuid!()}/today/daemon.sock`, "--client", "claude-codex-proxy", "today", "-"], {
    env, stdin: new TextEncoder().encode(message), stdout: "ignore", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { return await child.exited === 0; } finally { clearTimeout(timer); }
}
/** One batch at a time; stopping always waits for the actual in-flight batch. */
export function startAuthWarnings(send: WarningSender = sendTodayWarning, intervalMs = 15_000): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const tick = () => {
    pending = flushAuthWarnings(send).catch(() => {
      console.error("Unable to deliver account authentication warnings");
    }).finally(() => {
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
    });
  };
  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); return pending; };
}
function usageBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body) || "error" in body) return false;
  const data = body as Record<string, any>;
  const validPercent = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"]
    .some((key) => validPercent(data[key]?.utilization))
    || (Array.isArray(data.limits) && data.limits.length > 0
      && data.limits.every((w: any) => typeof w?.kind === "string" && validPercent(w.percent)));
}
/** Read-only validation; never interpret a rejected expired bearer as a dead refresh token. */
export async function validateSubscriptionAuth(
  account: Account,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<"healthy" | "failed" | "unknown"> {
  try {
    const { version, state, oauth } = readCredentials(account);
    if (state === "failed") return "failed";
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return "unknown";
    const response = await request("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    let result: "healthy" | "failed" | "unknown" = "unknown";
    if (response.ok) result = usageBody(await response.json()) ? "healthy" : "unknown";
    else {
      await response.body?.cancel();
      if (response.status === 401 && (timestamp(oauth.expiresAt) ?? 0) > Date.now() + REFRESH_BUFFER) result = "failed";
    }
    return credentialStatus(account).version === version ? result : "unknown";
  } catch { return "unknown"; }
}
