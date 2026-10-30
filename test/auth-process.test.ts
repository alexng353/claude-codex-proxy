import { afterEach, expect, test, spyOn } from "bun:test";
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
  const first = statSync(path).ino;
  checkAuthExpiry(account); markAuthFailed(account);
  expect(statSync(path).ino).toBe(first);
  const another = { ...account, dir: join(root, 'another') };
  markAuthFailed(another);
  expect(authIncidentId(another)).not.toBe(authIncidentId(account));
  markAuthSucceeded(another, authIncidentId(another));
  expect(authIncidentId(account)).toBeString();
});

// The hygiene gate exempts a bare tag no more: the warning must come in Today's
// script envelope (script:claude-codex-proxy), or an armed gate would answer it.
test('real sender adapter sends as a script and removes thread identity', async () => {
  const account = setup(); markAuthFailed(account);
  process.env.CODEX_THREAD_ID = 'must-not-leak';
  const stripped = ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'];
  for (const key of stripped) process.env[key] = 'test-only-inherited';
  const spawn = Bun.spawn;
  let called = 0;
  let captured: {args: string[], env: any} | undefined;
  (Bun as any).spawn = (args: string[], options: any) => {
    called++;
    captured = { args, env: options.env };
    return { exited: Promise.resolve(0), kill() {} };
  };
  try { const stop = startAuthWarnings(); await stop(); expect(called).toBe(1);
    expect(captured!.args.slice(-4)).toEqual(['--from', 'claude-codex-proxy', 'today', '-']);
    expect(captured!.args[0]).toBe(process.env.TODAY_DAEMON_BIN!);
    expect(captured!.env.CODEX_THREAD_ID).toBeUndefined();
    for (const key of stripped) expect(captured!.env[key]).toBeUndefined(); }
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

test('success clears local cooldown after another process cleared the same incident', async () => {
  const account = setup(); markAuthFailed(account);
  const id = authIncidentId(account);
  const child = run(`import {clearAuthIncident} from ${JSON.stringify(modulePath)};
    clearAuthIncident(${JSON.stringify(account)}, ${JSON.stringify(id)});`, 'clear-incident');
  expect(await child.exited).toBe(0);
  expect(authIncidentId(account)).toBeUndefined();
  markAuthSucceeded(account, id);
  expect(accountStatus()[0].authFailedUntil).toBeNull();
});

test('legacy name-keyed incidents and delivery history migrate without losing dedupe', async () => {
  const account = setup();
  const file = join(process.env.PROXY_STATE_DIR!, 'account-auth.json');
  mkdirSync(process.env.PROXY_STATE_DIR!, {recursive:true});
  writeFileSync(file,JSON.stringify({default:{dir:account.dir,failure:{id:'old-id',since:'2026-10-28T00:00:00Z',delivered:true},
    lastSent:{at:Date.now(),credentials:'legacy'}}}));
  expect(authIncidentId(account)).toBe('old-id');
  let sends = 0;
  await flushAuthWarnings(async () => { sends++; return true; });
  expect(sends).toBe(0);
  checkAuthExpiry(account);
  const state = JSON.parse(readFileSync(file,'utf8'));
  expect(state[JSON.stringify(['default',account.dir])].failure.id).toBe('old-id');
  expect(state[JSON.stringify(['default',account.dir])].lastSent.failure.credentials).toBe('legacy');
  expect(state[JSON.stringify(['default',account.dir])].lastSent.expiry).toBeUndefined();
});

test('legacy expiry delivery does not suppress a pending failure with matching credentials', async () => {
  const {credentialStatus} = await import('../src/auth-health');
  const account = setup();
  const expiry = Date.now()+86400000;
  writeFileSync(join(account.dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{refreshTokenExpiresAt:expiry}}));
  const file = join(process.env.PROXY_STATE_DIR!,'account-auth.json');
  mkdirSync(process.env.PROXY_STATE_DIR!,{recursive:true});
  writeFileSync(file,JSON.stringify({default:{dir:account.dir,
    expiry:{id:'delivered-expiry',since:new Date().toISOString(),expiresAt:expiry,delivered:true},
    failure:{id:'pending-failure',since:new Date().toISOString()},
    lastSent:{at:Date.now(),credentials:credentialStatus(account).version}}}));
  const messages: string[] = [];
  await flushAuthWarnings(async text => {messages.push(text);return true;});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('authentication failed');
});

test('every Claude launcher strips every inherited credential variable', async () => {
  setup();
  const keys = ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_EFFORT_LEVEL'];
  for(const key of keys) process.env[key]='test-only-inherited';
  const {claudeClassifier}=await import('../src/hygiene-proof');
  const {claudeRunner}=await import('../src/perpetual/summarizer');
  const {runClaude,closeIdleWorkers}=await import('../src/claude');
  const {probeAccount,resetUsageProbe}=await import('../src/usage-probe');
  closeIdleWorkers(); resetUsageProbe();
  const spawn=Bun.spawn; const seen: any[]=[];
  (Bun as any).spawn=(_args:any,options:any)=>{seen.push(options.env);throw new Error('boundary stopped');};
  try {
    await expect(runClaude({model:'sonnet',input:'hello'})).rejects.toThrow('boundary stopped');
    await expect(claudeClassifier({} as any,{kinds:[]})).rejects.toThrow('boundary stopped');
    expect(()=>claudeRunner('haiku')('test-thread')).toThrow('boundary stopped');
    await expect(probeAccount(listAccounts()[0])).rejects.toThrow('boundary stopped');
    expect(seen).toHaveLength(4);
    for(const child of seen) for(const key of keys.slice(0,6)) expect(child[key]).toBeUndefined();
    for(const child of seen.slice(0,3)) expect(child.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  } finally {Bun.spawn=spawn;closeIdleWorkers();resetUsageProbe();}
});

test('account replacement resets delivery hysteresis across processes and locally', async () => {
  const {forgetAccountAuth}=await import('../src/auth-health');
  setup(); const dir=join(process.env.PROXY_STATE_DIR!,'accounts','reborn');
  mkdirSync(dir,{recursive:true});
  const account={name:'reborn',dir,isDefault:false};
  let sent=0; const send=async()=>{sent++;return true;};
  const originalNow=Date.now; let now=originalNow();
  Date.now=()=>now;
  try {
    markAuthFailed(account); now+=16*60000; markAuthFailed(account); await flushAuthWarnings(send);
    expect(sent).toBe(1);
    const child=run(`import {forgetAccountAuth} from ${JSON.stringify(modulePath)};forgetAccountAuth(${JSON.stringify(account)});`,'forget');
    expect(await child.exited).toBe(0);
    markAuthFailed(account); now+=16*60000; markAuthFailed(account); await flushAuthWarnings(send);
    expect(sent).toBe(2);
    forgetAccountAuth(account);
    markAuthFailed(account); now+=16*60000; markAuthFailed(account); await flushAuthWarnings(send);
    expect(sent).toBe(3);
  } finally {Date.now=originalNow;}
});

test('late probe observations never recreate removed account state', async () => {
  const {forgetAccountAuth,recordCredentialObservation}=await import('../src/auth-health');
  const {probeAccount}=await import('../src/usage-probe');
  setup(); const account={name:'gone',dir:join(root,'gone'),isDefault:false};
  mkdirSync(account.dir);writeFileSync(join(account.dir,'.credentials.json'),'{}');
  markAuthFailed(account);forgetAccountAuth(account);rmSync(account.dir,{recursive:true});
  checkAuthExpiry(account);markAuthFailed(account);recordCredentialObservation(account,"fake-version");await probeAccount(account);
  const state=JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!,'account-auth.json'),'utf8'));
  expect(state[JSON.stringify([account.name,account.dir])]).toBeUndefined();
});

