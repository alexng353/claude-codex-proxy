import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountStatus, listAccounts, markAuthFailed, markAuthSucceeded, resetAccountState } from "../src/accounts";
import { authIncidentId, checkAuthExpiry, flushAuthWarnings, startAuthWarnings } from "../src/auth-health";

const env = { ...process.env };
let root = '';
function setup() {
  root = mkdtempSync(join(tmpdir(), 'auth-process-'));
  process.env.PROXY_STATE_DIR = join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'base');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  resetAccountState();
  return listAccounts()[0];
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env); resetAccountState();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until(file: string) {
  for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10);
  expect(existsSync(file)).toBe(true);
}
const modulePath = join(import.meta.dir, '../src/auth-health.ts');
function run(source: string, name: string) {
  const file = join(root, name + '.ts'); writeFileSync(file, source);
  return Bun.spawn([process.execPath, file], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
}

test('incident and delivered state survive a fresh process', async () => {
  const account = setup(); markAuthFailed(account);
  const since = accountStatus()[0].authFailedSince;
  await flushAuthWarnings(async () => true);
  const child = run(`import {authHealth,flushAuthWarnings} from ${JSON.stringify(modulePath)};
  console.log(JSON.stringify(authHealth(${JSON.stringify(account)})));
  await flushAuthWarnings(async()=>{console.log('RESENT');return true});`, 'restart');
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output).authFailedSince).toBe(since);
  expect(output).not.toContain('RESENT');
});

test('sender lease excludes another process for the whole async send', async () => {
  const account = setup(); markAuthFailed(account);
  const entered = join(root, 'entered'), release = join(root, 'release'), sends = join(root, 'sends');
  const imports = `import {flushAuthWarnings} from ${JSON.stringify(modulePath)}; import {existsSync,writeFileSync,appendFileSync} from 'node:fs';`;
  const first = run(`${imports} await flushAuthWarnings(async()=>{appendFileSync(${JSON.stringify(sends)},'first\\n');writeFileSync(${JSON.stringify(entered)},'');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);return true});`, 'first');
  try {
    await until(entered);
    const second = run(`${imports} await flushAuthWarnings(async()=>{appendFileSync(${JSON.stringify(sends)},'second\\n');return true});`, 'second');
    expect(await second.exited).toBe(0);
    expect(readFileSync(sends, 'utf8')).toBe('first\n');
  } finally { writeFileSync(release, ''); await first.exited; }
});

test('new auth locks ignore an unlocked file naming a live bun process', async () => {
  const account = setup(); markAuthFailed(account);
  const child = run('setInterval(()=>{},1000);', 'idle');
  try {
    writeFileSync(join(process.env.PROXY_STATE_DIR!, 'account-auth.json.sender.lock'), String(child.pid));
    let sent = 0;
    await flushAuthWarnings(async () => { sent++; return true; });
    expect(sent).toBe(1);
  } finally { child.kill(); await child.exited; }
});

test('repeated observations do not rewrite state; same name in different dirs stays distinct', () => {
  const account = setup(); markAuthFailed(account);
  const path = join(process.env.PROXY_STATE_DIR!, 'account-auth.json');
  const first = statSync(path).mtimeMs;
  checkAuthExpiry(account); markAuthFailed(account);
  expect(statSync(path).mtimeMs).toBe(first);
  const another = { ...account, dir: join(root, 'another') };
  markAuthFailed(another);
  expect(authIncidentId(another)).not.toBe(authIncidentId(account));
  markAuthSucceeded(another, authIncidentId(another));
  expect(authIncidentId(account)).toBeString();
});

test('real sender adapter sets client identity and removes thread identity', async () => {
  const account = setup(); markAuthFailed(account);
  process.env.CODEX_THREAD_ID = 'must-not-leak';
  const spawn = Bun.spawn;
  let called = 0;
  (Bun as any).spawn = (args: string[], options: any) => {
    called++;
    expect(args.slice(-4)).toEqual(['--client', 'claude-codex-proxy', 'today', '-']);
    expect(options.env.CODEX_THREAD_ID).toBeUndefined();
    return { exited: Promise.resolve(0), kill() {} };
  };
  try { const stop = startAuthWarnings(); await stop(); expect(called).toBe(1); }
  finally { Bun.spawn = spawn; }
});

test('default account login uses plain claude when no config override exists', async () => {
  setup();
  const child = run(`import {mock} from 'bun:test';
    const os = await import('node:os');
    mock.module('node:os',()=>({...os,homedir:()=>${JSON.stringify(root)}}));
    delete process.env.CLAUDE_CONFIG_DIR;
    const {listAccounts,markAuthFailed}=await import(${JSON.stringify(join(import.meta.dir, '../src/accounts.ts'))});
    const {flushAuthWarnings}=await import(${JSON.stringify(modulePath)});
    markAuthFailed(listAccounts()[0]);
    await flushAuthWarnings(async(message)=>{console.log(message);return true});`, 'default-command');
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain('run `claude`, then /login.');
});

test('auxiliary Claude launches strip inherited OAuth tokens before account overrides', async () => {
  setup(); process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-test-token';
  const { claudeClassifier } = await import('../src/hygiene-proof');
  const { claudeRunner } = await import('../src/perpetual/summarizer');
  const spawn = Bun.spawn;
  const seen: Array<Record<string, string>> = [];
  (Bun as any).spawn = (_args: string[], options: any) => { seen.push(options.env); throw new Error('stopped before launch'); };
  try {
    await expect(claudeClassifier({} as any, { kinds: [] })).rejects.toThrow('stopped before launch');
    expect(() => claudeRunner('haiku')('test-thread')).toThrow('stopped before launch');
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.CLAUDE_CODE_OAUTH_TOKEN === undefined)).toBe(true);
  } finally { Bun.spawn = spawn; }
});

test('hysteresis uses a newer delivery recorded by another process', async () => {
  const account = setup(); markAuthFailed(account);
  const now = Date.now();
  await flushAuthWarnings(async () => true);
  const child = run(`import {markAuthFailed,markAuthSucceeded} from ${JSON.stringify(join(import.meta.dir, '../src/accounts.ts'))};
    import {authIncidentId,flushAuthWarnings} from ${JSON.stringify(modulePath)};
    const account=${JSON.stringify(account)};
    Date.now=()=>${now + 6.5 * 3600000};
    markAuthSucceeded(account,authIncidentId(account)); markAuthFailed(account);
    await flushAuthWarnings(async()=>true);`, 'later-delivery');
  expect(await child.exited).toBe(0);
  markAuthSucceeded(account, authIncidentId(account)); markAuthFailed(account);
  const originalNow = Date.now;
  Date.now = () => now + 7 * 3600000;
  let count = 0;
  try { await flushAuthWarnings(async () => { count++; return true; }); }
  finally { Date.now = originalNow; }
  expect(count).toBe(0);
});
