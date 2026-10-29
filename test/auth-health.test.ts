import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyTurn } from "../src/hygiene";
import * as health from "../src/auth-health";
import { accountStatus, isAuthError, listAccounts, markAuthFailed, markAuthSucceeded, resetAccountState } from "../src/accounts";

const scratch = tmpdir();
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const original = { state: process.env.PROXY_STATE_DIR, config: process.env.CLAUDE_CONFIG_DIR };
let root: string;
function setup() {
  root = mkdtempSync(join(scratch, 'health-'));
  process.env.PROXY_STATE_DIR = root;
  process.env.CLAUDE_CONFIG_DIR = root;
  resetAccountState();
  return listAccounts()[0];
}
afterEach(() => {
  resetAccountState();
  for (const [key, value] of [["PROXY_STATE_DIR", original.state], ["CLAUDE_CONFIG_DIR", original.config]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test('auth failure persists across restarts and displays its original timestamp', () => {
  const account = setup();
  markAuthFailed(account);
  const first = accountStatus()[0] as any;
  expect(first.authFailedSince).toBeString();
  resetAccountState();
  expect((accountStatus()[0] as any).authFailedSince).toBe(first.authFailedSince);
});

test('refresh failures and missing login are authentication errors, network failures are not', () => {
  expect(isAuthError(undefined, 'OAuth token refresh failed: invalid_grant')).toBe(true);
  expect(isAuthError(undefined, 'Not logged in. Run claude auth login.')).toBe(true);
  expect(isAuthError(undefined, 'Token refresh failed: timeout')).toBe(false);
});

test('warnings dedupe across repeated failures and retry failed delivery; recovery starts a new incident', async () => {
  const account = setup();
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); return true; };
  markAuthFailed(account);
  await health.flushAuthWarnings(async () => false, 'forge');
  await health.flushAuthWarnings(send, 'forge');
  resetAccountState();
  markAuthFailed(account);
  await health.flushAuthWarnings(send, 'forge');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('forge');
  expect(messages[0]).toContain(`CLAUDE_CONFIG_DIR='${root}' claude`);
  expect(messages[0]).toContain('/login');
  expect(classifyTurn({model:'sonnet',input:[{role:'user',content:messages[0]}]}).type).not.toBe('human');
  markAuthSucceeded(account, health.authIncidentId(account));
  writeFileSync(join(root, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "new-test-token" } }));
  markAuthFailed(account);
  await health.flushAuthWarnings(send, 'forge');
  expect(messages).toHaveLength(2);
});

test('expiry warning ignores absent expiry, dedupes small expiry drift, and rearms after renewal', async () => {
  const account = setup();
  const now = Date.now();
  const messages: string[] = [];
  const send = async (m: string) => { messages.push(m); return true; };
  const check = async (expiry?: number) => {
    writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiry } }));
    health.checkAuthExpiry(account, now);
    await health.flushAuthWarnings(send, 'forge');
  };
  await check();
  await check(now + 2 * 86400000);
  await check(now + 2 * 86400000 + 152);
  expect(messages).toHaveLength(1);
  await check(now + 20 * 86400000);
  await check(now + 86400000);
  expect(messages).toHaveLength(2);
});

test('usage endpoint validation distinguishes rejected auth from network and quota errors without exposing credentials', async () => {
  const account = setup();
  writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-secret', expiresAt: Date.now() + 3600000 } }));
  for (const [status, expected] of [[200, 'healthy'], [401, 'failed'], [429, 'unknown'], [500, 'unknown']] as const) {
    expect(await health.validateSubscriptionAuth(account, async (url, options) => {
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect(options.redirect).toBe('error');
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer test-only-secret');
      return Response.json({ five_hour: { utilization: 12 } }, { status });
    })).toBe(expected);
  }
  expect(await health.validateSubscriptionAuth(account, async () => { throw new Error('network'); })).toBe('unknown');
});

test('overlapping warning flushes deliver a pending incident only once', async () => {
  const account = setup();
  markAuthFailed(account);
  let count = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const first = health.flushAuthWarnings(async () => { count++; await waiting; return true; });
  await health.flushAuthWarnings(async () => { count++; return true; });
  release();
  await first;
  expect(count).toBe(1);
});

test('unknown expiry does not rearm a delivered incident', async () => {
  const account = setup();
  const file = join(root, '.credentials.json');
  const expiry = Date.now() + 86400000;
  const set = (value: unknown) => { writeFileSync(file, JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: value } })); health.checkAuthExpiry(account); };
  let sent = 0;
  const sender = async () => { sent++; return true; };
  set(expiry); await health.flushAuthWarnings(sender);
  set(undefined);
  set(expiry + 152); await health.flushAuthWarnings(sender);
  expect(sent).toBe(1);
});