for(const incident of [false,true]) test(`flush removes gone account health even without an incident: ${incident}`,async()=>{
  setup();const dir=join(process.env.PROXY_STATE_DIR!,'accounts','gone');mkdirSync(dir,{recursive:true});
  const account={name:'gone',dir,isDefault:false};
  if(incident) {writeFileSync(join(dir,'.credentials.json'),'{}');markAuthFailed(account);} else checkAuthExpiry(account);
  rmSync(dir,{recursive:true});
  await flushAuthWarnings(async()=>true);
  expect(JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!,'account-auth.json'),'utf8'))[JSON.stringify([account.name,dir])]).toBeUndefined();
});

test('failed removed-account cleanup does not abort warning flush',async()=>{
  setup();const dir=join(process.env.PROXY_STATE_DIR!,'accounts','gone');mkdirSync(dir,{recursive:true});
  const account={name:'gone',dir,isDefault:false};
  writeFileSync(join(dir,'.credentials.json'),'{}');markAuthFailed(account);rmSync(dir,{recursive:true});
  markAuthFailed(listAccounts()[0]);
  const next=join(process.env.PROXY_STATE_DIR!,`account-auth.json.${process.pid}.next`);mkdirSync(next);
  let sent=0;
  await expect(flushAuthWarnings(async()=>{sent++;return true;})).resolves.toBeUndefined();
  expect(sent).toBe(1);
});

