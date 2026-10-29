import { afterEach, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAccounts, accountStatus, markAuthFailed, resetAccountState, isAuthError, isUnavailable, soonestAccount, markLimited } from "../src/accounts";
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
function replay(name: string, stderr = '', code = 0, percent?: number) {
  const fixture = readFileSync(join(import.meta.dir, 'fixtures/cli-2.1.302', name + '.jsonl'), 'utf8').trim().split('\n').map((line) => {
    const event = JSON.parse(line);
    for (const window of event.usage_report?.rate_limits?.limits ?? []) { window.resets_at = new Date(Date.now() + 3600000).toISOString(); if (percent !== undefined) window.percent = percent; }
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
  replay('m-fresh200b', '', 0, 67);
  await probeAccount(account, async () => 'unknown');
  expect(accountStatus()[0].windows.seven_day.usedPercent).toBe(67);
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
  expect(isUnavailable(account!)).toBe(true);
  markLimited(listAccounts()[0], Date.now() + 3600000);
  expect(soonestAccount().name).toBe('default');
  expect((await probeAccount(account!)).result).toBe('unavailable');
  const originalNow = Date.now; const later = originalNow() + 16 * 60000;
  Date.now = () => later;
  try { expect((await probeAccount(account!)).result).toStartWith('auth failed since '); }
  finally { Date.now = originalNow; }
});

test('timeout signals TERM before KILL and never validates the endpoint', async () => {
  const account = setup();
  const cli = join(root, 'slow-cli');
  const term = join(root, 'term');
  const ready = join(root, 'ready');
  writeFileSync(cli, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }\nprocess.on('SIGTERM', () => { writeFileSync(${JSON.stringify(term)}, 'term'); });\nwriteFileSync(${JSON.stringify(ready)}, 'ready');\nsetInterval(() => {}, 10);`);
  chmodSync(cli, 0o755); process.env.CLAUDE_BIN = cli;
  let calls = 0;
  const start = Date.now();
  const spawn = Bun.spawn;
  // Hold spawn's return until the real child installs its handler, so runClaude's
  // timeout starts after readiness. The version subprocess needs no handshake.
  (Bun as any).spawn = (args: string[], options: any) => {
    const child = spawn(args, options);
    if (args.includes('/usage')) {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(5);
    }
    return child;
  };
  try { await probeAccount(account, async () => { calls++; return 'failed'; }, 150); }
  finally { Bun.spawn = spawn; }
  expect(existsSync(ready)).toBe(true);
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

test('healthy recovery applies meters and clears both incident and cooldown', async () => {
  const account = setup(); replay('m-fresh200b');
  markAuthFailed(account);
  expect((await probeAccount(account, async () => 'healthy')).result).toBe('applied');
  expect(accountStatus()[0].authFailedSince).toBeNull();
  expect(accountStatus()[0].authFailedUntil).toBeNull();
});

test('synthetic stale CLI diagnostic cannot fail a replacement login', async () => {
  const account = setup(); replay('m-empty', 'API Error: 401 Invalid bearer token');
  const cli = process.env.CLAUDE_BIN!;
  const replacement = JSON.stringify({ claudeAiOauth: { accessToken: 'NEW', refreshToken: 'R', expiresAt: Date.now() + 3600000 } });
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('process.stdout.write(', `require('node:fs').writeFileSync(${JSON.stringify(join(account.dir, '.credentials.json'))}, ${JSON.stringify(replacement)}); process.stdout.write(`));
  let calls = 0;
  expect((await probeAccount(account, async () => { calls++; return 'healthy'; })).result).toBe('unavailable');
  expect(calls).toBe(1);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

for (const mode of ['expired', 'buffer', 'fresh', 'rotated', 'dead'] as const) test(`captured turn refresh 500 keeps routing cooldown without a login incident: ${mode}`, async () => {
  const { runClaude, closeIdleWorkers } = await import('../src/claude');
  const account = setup({accessToken:'FAKE',refreshToken:'R',expiresAt:Date.now()+(mode === 'expired' ? -3600000 : mode === 'buffer' ? 60000 : 3600000)});
  const fixture = readFileSync(join(import.meta.dir,'fixtures/cli-2.1.302/m-turn-refresh500.jsonl'),'utf8');
  const cli = join(root,'turn-cli');
  writeFileSync(cli, `#!${process.execPath}
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  if (${JSON.stringify(mode)} === 'rotated' || ${JSON.stringify(mode)} === 'dead') {
    require('node:fs').writeFileSync(${JSON.stringify(join(account.dir,'.credentials.json'))}, JSON.stringify({claudeAiOauth:
      ${JSON.stringify(mode)} === 'dead' ? {accessToken:'',refreshToken:'',expiresAt:0} :
      {accessToken:'NEW',refreshToken:'R',expiresAt:Date.now()+3600000}}));
  }
  process.stdout.write(${JSON.stringify(fixture)});
}
`);
  chmodSync(cli,0o755); process.env.CLAUDE_BIN=cli; closeIdleWorkers();
  try {
    await expect(runClaude({model:'sonnet',input:'hello'})).rejects.toThrow();
    expect(accountStatus()[0].authFailedUntil).toBeString();
    if (mode === 'fresh' || mode === 'dead') expect(health.authIncidentId(account)).toBeString();
    else expect(health.authIncidentId(account)).toBeUndefined();
  } finally { closeIdleWorkers(); }
});

// Defensive CLI diagnostics: synthetic events cover older/alternate CLI envelopes.
// Captured 2.1.302 empty reports remain the main regression fixtures above.
for (const source of ['stderr', 'result', 'errors'] as const)
for (const remaining of [3600000, 300000, -1000]) test(`synthetic ${source} auth diagnostic with ${remaining}ms access lifetime`, async () => {
  const account = setup({accessToken:'FAKE',refreshToken:'R',expiresAt:Date.now()+remaining});
  replay('m-empty', source === 'stderr' ? 'API Error: 401 Invalid bearer token' : '');
  if (source !== 'stderr') {
    const cli = process.env.CLAUDE_BIN!;
    const event = {type:'result',is_error:true,...(source === 'result'
      ? {result:'Failed to authenticate. API Error: 401 Invalid bearer token'}
      : {errors:['Not logged in. Run claude auth login.']})};
    writeFileSync(cli,readFileSync(cli,'utf8').replace('process.stdout.write(', `console.log(${JSON.stringify(JSON.stringify(event))}); process.stdout.write(`));
  }
  let calls = 0;
  const result = await probeAccount(account, async () => { calls++; return 'unknown'; });
  if (remaining > 300000) {
    expect(result.result).toStartWith('auth failed since ');
    expect(calls).toBe(0);
  } else {
    expect(result.result).toBe('unavailable');
    expect(calls).toBe(1);
    expect(accountStatus()[0].authFailedSince).toBeNull();
  }
});

test('synthetic bare stderr 429 suppresses validation without rate-limit prose', async () => {
  const account = setup(); replay('m-empty', 'HTTP 429');
  let calls = 0;
  await probeAccount(account, async () => { calls++; return 'failed'; });
  expect(calls).toBe(0);
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('synthetic numeric result 429 suppresses validation', async () => {
  const account = setup(); replay('m-empty');
  const cli = process.env.CLAUDE_BIN!;
  writeFileSync(cli,readFileSync(cli,'utf8').replace('process.stdout.write(', `console.log('{"type":"result","is_error":true,"api_error_status":429}'); process.stdout.write(`));
  let calls = 0;
  await probeAccount(account, async () => { calls++; return 'failed'; });
  expect(calls).toBe(0);
});

test('a report clears a routing-only cooldown with no persisted incident', async () => {
  const account = setup(); replay('m-fresh200b');
  markAuthFailed(account, false);
  expect(accountStatus()[0].authFailedUntil).toBeString();
  expect((await probeAccount(account)).result).toBe('applied');
  expect(accountStatus()[0].authFailedUntil).toBeNull();
});

test('unsupported CLI still detects the dead credential marker', async () => {
  const account = setup({accessToken:'',refreshToken:'',expiresAt:0});
  replay('m-dead');
  const cli = process.env.CLAUDE_BIN!;
  writeFileSync(cli,readFileSync(cli,'utf8').replace('2.1.302 (Claude Code)','2.1.100 (Claude Code)'));
  expect((await probeAccount(account)).result).toStartWith('auth failed since ');
});

test('missing credentials on a previously observed account bypass login grace', async () => {
  setup();
  const dir = join(process.env.PROXY_STATE_DIR!, 'accounts', 'previous');
  mkdirSync(dir,{recursive:true});
  const account = {name:'previous',dir,isDefault:false};
  writeFileSync(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'FAKE',refreshToken:'R'}}));
  health.checkAuthExpiry(account);
  rmSync(join(dir,'.credentials.json'));
  replay('m-empty');
  expect((await probeAccount(account)).result).toStartWith('auth failed since ');
});

test('first successful turn records credentials before any probe and later loss fails immediately', async () => {
  const {runClaude,closeIdleWorkers} = await import('../src/claude');
  setup();
  const dir = join(process.env.PROXY_STATE_DIR!,'accounts','new');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'FAKE',refreshToken:'R'}}));
  process.env.CLAUDE_ACCOUNT_ORDER='new,default';
  const account = listAccounts().find(a => a.name==='new')!;
  const cli = join(root,'success-cli');
  writeFileSync(cli,`#!${process.execPath}
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin}))
 console.log(JSON.stringify({type:'result',is_error:false,structured_output:{text:'ok',tool_calls:[]}}));`);
  chmodSync(cli,0o755); process.env.CLAUDE_BIN=cli; closeIdleWorkers();
  try {
    expect((await runClaude({model:'sonnet',input:'hello'})).account).toBe('new');
    rmSync(join(dir,'.credentials.json'));
    markAuthFailed(account);
    expect(health.authIncidentId(account)).toBeString();
  } finally {closeIdleWorkers();}
});

for (const dead of [false,true]) test(`worker stderr auth prose only persists when credentials are dead: ${dead}`, async () => {
  const {runClaude,closeIdleWorkers} = await import('../src/claude');
  const account = setup(dead ? {accessToken:'',refreshToken:'',expiresAt:0} : undefined);
  const cli=join(root,'helper-stderr');
  writeFileSync(cli,`#!${process.execPath}
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 console.error('Helper failed to authenticate: invalid_grant'); process.exit(1);
}`);
  chmodSync(cli,0o755);process.env.CLAUDE_BIN=cli;closeIdleWorkers();
  try {
    await expect(runClaude({model:'sonnet',input:'hello'})).rejects.toThrow();
    expect(accountStatus()[0].authFailedUntil).toBeString();
    if(dead) expect(health.authIncidentId(account)).toBeString();
    else expect(health.authIncidentId(account)).toBeUndefined();
  } finally {closeIdleWorkers();}
});

test('credential-less named account never spawns a probe CLI', async () => {
  setup(); const dir=join(process.env.PROXY_STATE_DIR!,'accounts','waiting');
  mkdirSync(dir,{recursive:true}); replay('m-empty');
  const account={name:'waiting',dir,isDefault:false};
  const spawn=spyOn(Bun,'spawn');
  try {
    expect((await probeAccount(account)).result).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  } finally {spawn.mockRestore();}
});

for (const observation of ['probe','failure'] as const) test(`credential observation clears missingSince: ${observation}`, () => {
  setup(); const dir=join(process.env.PROXY_STATE_DIR!,'accounts','waiting');
  mkdirSync(dir,{recursive:true});
  const account={name:'waiting',dir,isDefault:false};
  markAuthFailed(account);
  const file=join(process.env.PROXY_STATE_DIR!,'account-auth.json');
  expect(JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,dir])].missingSince).toBeNumber();
  writeFileSync(join(dir,'.credentials.json'),'{}');
  if(observation==='probe') health.checkAuthExpiry(account); else markAuthFailed(account);
  expect(JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,dir])].missingSince).toBeUndefined();
});

test('account remove clears auth health so re-add gets login grace', async () => {
  setup(); const dir=join(process.env.PROXY_STATE_DIR!,'accounts','again');
  mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'.credentials.json'),'{}');
  const account={name:'again',dir,isDefault:false};
  markAuthFailed(account); expect(health.authIncidentId(account)).toBeString();
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../scripts/account.ts'),'remove','again'],{env:process.env,stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(0);
  const file=join(process.env.PROXY_STATE_DIR!,'account-auth.json');
  expect(JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,dir])]).toBeUndefined();
  mkdirSync(dir,{recursive:true});
  markAuthFailed(account);
  expect(health.authIncidentId(account)).toBeUndefined();
});