for (const kind of ['expired', 'stale'] as const) test(`${kind} refresh deadline is silent`, async () => {
  const account = setup();
  const oauth = kind === 'expired' ? { refreshTokenExpiresAt: Date.now() - 1 }
    : { refreshTokenExpiresAt: Date.now() + 86400000, expiresAt: Date.now() + 5 * 86400000 };
  writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  health.checkAuthExpiry(account);
  let count = 0;
  await health.flushAuthWarnings(async () => { count++; return true; });
  expect(count).toBe(0);
});

test('failure hysteresis survives recovery until credentials change', async () => {
  const account = setup();
  let sent = 0;
  const sender = async () => { sent++; return true; };
  markAuthFailed(account); await health.flushAuthWarnings(sender);
  markAuthSucceeded(account, health.authIncidentId(account));
  markAuthFailed(account); await health.flushAuthWarnings(sender);
  expect(sent).toBe(1);
  writeFileSync(join(root, '.credentials.json'), '{"changed":true}');
  await health.flushAuthWarnings(sender);
  expect(sent).toBe(2);
});

test('older success cannot clear a replacement incident', () => {
  const account = setup();
  markAuthFailed(account);
  const old = health.authIncidentId(account);
  markAuthSucceeded(account, old);
  markAuthFailed(account);
  const next = health.authIncidentId(account);
  markAuthSucceeded(account, old);
  expect(health.authIncidentId(account)).toBe(next);
  expect(accountStatus()[0].authFailedUntil).toBeString();
});

test('send rechecks incidents and removed accounts after awaiting another send', async () => {
  setup();
  const accounts = ['one', 'two', 'three', 'four'].map((name) => {
    const dir = join(root, 'accounts', name);
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.credentials.json'), '{}');
    return { name, dir, isDefault: false };
  });
  for (const account of accounts) markAuthFailed(account);
  const messages: string[] = [];
  await health.flushAuthWarnings(async (message) => {
    messages.push(message);
    markAuthSucceeded(accounts[1], health.authIncidentId(accounts[1]));
    markAuthSucceeded(accounts[2], health.authIncidentId(accounts[2]));
    markAuthFailed(accounts[2]);
    rmSync(accounts[3].dir, { recursive: true });
    return true;
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('account one');
});

test('a failed durable delivery record does not resend in this process', async () => {
  const account = setup(); markAuthFailed(account);
  const next = join(root, `account-auth.json.${process.pid}.next`);
  let count = 0;
  await health.flushAuthWarnings(async () => { count++; mkdirSync(next); return true; });
  rmSync(next, { recursive: true });
  const originalNow = Date.now; const later = originalNow() + 7 * 3600000;
  Date.now = () => later;
  try { await health.flushAuthWarnings(async () => { count++; return true; }); }
  finally { Date.now = originalNow; }
  expect(count).toBe(1);
});

test('stop waits for an entire batch and does not overlap ticks', async () => {
  const account = setup(); markAuthFailed(account);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const stop = health.startAuthWarnings(async () => { calls++; await gate; return true; }, 1);
  await Bun.sleep(20);
  let done = false;
  const stopping = stop().then(() => { done = true; });
  await Bun.sleep(10);
  expect(done).toBe(false);
  expect(calls).toBe(1);
  release(); await stopping;
  await Bun.sleep(10);
  expect(calls).toBe(1);
});

test('failure warning rearms after six hours without a credential change', async () => {
  const account = setup();
  let count = 0;
  const sender = async () => { count++; return true; };
  markAuthFailed(account); await health.flushAuthWarnings(sender);
  markAuthSucceeded(account, health.authIncidentId(account));
  markAuthFailed(account);
  const originalNow = Date.now;
  const later = originalNow() + 6 * 3600000 + 1;
  Date.now = () => later;
  try { await health.flushAuthWarnings(sender); } finally { Date.now = originalNow; }
  expect(count).toBe(2);
});

test('expiry delivery does not suppress a new failure warning', async () => {
  const account = setup();
  writeFileSync(join(root,'.credentials.json'), JSON.stringify({claudeAiOauth:{refreshTokenExpiresAt:Date.now()+86400000}}));
  health.checkAuthExpiry(account);
  let count = 0;
  const send = async () => { count++; return true; };
  await health.flushAuthWarnings(send);
  markAuthFailed(account);
  await health.flushAuthWarnings(send);
  expect(count).toBe(2);
});

test('expiry delivery rechecks a deadline that passed after observation', async () => {
  const account = setup();
  writeFileSync(join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{refreshTokenExpiresAt:Date.now()+60000}}));
  health.checkAuthExpiry(account);
  const now = Date.now; const later = now()+120000;
  Date.now = () => later;
  let sent = 0;
  try { await health.flushAuthWarnings(async () => { sent++; return true; }); }
  finally { Date.now = now; }
  expect(sent).toBe(0);
});