test('account remove reports corrupt auth state without a stack trace',async()=>{
  setup();const dir=join(process.env.PROXY_STATE_DIR!,'accounts','bad');mkdirSync(dir,{recursive:true});
  writeFileSync(join(process.env.PROXY_STATE_DIR!,'account-auth.json'),'{broken');
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../scripts/account.ts'),'remove','bad'],{env:process.env,stdout:'pipe',stderr:'pipe'});
  const error=await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(error).toContain('Unable to remove authentication state for account bad');
  expect(error).not.toContain('at ');
});

test('unreadable auth state skips repeated turn observations without logging',async()=>{
  const {recordCredentialObservation}=await import('../src/auth-health');
  const account=setup();mkdirSync(process.env.PROXY_STATE_DIR!,{recursive:true});
  writeFileSync(join(process.env.PROXY_STATE_DIR!,'account-auth.json'),'{broken');
  const log=spyOn(console,'error');
  try {
    recordCredentialObservation(account,'fake-version');
    recordCredentialObservation(account,'fake-version');
    expect(log).not.toHaveBeenCalled();
  } finally {log.mockRestore();}
});

for(const kind of ['both','neither'] as const) test(`legacy delivery migration handles ${kind} incidents`,async()=>{
  const account=setup();mkdirSync(process.env.PROXY_STATE_DIR!,{recursive:true});
  const file=join(process.env.PROXY_STATE_DIR!,'account-auth.json');
  const incidents=kind==='both'? {failure:{id:'f',since:'now',delivered:true},expiry:{id:'e',since:'now',delivered:true,expiresAt:Date.now()+86400000}}:{};
  writeFileSync(file,JSON.stringify({default:{dir:account.dir,...incidents,lastSent:{at:Date.now(),credentials:'old'}}}));
  checkAuthExpiry(account);
  const health=JSON.parse(readFileSync(file,'utf8'))[JSON.stringify(['default',account.dir])];
  if(kind==='both') {
    expect(health.lastSent.failure.credentials).toBe('old');
    expect(health.lastSent.expiry.credentials).toBe('old');
  } else expect(health.lastSent).toBeUndefined();
});

test('legacy record recreation adopts a fresh persisted generation',async()=>{
  const account=setup();
  const file=join(process.env.PROXY_STATE_DIR!,'account-auth.json');
  mkdirSync(process.env.PROXY_STATE_DIR!,{recursive:true});
  const createLegacy=(id:string)=>writeFileSync(file,JSON.stringify({default:{dir:account.dir,failure:{id,since:new Date().toISOString()}}}));
  createLegacy('first');
  let sent=0;const send=async()=>{sent++;return true;};
  await flushAuthWarnings(send);
  const first=JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,account.dir])].generation;
  const child=run(`import {forgetAccountAuth} from ${JSON.stringify(modulePath)};forgetAccountAuth(${JSON.stringify(account)});`,'legacy-remove');
  expect(await child.exited).toBe(0);
  createLegacy('replacement'); // Older handoff slot creates a record with no generation.
  expect(authIncidentId(account)).toBe('replacement');
  const adopted=JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,account.dir])];
  expect(adopted.generation).toBeString();
  expect(adopted.generation).not.toBe(first);
  expect(authIncidentId(account)).toBe('replacement');
  expect(JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,account.dir])].generation).toBe(adopted.generation);
  await flushAuthWarnings(send);
  expect(sent).toBe(2);
});

for(const operation of ['turn','failure','expiry'] as const) test(`removal while acquiring state lock cannot recreate account: ${operation}`,async()=>{
  const health=await import('../src/auth-health');
  const locks=await import('../src/filelock');
  setup();
  const account={name:'removed',dir:join(root,'removed'),isDefault:false};
  mkdirSync(account.dir);writeFileSync(join(account.dir,'.credentials.json'),'{}');
  mkdirSync(process.env.PROXY_STATE_DIR!,{recursive:true});
  const file=join(process.env.PROXY_STATE_DIR!,'account-auth.json');writeFileSync(file,'{}');
  const original=locks.withLock;
  let reached=false;
  const lock=spyOn(locks,'withLock').mockImplementation(((path:string,fn:()=>unknown,timeout:number,legacy:boolean)=>original(path,()=>{
    if(path===file+'.lock') {reached=true;rmSync(account.dir,{recursive:true,force:true});}
    return fn();
  },timeout,legacy)) as typeof locks.withLock);
  try {
    if(operation==='turn') health.recordCredentialObservation(account,'fake-version');
    else if(operation==='failure') health.recordAuthFailure(account);
    else health.checkAuthExpiry(account);
  } finally {lock.mockRestore();}
  expect(reached).toBe(true);
  expect(JSON.parse(readFileSync(file,'utf8'))[JSON.stringify([account.name,account.dir])]).toBeUndefined();
});

