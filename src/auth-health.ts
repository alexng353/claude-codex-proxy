import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "./accounts";
import { tryLock, unlock, withLock } from "./filelock";
import { stateDir } from "./sessions";

type Incident = { id: string; since: string; delivered?: boolean; expiresAt?: number };
type Health = { dir: string; failure?: Incident; expiry?: Incident };
type State = Record<string, Health>;
export type WarningSender = (message: string) => Promise<boolean>;
const THREE_DAYS = 3 * 86400_000;
function path() { return join(stateDir(), "account-auth.json"); }
function read(): State {
  try { return JSON.parse(readFileSync(path(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error; // Do not silently reset dedupe state on a damaged file.
  }
}
function update(fn: (state: State) => void): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  withLock(`${path()}.lock`, () => {
    const state = read();
    fn(state);
    const next = `${path()}.${process.pid}.next`;
    writeFileSync(next, JSON.stringify(state), { mode: 0o600 });
    renameSync(next, path());
  });
}
function safely(fn: () => void): void {
  try { fn(); } catch { console.error("Unable to update account authentication state"); }
}
function entry(state: State, account: Account): Health {
  const old = state[account.name];
  return old?.dir === account.dir ? old : (state[account.name] = { dir: account.dir });
}
export function recordAuthFailure(account: Account): void {
  safely(() => update((state) => {
    entry(state, account).failure ??= { id: crypto.randomUUID(), since: new Date().toISOString() };
  }));
}
/** Only a successful authenticated request ends an incident; touching credentials does not. */
export function markAuthHealthy(account: Account): void {
  if (!authHealth(account).authFailedSince) return;
  safely(() => update((state) => { delete entry(state, account).failure; }));
}
export function credentialExpiry(account: Account): { expiresAt: number | null; refreshTokenExpiresAt: number | null } {
  try {
    const oauth = JSON.parse(readFileSync(join(account.dir, ".credentials.json"), "utf8"))?.claudeAiOauth;
    const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : null;
    return { expiresAt: timestamp(oauth?.expiresAt), refreshTokenExpiresAt: timestamp(oauth?.refreshTokenExpiresAt) };
  } catch { return { expiresAt: null, refreshTokenExpiresAt: null }; }
}
export function checkAuthExpiry(account: Account, now = Date.now()): void {
  const expiry = credentialExpiry(account).refreshTokenExpiresAt;
  safely(() => update((state) => {
    const health = entry(state, account);
    if (expiry === null) return; // Unknown is not evidence of a renewed login.
    if (expiry > now + THREE_DAYS) { delete health.expiry; return; }
    health.expiry ??= { id: crypto.randomUUID(), since: new Date(now).toISOString(), expiresAt: expiry };
  }));
}
export function authHealth(account: Account) {
  let health: Health | undefined;
  try { health = read()[account.name]; } catch {}
  return {
    authFailedSince: health?.dir === account.dir ? health.failure?.since ?? null : null,
    refreshTokenExpiresAt: credentialExpiry(account).refreshTokenExpiresAt,
  };
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function warningText(machine: string, name: string, health: Health, kind: "failure" | "expiry"): string {
  const incident = health[kind]!;
  const reason = kind === "failure"
    ? `authentication failed since ${incident.since}`
    : `refresh token expires at ${new Date(incident.expiresAt!).toISOString()} (within 3 days or already expired)`;
  return `Claude proxy on ${machine}: account ${name} ${reason}. On ${machine}, run CLAUDE_CONFIG_DIR=${quote(health.dir)} claude, then /login.`;
}
/** Sender is explicit so importing modules or exercising fake CLI tests never sends real messages. */
export async function flushAuthWarnings(send: WarningSender, machine = hostname()): Promise<void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const lease = `${path()}.sender.lock`;
  // flock is reentrant in this process; also reject overlapping local flushes.
  if (sending.has(lease) || !tryLock(lease).held) return;
  sending.add(lease);
  try {
    for (const [name, health] of Object.entries(read())) {
      for (const kind of ["failure", "expiry"] as const) {
        const incident = health[kind];
        if (!incident || incident.delivered) continue;
        let delivered = false;
        try { delivered = await send(warningText(machine, name, health, kind)); } catch {}
        if (delivered) update((state) => {
          const current = state[name]?.[kind];
          if (current?.id === incident.id) current.delivered = true;
        });
      }
    }
  } finally { sending.delete(lease); unlock(lease); }
}
const sending = new Set<string>();
export async function sendTodayWarning(message: string): Promise<boolean> {
  const child = Bun.spawn([join(homedir(), ".local/bin/today-daemon"), "send", "--socket",
    `/run/user/${process.getuid!()}/today/daemon.sock`, "today", "-"], {
    stdin: new TextEncoder().encode(message), stdout: "ignore", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { return await child.exited === 0; } finally { clearTimeout(timer); }
}
/** Worker failures are queued synchronously; this pump delivers them without blocking turns. */
export function startAuthWarnings(): () => Promise<void> {
  let pending = Promise.resolve();
  const tick = () => { pending = flushAuthWarnings(sendTodayWarning).catch(() => {
    console.error("Unable to deliver account authentication warnings");
  }); };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  return () => { clearInterval(timer); return pending; };
}

/** /usage may swallow an HTTP 401 and return an empty report. Validate against
 * the same read-only endpoint in that case, without any model or refresh call.
 * Never follow redirects with the bearer token or log a response/error body.
 */
export async function validateSubscriptionAuth(
  account: Account,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<"healthy" | "failed" | "unknown"> {
  try {
    const oauth = JSON.parse(readFileSync(join(account.dir, ".credentials.json"), "utf8"))?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return "unknown";
    const response = await request("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return response.status === 401 ? "failed" : response.ok ? "healthy" : "unknown";
  } catch { return "unknown"; }
}
