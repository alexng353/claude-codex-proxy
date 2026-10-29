import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountEnv, accountStatus, isUnavailable, linkSharedEntries, listAccounts, markAuthFailed, resetAccountState } from '../src/accounts';
import { checkAuthExpiry, credentialStatus, flushAuthWarnings, validateSubscriptionAuth } from '../src/auth-health';
import { createScrubber } from '../src/scrub.mjs';
import { probeAccount, resetUsageProbe } from '../src/usage-probe';
const saved = { ...process.env };
let root = '';
const fake = 'fake-token-only-for-tests';
function setup(named = false) {
  root = mkdtempSync(join(tmpdir(), 'token-'));
  process.env.PROXY_STATE_DIR = join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'base');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (named) mkdirSync(join(root, 'state/accounts/extra'), { recursive: true });
  resetAccountState(); resetUsageProbe();
  const account = listAccounts().find(a => a.isDefault !== named)!;
  writeFileSync(join(account.dir, 'oauth-token'), fake, { mode: 0o600 });
  // Reading credentials in token mode would fail: only the token is authoritative.
  mkdirSync(join(account.dir, '.credentials.json'));
  return account;
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved); resetAccountState(); resetUsageProbe();
  if (root) rmSync(root, { recursive: true, force: true });
});
for (const named of [false, true]) test(`token account selection (${named ? 'named' : 'default'})`, () => {
  const a = setup(named);
  expect(accountEnv(a).CLAUDE_CODE_OAUTH_TOKEN).toBe(fake);
  expect(isUnavailable(a)).toBe(false);
  expect(credentialStatus(a)).toMatchObject({ state: 'present', authMode: 'token', expiresAt: null, refreshTokenExpiresAt: null });
  expect(accountStatus().find(s => s.name === a.name)).toMatchObject({ authMode: 'token', tokenExpiresAt: null });
});
for (const mode of [0o644, 0o400, 0o660]) test(`refuse token permissions ${mode.toString(8)}`, () => {
  const a = setup(); chmodSync(join(a.dir, 'oauth-token'), mode);
  expect(() => accountEnv(a)).toThrow('oauth-token');
  expect(isUnavailable(a)).toBe(true);
});
test('token symlinks are refused and default token files are never shared', () => {
  const a = setup(); const extra = join(root, 'extra');
  writeFileSync(join(a.dir, 'oauth-token.expires-at'), '2030-01-01T00:00:00Z');
  linkSharedEntries(extra);
  expect(() => accountEnv({ name: 'extra', dir: extra, isDefault: false })).not.toThrow();
  expect(accountEnv({ name: 'extra', dir: extra, isDefault: false }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  rmSync(join(a.dir, 'oauth-token')); symlinkSync(join(a.dir, 'oauth-token.expires-at'), join(a.dir, 'oauth-token'));
  expect(() => accountEnv(a)).toThrow('oauth-token');
});
test('token expiry warns at 14 days, dedupes, and ignores login refresh expiry', async () => {
  const a = setup(); const messages: string[] = [];
  const send = async (s: string) => { messages.push(s); return true; };
  const expiry = join(a.dir, 'oauth-token.expires-at');
  writeFileSync(expiry, new Date(Date.now() + 15 * 86400000).toISOString());
  checkAuthExpiry(a); await flushAuthWarnings(send); expect(messages).toHaveLength(0);
  writeFileSync(expiry, new Date(Date.now() + 13 * 86400000).toISOString());
  checkAuthExpiry(a); await flushAuthWarnings(send); await flushAuthWarnings(send);
  expect(messages).toHaveLength(1); expect(messages[0]).toContain('14 days'); expect(messages[0]).toContain('setup-token');
  expect(messages[0]).not.toContain(fake);
  markAuthFailed(a); await flushAuthWarnings(send); await flushAuthWarnings(send);
  expect(messages).toHaveLength(2);
});
test('token validation treats 401 as failure without a refresh window, 403 as unknown', async () => {
  const a = setup();
  expect(await validateSubscriptionAuth(a, async (_u, opts) => {
    expect((opts.headers as any).Authorization).toBe(`Bearer ${fake}`);
    return new Response('', { status: 401 });
  })).toBe('failed');
  expect(await validateSubscriptionAuth(a, async () => new Response('', { status: 403 }))).toBe('unknown');
});
test('scrub token assignments and structured child env even with opaque values', () => {
  const scrubber = createScrubber({ files: [] });
  expect(scrubber.scrub(`CLAUDE_CODE_OAUTH_TOKEN=${fake} claude`)).not.toContain(fake);
  expect(JSON.stringify(scrubber.scrubRequest({ env: { CLAUDE_CODE_OAUTH_TOKEN: fake } }))).not.toContain(fake);
});
test('all four launchers inject only the account token after ambient stripping', async () => {
  const a = setup(); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-fake';
  const { claudeClassifier } = await import('../src/hygiene-proof');
  const { claudeRunner } = await import('../src/perpetual/summarizer');
  const { runClaude, closeIdleWorkers } = await import('../src/claude');
  closeIdleWorkers(); const spawn = Bun.spawn; const seen: any[] = [];
  (Bun as any).spawn = (_args: any, options: any) => { seen.push(options.env); throw new Error('boundary stopped'); };
  try {
    await expect(runClaude({ model: 'sonnet', input: 'hello' })).rejects.toThrow('boundary stopped');
    await expect(claudeClassifier({} as any, { kinds: [] })).rejects.toThrow('boundary stopped');
    expect(() => claudeRunner('haiku')('test-thread')).toThrow('boundary stopped');
    await expect(probeAccount(a)).rejects.toThrow('boundary stopped');
    expect(seen).toHaveLength(4);
    for (const env of seen) expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(fake);
  } finally { Bun.spawn = spawn; closeIdleWorkers(); }
});
test('switching to token mode cancels an undelivered login refresh warning', async () => {
  const a = setup(); rmSync(join(a.dir, 'oauth-token'));
  rmSync(join(a.dir, '.credentials.json'), { recursive: true });
  writeFileSync(join(a.dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000,
    refreshTokenExpiresAt: Date.now() + 86400000,
  } }));
  checkAuthExpiry(a);
  writeFileSync(join(a.dir, 'oauth-token'), fake, { mode: 0o600 });
  checkAuthExpiry(a);
  const messages: string[] = [];
  await flushAuthWarnings(async s => { messages.push(s); return true; });
  expect(messages).toHaveLength(0);
});
test('dangling token symlink fails closed instead of using login', () => {
  const a = setup(); rmSync(join(a.dir, 'oauth-token'));
  symlinkSync(join(root, 'missing'), join(a.dir, 'oauth-token'));
  expect(() => accountEnv(a)).toThrow('oauth-token');
});
test('rotating a token without expiry metadata cancels the previous pending expiry', async () => {
  const a = setup(); const expiry = join(a.dir, 'oauth-token.expires-at');
  writeFileSync(expiry, new Date(Date.now() + 10 * 86400000).toISOString());
  checkAuthExpiry(a);
  writeFileSync(join(a.dir, 'oauth-token'), 'replacement-fake-token'); rmSync(expiry);
  const messages: string[] = [];
  await flushAuthWarnings(async s => { messages.push(s); return true; });
  expect(messages).toHaveLength(0);
});
test('token probe scope refusal remains unknown and does not disable routing', async () => {
  const a = setup(); const cli = join(root, 'fake-claude');
  writeFileSync(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('2.1.302 (Claude Code)');\n`, { mode: 0o700 });
  process.env.CLAUDE_BIN = cli;
  const outcome = await probeAccount(a, account => validateSubscriptionAuth(account, async () => new Response('', { status: 403 })));
  expect(outcome.result).toBe('unavailable');
  expect(isUnavailable(a)).toBe(false);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});