test('send finishing after account replacement cannot attach old delivery history',async()=>{
  const {forgetAccountAuth}=await import('../src/auth-health');
  setup();const dir=join(process.env.PROXY_STATE_DIR!,'accounts','replacement');
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'.credentials.json'),'{}');
  const account={name:'replacement',dir,isDefault:false};markAuthFailed(account);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let sent=0;
  const flushing=flushAuthWarnings(async()=>{sent++;entered();await gate;return true;});
  await started;
  forgetAccountAuth(account);rmSync(dir,{recursive:true});
  mkdirSync(dir);writeFileSync(join(dir,'.credentials.json'),'{}');markAuthFailed(account);
  release();await flushing;
  const state=JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!,'account-auth.json'),'utf8'))[JSON.stringify([account.name,dir])];
  expect(state.lastSent).toBeUndefined();
  expect(state.failure.delivered).toBeUndefined();
  await flushAuthWarnings(async()=>{sent++;return true;});
  expect(sent).toBe(2);
});

function warningTransport(localError = 'today-daemon send: this daemon has no Today thread', localCode = 1) {
  const daemon = join(root, 'today-daemon');
  const ssh = join(root, 'ssh');
  process.env.TODAY_DAEMON_BIN = daemon;
  process.env.TODAY_WARNING_SSH = 'forge';
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.WARNING_TEST_ROOT = root;
  writeFileSync(daemon, `#!${process.execPath}\nawait Bun.stdin.text(); console.error(${JSON.stringify(localError)}); process.exit(${localCode});\n`, { mode: 0o700 });
  writeFileSync(ssh, `#!${process.execPath}
import {appendFileSync, existsSync} from 'node:fs';
const root = process.env.WARNING_TEST_ROOT;
appendFileSync(root + '/ssh-calls', JSON.stringify({args: process.argv.slice(2), message: await Bun.stdin.text(), thread: process.env.CODEX_THREAD_ID}) + '\\n');
process.exit(existsSync(root + '/fail-ssh') ? 1 : 0);
`, { mode: 0o700 });
  return () => existsSync(join(root, 'ssh-calls'))
    ? readFileSync(join(root, 'ssh-calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}
async function flushRealSender() { await startAuthWarnings()(); }

test('no Today thread falls back over SSH and persists delivery once', async () => {
  const account = setup(); markAuthFailed(account);
  const calls = warningTransport();
  process.env.CODEX_THREAD_ID = 'must-not-leak';
  await flushRealSender();
  await flushRealSender();
  expect(calls()).toHaveLength(1);
  expect(calls()[0].args.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '--', 'forge']);
  expect(calls()[0].args[4]).toContain('--from claude-codex-proxy today -');
  expect(calls()[0].thread).toBeUndefined();
  expect(calls()[0].message).toContain('authentication failed since');
  const state = JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!, 'account-auth.json'), 'utf8'));
  expect(state[JSON.stringify([account.name, account.dir])].failure.delivered).toBe(true);
  const child = run(`import {startAuthWarnings} from ${JSON.stringify(modulePath)}; await startAuthWarnings()();`, 'retry-warning');
  expect(await child.exited).toBe(0);
  expect(calls()).toHaveLength(1);
});

test('SSH warning failure logs once and retries until delivery succeeds', async () => {
  const account = setup(); markAuthFailed(account);
  const calls = warningTransport();
  writeFileSync(join(root, 'fail-ssh'), '');
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await flushRealSender(); await flushRealSender();
    expect(calls()).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
    rmSync(join(root, 'fail-ssh'));
    await flushRealSender(); await flushRealSender();
    expect(calls()).toHaveLength(3);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});

for (const [error, code] of [['connection refused', 1], ['this daemon has no Today thread', 0]] as const) {
  test(`SSH warning fallback is skipped for local result ${code}: ${error}`, async () => {
    const account = setup(); markAuthFailed(account);
    const calls = warningTransport(error, code);
    await flushRealSender();
    expect(calls()).toHaveLength(0);
  });
}

test('no Today thread without a configured fallback stays undelivered', async () => {
  const account = setup(); markAuthFailed(account);
  const calls = warningTransport(); delete process.env.TODAY_WARNING_SSH;
  await flushRealSender();
  expect(calls()).toHaveLength(0);
  const state = JSON.parse(readFileSync(join(process.env.PROXY_STATE_DIR!, 'account-auth.json'), 'utf8'));
  expect(state[JSON.stringify([account.name, account.dir])].failure.delivered).toBeUndefined();
});
