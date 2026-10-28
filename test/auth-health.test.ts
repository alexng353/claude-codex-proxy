import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as health from "../src/auth-health";
import { accountStatus, isAuthError, listAccounts, markAuthFailed, resetAccountState } from "../src/accounts";

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
  expect(isAuthError(undefined, 'Not logged in')).toBe(true);
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
  health.markAuthHealthy(account);
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
  writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-secret' } }));
  for (const [status, expected] of [[200, 'healthy'], [401, 'failed'], [429, 'unknown'], [500, 'unknown']] as const) {
    expect(await health.validateSubscriptionAuth(account, async (url, options) => {
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect(options.redirect).toBe('error');
      return new Response('{}', { status });
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
