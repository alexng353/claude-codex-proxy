import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {accountStatus,listAccounts,resetAccountState} from '../src/accounts';
import {credentialStatus,flushAuthWarnings,validateSubscriptionAuth} from '../src/auth-health';
import {probeAccount,resetUsageProbe,startUsageProbe} from '../src/usage-probe';
import {spyOn} from 'bun:test';

const saved={...process.env};
let root='';
const fixture=readFileSync(join(import.meta.dir,'fixtures/cli-2.1.312/meterless-success.jsonl'),'utf8');
function setup({age=3600000,refresh=true,rotate=false,token=false,code=0,stderr=''}={}) {
  root=mkdtempSync(join(tmpdir(),'dead-refresh-'));
  process.env.PROXY_STATE_DIR=join(root,'state'); process.env.CLAUDE_CONFIG_DIR=join(root,'base');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
  const file=join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json');
  const expiresAt=Date.now()-age;
  writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'FAKE',...(refresh?{refreshToken:'FAKE-REFRESH'}:{}),expiresAt}}));
  if(token) writeFileSync(join(process.env.CLAUDE_CONFIG_DIR,'oauth-token'),'FAKE-SETUP-TOKEN',{mode:0o600});
  const cli=join(root,'cli');
  writeFileSync(cli,`#!${process.execPath}
if(process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)');process.exit(0); }
if(${rotate}) require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({claudeAiOauth:{accessToken:'NEW-FAKE',refreshToken:'FAKE-REFRESH',expiresAt:Date.now()+3600000}}));
process.stdout.write(${JSON.stringify(fixture)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`);
  chmodSync(cli,0o755);process.env.CLAUDE_BIN=cli;
  resetAccountState();resetUsageProbe();
  return {account:listAccounts()[0],expiresAt};
}
afterEach(()=>{
  for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k];
  Object.assign(process.env,saved);resetAccountState();resetUsageProbe();
  if(root) rmSync(root,{recursive:true,force:true});
});

test('unchanged long-expired login with meter-less success fails and warns once',async()=>{
  const {account,expiresAt}=setup();
  const before=credentialStatus(account).version;
  let validations=0;
  const outcome=await probeAccount(account,async()=>{validations++;return 'unknown';});
  expect(outcome.result).toStartWith('auth failed since ');
  expect(outcome.reason).toBe(`refresh not renewing; access expired ${new Date(expiresAt).toISOString()}`);
  expect(credentialStatus(account).version).toBe(before);
  expect(validations).toBe(0);
  let sent=0;let message='';
  const send=async(text:string)=>{sent++;message=text;return true;};
  await flushAuthWarnings(send,'arch');
  await probeAccount(account,async()=> 'unknown');
  await flushAuthWarnings(send,'arch');
  expect(sent).toBe(1);
  expect(message).toContain('then /login');
  expect(message).toContain(account.dir);
});

for(const [name,options] of [
  ['refreshed',{rotate:true}],['unexpired',{age:-3600000}],['recently expired',{age:60000}],
  ['no refresh token',{refresh:false}],['token mode',{token:true}],
  ['nonzero exit',{code:1}],['rate limited',{stderr:'HTTP 429'}],
] as const) test(`meter-less success does not invent refresh failure: ${name}`,async()=>{
  const {account}=setup(options);
  await probeAccount(account,async()=> 'unknown');
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('fresh meter-less report explains unavailable without weakening endpoint 401 rule',async()=>{
  const {account}=setup({age:-3600000});
  const outcome=await probeAccount(account,async()=> 'unknown');
  expect(outcome.result).toBe('unavailable');
  expect(outcome.reason).toBe('no meters in /usage report');
});

test('long-expired bearer 401 alone remains unknown',async()=>{
  const {account}=setup();
  expect(await validateSubscriptionAuth(account,async()=>new Response('',{status:401}))).toBe('unknown');
  expect(accountStatus()[0].authFailedSince).toBeNull();
});

test('scheduled probe logs why renewal failed',async()=>{
  setup();
  const output=spyOn(console,'log');
  const stop=startUsageProbe({USAGE_PROBE_INITIAL_DELAY_MS:'0'});
  try {
    for(let i=0;i<100&&!output.mock.calls.some(c=>String(c[0]).startsWith('Usage probe:'));i++) await Bun.sleep(20);
    expect(output.mock.calls.some(c=>String(c[0]).includes('(refresh not renewing; access expired '))).toBe(true);
  } finally {await stop();output.mockRestore();}
});

test('healthy structured meters still apply with old login metadata',async()=>{
  const {account}=setup();
  const text=readFileSync(join(import.meta.dir,'fixtures/cli-2.1.302/m-fresh200b.jsonl'),'utf8').trim().split('\n').map(line=>{
    const event=JSON.parse(line);
    for(const row of event.usage_report?.rate_limits?.limits??[]) row.resets_at=new Date(Date.now()+3600000).toISOString();
    return JSON.stringify(event);
  }).join('\n');
  const cli=process.env.CLAUDE_BIN!;
  writeFileSync(cli,readFileSync(cli,'utf8').replace(JSON.stringify(fixture),JSON.stringify(text)));
  expect((await probeAccount(account,async()=> 'unknown')).result).toBe('applied');
  expect(accountStatus()[0].authFailedSince).toBeNull();
});
