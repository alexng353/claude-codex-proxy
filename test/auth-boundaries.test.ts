import { afterEach, expect, test, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAccounts, accountStatus, markAuthFailed, resetAccountState, isAuthError } from "../src/accounts";
import { probeAccount, resetUsageProbe } from "../src/usage-probe";
import * as health from "../src/auth-health";

const saved = { ...process.env };
let root = '';
function setup(oauth: unknown = { accessToken: 'FAKE', refreshToken: 'FAKE-R', expiresAt: Date.now() + 3600000 }) {
  root = mkdtempSync(join(tmpdir(), 'boundaries-'));
  process.env.PROXY_STATE_DIR = join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'base');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  credentials(oauth);
  resetAccountState(); resetUsageProbe();
  return listAccounts()[0];
}
function credentials(oauth: unknown) {
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
}
function replay(name: string, stderr = '', code = 0) {
  const fixture = readFileSync(join(import.meta.dir, 'fixtures/cli-2.1.302', name + '.jsonl'), 'utf8').trim().split('\n').map((line) => {
    const event = JSON.parse(line);
    for (const window of event.usage_report?.rate_limits?.limits ?? []) window.resets_at = new Date(Date.now() + 3600000).toISOString();
    return JSON.stringify(event);
  }).join('\n');
  const cli = join(root, 'cli');
  writeFileSync(cli, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(fixture)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});`);
  chmodSync(cli, 0o755); process.env.CLAUDE_BIN = cli;
}
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetAccountState(); resetUsageProbe();
  if (root) rmSync(root, { recursive: true, force: true });
});

for (const kind of ['dead', 'empty', 'missing', 'malformed', 'unreadable'] as const) test(`real empty /usage with ${kind} credentials`, async () => {
  const account = setup(kind === 'dead' ? { accessToken: '', refreshToken: '', expiresAt: 0 } : {});
  const file = join(account.dir, '.credentials.json');
  if (kind === 'missing') rmSync(file);
  if (kind === 'malformed') writeFileSync(file, '{');
  if (kind === 'unreadable') { rmSync(file); mkdirSync(file); }
  replay(kind === 'dead' ? 'm-refresh-dead' : 'm-empty');
  const outcome = await probeAccount(account);
  if (kind === 'malformed' || kind === 'unreadable') expect(outcome.result).toBe('unavailable');
  else expect(outcome.result).toStartWith('auth failed since ');
});

test('expired access plus failed refresh is unknown even when endpoint returns 401', async () => {
  const account = setup({ accessToken: 'FAKE', refreshToken: 'FAKE-R', expiresAt: Date.now() - 1000 });
  replay('m-refresh-500');
  expect((await probeAccount(account, (a) => health.validateSubscriptionAuth(a, async () => new Response('', { status: 401 })))).result).toBe('unavailable');
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('fresh rejected token from an empty report opens an incident', async () => {
  const account = setup(); replay('m-revoked');
  const outcome = await probeAccount(account, (a) => health.validateSubscriptionAuth(a, async () => new Response('', { status: 401 })));
  expect(outcome.result).toStartWith('auth failed since ');
});

for (const [code, stderr] of [[1, ''], [0, 'API Error: 429 rate limit']] as const) test(`no endpoint after exit ${code} with ${stderr}`, async () => {
  const account = setup(); replay('m-u429', stderr, code);
  let calls = 0;
  await probeAccount(account, async () => { calls++; return 'failed'; });
  expect(calls).toBe(0);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('valid usage wins over noisy stderr and updates meters during an unresolved incident', async () => {
  const account = setup(); replay('m-fresh200b', 'Not logged in. Run claude auth login.');
  expect((await probeAccount(account)).result).toBe('applied');
  markAuthFailed(account);
  const since = accountStatus()[0].authFailedSince;
  await probeAccount(account, async () => 'unknown');
  expect(accountStatus()[0].windows.seven_day.usedPercent).toBe(34);
  expect(accountStatus()[0].authFailedSince).toBe(since);
});

test('validation binds its outcome to credentials and requires a usage-shaped success', async () => {
  const account = setup();
  const logs = spyOn(console, 'error');
  const output = spyOn(console, 'log');
  try {
    for (const body of [{}, { type: 'error', error: { type: 'authentication_error' } }, { five_hour: { utilization: 'bad' } }]) {
      expect(await health.validateSubscriptionAuth(account, async (url, init) => {
        expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer FAKE');
        return Response.json(body);
      })).toBe('unknown');
    }
    expect(await health.validateSubscriptionAuth(account, async () => {
      credentials({ accessToken: 'REPLACED', refreshToken: 'R', expiresAt: Date.now() + 3600000 });
      return new Response('', { status: 401 });
    })).toBe('unknown');
    expect(JSON.stringify([...logs.mock.calls, ...output.mock.calls])).not.toContain('FAKE');
  } finally { logs.mockRestore(); output.mockRestore(); }
});

test('turn auth classification does not match unrelated not-logged-in text', () => {
  expect(isAuthError(undefined, 'Tool failed because browser is not logged in to example.com')).toBe(false);
  expect(isAuthError(undefined, 'Not logged in. Run claude auth login.')).toBe(true);
});

test('configured account directories remain visible when credentials are missing', async () => {
  setup();
  const dir = join(process.env.PROXY_STATE_DIR!, 'accounts', 'missing');
  mkdirSync(dir, { recursive: true });
  replay('m-empty');
  const account = listAccounts().find((a) => a.name === 'missing');
  expect(account).toBeDefined();
  expect((await probeAccount(account!)).result).toStartWith('auth failed since ');
});

test('timeout signals TERM before KILL and never validates the endpoint', async () => {
  const account = setup();
  const cli = join(root, 'slow-cli');
  const term = join(root, 'term');
  writeFileSync(cli, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }\nprocess.on('SIGTERM', () => { writeFileSync(${JSON.stringify(term)}, 'term'); });\nsetInterval(() => {}, 10);`);
  chmodSync(cli, 0o755); process.env.CLAUDE_BIN = cli;
  let calls = 0;
  const start = Date.now();
  await probeAccount(account, async () => { calls++; return 'failed'; }, 150);
  expect(readFileSync(term, 'utf8')).toBe('term');
  expect(Date.now() - start).toBeGreaterThanOrEqual(1100);
  expect(calls).toBe(0);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('access-token refresh buffer does not falsely demand a new login', async () => {
  const account = setup();
  for (const remaining of [-1000, 0, 60_000, 5 * 60_000]) {
    credentials({ accessToken: 'FAKE', refreshToken: 'FAKE-R', expiresAt: Date.now() + remaining });
    expect(await health.validateSubscriptionAuth(account, async () => new Response('', { status: 401 }))).toBe('unknown');
  }
});

test('captured model-turn authentication error is classified without synthetic result fields', () => {
  const events = readFileSync(join(import.meta.dir, 'fixtures/cli-2.1.302/m-turn-fresh401.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const result = events.find((event) => event.type === 'result');
  expect(result.is_error).toBe(true);
  expect(isAuthError(result.api_error_status, [result.result, ...(result.errors ?? [])].join('\n'))).toBe(true);
});

test('invalid_grant detected after the CLI blanks previously present credentials', async () => {
  const account = setup(); replay('m-refresh-dead');
  const cli = process.env.CLAUDE_BIN!;
  const blank = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } });
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('process.stdout.write(', `require('node:fs').writeFileSync(${JSON.stringify(join(account.dir, '.credentials.json'))}, ${JSON.stringify(blank)}); process.stdout.write(`));
  const outcome = await probeAccount(account, async () => { throw new Error('dead marker needs no endpoint'); });
  expect(outcome.result).toStartWith('auth failed since ');
});
