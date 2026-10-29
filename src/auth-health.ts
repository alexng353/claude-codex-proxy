import { accountToken } from "./account-token";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { listAccounts, type Account } from "./accounts";
import { tryLock, unlock, withLock } from "./filelock";
import { stateDir } from "./sessions";
import { STRIPPED_ENV } from "./claude-env";

type FailureIncident = { id: string; since: string; delivered?: boolean };
type ExpiryIncident = FailureIncident & { expiresAt: number; authMode?: "token" | "login"; version?: string };
type Delivery = { at: number; credentials: string | undefined; expiresAt?: number };
type Health = {
  generation: string;
  name: string;
  dir: string;
  failure?: FailureIncident;
  expiry?: ExpiryIncident;
  seenCredentials?: boolean;
  missingSince?: number;
  lastSent?: Partial<Record<"failure" | "expiry", Delivery>>;
};
type State = Record<string, Health>;
export type WarningSender = (message: string, incidentId: string) => Promise<boolean>;
const THREE_DAYS = 3 * 86400_000;
const SIX_HOURS = 6 * 3600_000;
const REFRESH_BUFFER = 5 * 60_000;
const key = (account: Pick<Account, "name" | "dir">) => JSON.stringify([account.name, account.dir]);
function path() { return join(stateDir(), "account-auth.json"); }
function readState(): State {
  try {
    const saved = JSON.parse(readFileSync(path(), "utf8"));
    // Preserve incidents created by the first version, before keys included dirs.
    return Object.fromEntries(Object.entries(saved).map(([oldKey, value]) => {
      const health = value as Health;
      const name = health.name ?? oldKey;
      const legacy = health.lastSent as Delivery | undefined;
      if (legacy && "at" in legacy) {
        const history: Health["lastSent"] = {};
        if (health.expiry?.delivered) history.expiry = legacy;
        if (health.failure?.delivered || (!health.expiry?.delivered && health.failure)) history.failure = legacy;
        health.lastSent = Object.keys(history).length ? history : undefined;
      }
      return [key({ name, dir: health.dir }), { ...health, name }];
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error; // Never reset dedupe after an unreadable/corrupt state file.
  }
}
function read(): State {
  const state = readState();
  // An older handoff slot can recreate records without generations. Adopt the
  // current disk record under the lock, never a deterministic name-based identity.
  return Object.values(state).some(health => health.generation == null)
    ? update(current => current) : state;
}
function update<T>(fn: (state: State) => T): T {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  return withLock(`${path()}.lock`, () => {
    const state = readState();
    const before = JSON.stringify(state);
    for (const health of Object.values(state)) health.generation ??= crypto.randomUUID();
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
  return state[key(account)] ??= { generation: crypto.randomUUID(), name: account.name, dir: account.dir };
}
function get(account: Account): Health | undefined | null {
  try { return read()[key(account)]; } catch { return null; }
}
function noteCredentials(health: Health, version: string | undefined): void {
  if (!version || version === "missing") return;
  health.seenCredentials = true;
  delete health.missingSince;
}
/** Turns can observe a login before the first probe. Persist that fact only once. */
export function recordCredentialObservation(account: Account, version: string | undefined): void {
  if (!account.isDefault && !existsSync(account.dir)) return;
  if (!version || version === "missing") return;
  const known = get(account);
  if (known === null) return;
  if (known?.seenCredentials && known.missingSince === undefined) return;
  safely(() => update(state => {
    if (!account.isDefault && !existsSync(account.dir)) return;
    noteCredentials(entry(state, account), version);
  }));
}
/** Called by account remove; discarded identities must not affect a later re-add. */
export function forgetAccountAuth(account: Account): void {
  for (const kind of ["failure", "expiry"]) lastSent.delete(`${path()}:${key(account)}:${kind}`);
  update(state => { delete state[key(account)]; });
}
export function recordAuthFailure(account: Account): void {
  if (!account.isDefault && !existsSync(account.dir)) return;
  safely(() => update((state) => {
    if (!account.isDefault && !existsSync(account.dir)) return;
    const health = entry(state, account);
    const credentials = credentialStatus(account);
    noteCredentials(health, credentials.version);
    if (!account.isDefault && credentials.version === "missing" && !health.seenCredentials) {
      // account add creates the directory before interactive login has finished.
      health.missingSince ??= Date.now();
      if (Date.now() - health.missingSince < 15 * 60_000) return;
    }
    health.failure ??= { id: crypto.randomUUID(), since: new Date().toISOString() };
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
      if (health?.failure && health.failure.id !== observedId) return false;
      if (health) delete health.failure;
      return true;
    });
  } catch { console.error("Unable to clear account authentication state"); return false; }
}

const timestamp = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 8.64e15 ? v : null;
function readCredentials(account: Account) {
  const token = accountToken(account);
  if (token) return { version: token.version, state: token.state, oauth: token.state === "present" ? { accessToken: token.token, expiresAt: token.expiresAt } : undefined, authMode: "token" as const };
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
  const { version, state, oauth, authMode } = readCredentials(account);
  return { version, state, authMode: authMode ?? "login" as const, expiresAt: timestamp(oauth?.expiresAt), refreshTokenExpiresAt: timestamp(oauth && "refreshTokenExpiresAt" in oauth ? oauth.refreshTokenExpiresAt : null) };
}
export function checkAuthExpiry(account: Account, now = Date.now()): void {
  if (!account.isDefault && !existsSync(account.dir)) return;
  const { version, expiresAt, refreshTokenExpiresAt, authMode } = credentialStatus(account);
  const expiry = authMode === "token" ? expiresAt : refreshTokenExpiresAt;
  const window = authMode === "token" ? 14 * 86400_000 : THREE_DAYS;
  safely(() => update((state) => {
    if (!account.isDefault && !existsSync(account.dir)) return;
    const health = entry(state, account);
    noteCredentials(health, version);
    if (health.expiry && (health.expiry.authMode ?? "login") !== authMode) delete health.expiry;
    if (authMode === "token" && health.expiry && (health.expiry.version !== version || (expiry !== null && health.expiry.expiresAt !== expiry))) delete health.expiry;
    if (expiry === null) return; // Unknown does not rearm an existing warning.
    // Match the CLI's stale metadata guard. An already-past deadline is silent.
    if (expiry <= now || expiry > now + window || (authMode === "login" && expiresAt !== null && expiresAt > expiry + THREE_DAYS)) {
      delete health.expiry;
      return;
    }
    health.expiry ??= { id: crypto.randomUUID(), since: new Date(now).toISOString(), expiresAt: expiry, authMode, ...(authMode === "token" ? { version } : {}) };
  }));
}
export function authHealth(account: Account) {
  const credentials = credentialStatus(account);
  return { authMode: credentials.authMode, tokenExpiresAt: credentials.authMode === "token" ? credentials.expiresAt : null,
    authFailedSince: get(account)?.failure?.since ?? null,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function warningText(machine: string, account: Account, incident: FailureIncident | ExpiryIncident): string {
  const token = credentialStatus(account).authMode === "token";
  const reason = "expiresAt" in incident
    ? `${token ? "setup token" : "refresh token"} expires at ${new Date(incident.expiresAt).toISOString()} (within ${token ? 14 : 3} days)`
    : `authentication failed since ${incident.since}`;
  const command = account.isDefault && process.env.CLAUDE_CONFIG_DIR === undefined
    ? "claude" : `CLAUDE_CONFIG_DIR=${quote(account.dir)} claude`;
  if (token) return `[from claude-codex-proxy, ${machine}] Claude proxy on ${machine}: account ${account.name} ${reason}. On ${machine}, run \`${command} setup-token\` and replace this account’s oauth-token (mode 600) and expiry metadata.`;
  return `[from claude-codex-proxy, ${machine}] Claude proxy on ${machine}: account ${account.name} ${reason}. On ${machine}, run \`${command}\`, then /login.`;
}
const sending = new Set<string>();
const delivered = new Set<string>();
const lastSent = new Map<string, Delivery & { generation: string }>();
/** Sender accepts the incident ID so a future idempotent Today CLI can use it directly. */
export async function flushAuthWarnings(send: WarningSender, machine = hostname()): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const lease = `${path()}.sender.lock`;
  if (sending.has(lease) || !tryLock(lease, false).held) return;
  sending.add(lease);
  try {
    for (const [accountKey, snapshot] of Object.entries(read())) {
      for (const kind of ["failure", "expiry"] as const) {
        // A send can await for seconds. Re-read each incident and account after the preceding send.
        const account = listAccounts().find((a) => key(a) === accountKey);
        if (!account) {
          safely(() => forgetAccountAuth({ name: snapshot.name, dir: snapshot.dir, isDefault: false }));
          break;
        }
        const candidate = snapshot[kind];
        if (!candidate) continue;
        if (kind === "expiry") checkAuthExpiry(account);
        const health = read()[accountKey];
        const incident = health?.[kind];
        if (!incident || incident.id !== candidate.id || incident.delivered || delivered.has(incident.id)) continue;
        const version = credentialStatus(account).version;
        const remembered = lastSent.get(`${path()}:${accountKey}:${kind}`);
        const previous = remembered && remembered.generation === health.generation && remembered.at > (health.lastSent?.[kind]?.at ?? 0) ? remembered : health.lastSent?.[kind];
        const expiry = "expiresAt" in incident ? incident.expiresAt : undefined;
        if (previous && previous.credentials === version && (previous.expiresAt === undefined || previous.expiresAt === expiry) && Date.now() - previous.at < SIX_HOURS) continue;
        let sent = false;
        try { sent = await send(warningText(machine, account, incident), incident.id); } catch {}
        if (!sent) continue;
        // Even if the durable write fails, this process must not resend on every tick.
        delivered.add(incident.id);
        const delivery = { at: Date.now(), credentials: version, ...(expiry !== undefined ? { expiresAt: expiry } : {}) };
        lastSent.set(`${path()}:${accountKey}:${kind}`, { ...delivery, generation: health.generation });
        safely(() => update((state) => {
          const current = state[accountKey];
          if (!current || current.generation !== health.generation) return;
          (current.lastSent ??= {})[kind] = delivery;
          if (current[kind]?.id === incident.id) current[kind]!.delivered = true;
        }));
      }
    }
  } finally { sending.delete(lease); unlock(lease); }
}
async function sendTodayWarning(message: string, _incidentId: string): Promise<boolean> {
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn([process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon"), "send", "--socket",
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
    const { version, state, oauth, authMode } = readCredentials(account);
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
      if (response.status === 401 && (authMode === "token" || (timestamp(oauth.expiresAt) ?? 0) > Date.now() + REFRESH_BUFFER)) result = "failed";
    }
    return credentialStatus(account).version === version ? result : "unknown";
  } catch { return "unknown"; }
}
