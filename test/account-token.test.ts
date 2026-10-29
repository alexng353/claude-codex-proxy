import { afterEach, expect, test, spyOn } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountEnv, accountStatus, isUnavailable, linkSharedEntries, listAccounts, markAuthFailed, resetAccountState } from '../src/accounts';
import { checkAuthExpiry, credentialStatus, flushAuthWarnings, validateSubscriptionAuth } from '../src/auth-health';
import { accountToken } from '../src/account-token';
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
  expect(existsSync(join(extra, 'oauth-token.expires-at'))).toBe(false);
  const valid = join(root, 'valid-token'); writeFileSync(valid, fake, { mode: 0o600 });
  rmSync(join(a.dir, 'oauth-token')); symlinkSync(valid, join(a.dir, 'oauth-token'));
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
test('all launchers isolate token/config pairs and strip ambient tokens for login accounts', async () => {
  setup();
  for (const [name, token] of [['extra', 'distinct-named-fake-token'], ['login', null]] as const) {
    const dir = join(root, 'state/accounts', name); mkdirSync(dir, { recursive: true });
    if (token) writeFileSync(join(dir, 'oauth-token'), token, { mode: 0o600 });
    else writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake', refreshToken: 'fake' } }));
  }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-fake-token-must-not-leak';
  const { claudeClassifier } = await import('../src/hygiene-proof');
  const { claudeRunner } = await import('../src/perpetual/summarizer');
  const { runClaude, closeIdleWorkers } = await import('../src/claude');
  const spawn = Bun.spawn; const seen: { args: string[]; env: any }[] = [];
  (Bun as any).spawn = (args: string[], options: any) => {
    seen.push({ args, env: options.env });
    if (args.includes('--version') || args.includes('/usage')) {
      const report = args.includes('--version') ? '2.1.302 (Claude Code)' : JSON.stringify({
        type: 'assistant', local_command_run: { command: 'usage' },
        usage_report: { rate_limits: { limits: [{ kind: 'session', percent: 1 }] } },
      });
      return spawn([process.execPath, '-e', `console.log(${JSON.stringify(report)})`], options);
    }
    throw new Error('boundary stopped');
  };
  try {
    for (const [name, token] of [['default', fake], ['extra', 'distinct-named-fake-token'], ['login', undefined]] as const) {
      closeIdleWorkers(); resetUsageProbe(); resetAccountState(); seen.length = 0;
      process.env.CLAUDE_ACCOUNT_ORDER = name;
      const account = listAccounts().find(a => a.name === name)!;
      await expect(runClaude({ model: 'sonnet', input: 'hello' })).rejects.toThrow('boundary stopped');
      await expect(claudeClassifier({} as any, { kinds: [] })).rejects.toThrow('boundary stopped');
      expect(() => claudeRunner('haiku')(`test-thread-${name}`)).toThrow('boundary stopped');
      expect((await probeAccount(account)).result).toBe('applied');
      expect(seen).toHaveLength(5);
      expect(seen[3].args).toContain('--version'); expect(seen[4].args).toContain('/usage');
      for (const { env } of seen) {
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
        expect(env.CLAUDE_CONFIG_DIR).toBe(account.dir);
      }
    }
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
  let validations = 0;
  const outcome = await probeAccount(a, account => {
    expect(account).toEqual(a);
    return validateSubscriptionAuth(account, async () => { validations++; const response = new Response('', { status: 403 }); expect(response.status).toBe(403); return response; });
  });
  expect(validations).toBe(1);
  expect(outcome.result).toBe('unavailable');
  expect(isUnavailable(a)).toBe(false);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('legacy shared token symlinks do not disable named login accounts', () => {
  const base = setup(); const dir = join(root, 'state/accounts/legacy'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(base.dir, 'oauth-token.expires-at'), '2030-01-01T00:00:00Z');
  for (const name of ['oauth-token', 'oauth-token.expires-at']) symlinkSync(join(base.dir, name), join(dir, name));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-fake', refreshToken: 'refresh-fake' } }));
  const named = listAccounts().find(a => a.name === 'legacy')!;
  expect(isUnavailable(named)).toBe(false);
  expect(accountEnv(named).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  linkSharedEntries(dir);
  for (const name of ['oauth-token', 'oauth-token.expires-at']) expect(() => lstatSync(join(dir, name))).toThrow();
});
test('token reader does not open login credentials', () => {
  const a = setup(); const reader = spyOn(fs, 'readFileSync'); const opener = spyOn(fs, 'openSync');
  try {
    credentialStatus(a); accountEnv(a); isUnavailable(a);
    for (const call of [...reader.mock.calls, ...opener.mock.calls]) expect(String(call[0])).not.toContain('.credentials.json');
  } finally { reader.mockRestore(); opener.mockRestore(); }
});
test('token version is filesystem metadata, never a token digest', () => {
  const a = setup(); const stat = statSync(join(a.dir, 'oauth-token'));
  const version = credentialStatus(a).version!;
  expect(version).toBe(`token:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
  expect(version).not.toContain(createHash('sha256').update(fake).digest('hex'));
});
test('hardlinked or foreign-owned token files are refused', () => {
  const a = setup(); const path = join(a.dir, 'oauth-token'); linkSync(path, join(root, 'hardlink'));
  expect(accountToken(a)?.state).toBe('failed');
  rmSync(join(root, 'hardlink'));
  const original = fs.fstatSync; const stub = spyOn(fs, 'fstatSync').mockImplementation(((...args: any[]) => {
    const stat = (original as any)(...args); stat.uid = process.getuid!() + 1; return stat;
  }) as any);
  try { expect(accountToken(a)?.state).toBe('failed'); } finally { stub.mockRestore(); }
});
for (const kind of ['symlink', 'large', 'directory', 'fifo'] as const) test(`expiry reader refuses ${kind}`, () => {
  const a = setup(); const file = join(a.dir, 'oauth-token.expires-at');
  if (kind === 'symlink') { writeFileSync(join(root, 'expiry'), '2030-01-01T00:00:00Z'); symlinkSync(join(root, 'expiry'), file); }
  if (kind === 'large') writeFileSync(file, ' '.repeat(65) + '2030-01-01T00:00:00Z');
  if (kind === 'directory') mkdirSync(file);
  if (kind === 'fifo') expect(Bun.spawnSync(['mkfifo', file]).exitCode).toBe(0);
  expect(credentialStatus(a).expiresAt).toBeNull();
});
test('expiry-only edits replace the pending incident date at the exact 14-day boundary', async () => {
  const a = setup(); const now = Date.parse('2026-10-29T00:00:00.000Z');
  const clock = spyOn(Date, 'now').mockReturnValue(now); const file = join(a.dir, 'oauth-token.expires-at');
  const messages: string[] = []; const send = async (s: string) => { messages.push(s); return true; };
  try {
    writeFileSync(file, new Date(now + 14 * 86400000 + 1).toISOString());
    checkAuthExpiry(a); await flushAuthWarnings(send); expect(messages).toHaveLength(0);
    writeFileSync(file, new Date(now + 14 * 86400000).toISOString()); checkAuthExpiry(a);
    await flushAuthWarnings(send); expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(new Date(now + 14 * 86400000).toISOString());
    const changed = new Date(now + 13 * 86400000).toISOString();
    writeFileSync(file, changed); checkAuthExpiry(a); await flushAuthWarnings(send);
    expect(messages).toHaveLength(2); expect(messages[1]).toContain(changed);
  } finally { clock.mockRestore(); }
});
test('token-to-login mode switch drops pending token expiry', async () => {
  const a = setup(); writeFileSync(join(a.dir, 'oauth-token.expires-at'), new Date(Date.now() + 10 * 86400000).toISOString());
  checkAuthExpiry(a); rmSync(join(a.dir, 'oauth-token'));
  const messages: string[] = []; await flushAuthWarnings(async s => { messages.push(s); return true; });
  expect(messages).toHaveLength(0); expect(credentialStatus(a).authMode).toBe('login');
});
test('legacy token cleanup preserves deliberate login and config symlinks', () => {
  const base = setup(); const dir = join(root, 'state/accounts/linked'); mkdirSync(dir, { recursive: true });
  rmSync(join(base.dir, '.credentials.json'), { recursive: true });
  const names = ['.credentials.json', '.credentials.json.backup', '.claude.json', '.claude.json.backup'];
  for (const name of names) {
    writeFileSync(join(base.dir, name), '{}');
    symlinkSync(join(base.dir, name), join(dir, name));
  }
  symlinkSync(join(base.dir, 'oauth-token'), join(dir, 'oauth-token'));
  linkSharedEntries(dir);
  for (const name of names) expect(fs.readlinkSync(join(dir, name))).toBe(join(base.dir, name));
  expect(() => lstatSync(join(dir, 'oauth-token'))).toThrow();
});
