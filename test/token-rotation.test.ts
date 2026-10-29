import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIdleWorkers, runClaude } from '../src/claude';
import { accountStatus, isUnavailable, listAccounts, resetAccountState } from '../src/accounts';
const saved = { ...process.env };
let root = '';
afterEach(() => {
  closeIdleWorkers(); resetAccountState();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  if (root) rmSync(root, { recursive: true, force: true });
});
function setup(activeRotation: boolean) {
  root = mkdtempSync(join(tmpdir(), 'rotation-'));
  process.env.PROXY_STATE_DIR = join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'base');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const tokenPath = join(process.env.CLAUDE_CONFIG_DIR, 'oauth-token');
  writeFileSync(tokenPath, 'old-fake-token-for-tests', { mode: 0o600 });
  const cli = join(root, 'cli');
  writeFileSync(cli, `#!${process.execPath}
import {appendFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(join(root, 'launches'))}, 'launch\\n');
let turn = 0;
for await (const line of createInterface({input:process.stdin})) {
  turn++;
  const old = process.env.CLAUDE_CODE_OAUTH_TOKEN === 'old-fake-token-for-tests';
  if (${activeRotation} && turn === 2) writeFileSync(${JSON.stringify(tokenPath)}, 'new-fake-token-for-tests');
  if (old && turn === 2) console.log(JSON.stringify({type:'result', is_error:true, api_error_status:401, result:'invalid authentication credentials'}));
  else console.log(JSON.stringify({type:'result', is_error:false, structured_output:{text:'ok',tool_calls:[]}}));
}
`, { mode: 0o700 });
  process.env.CLAUDE_BIN = cli;
  closeIdleWorkers(); resetAccountState();
  return tokenPath;
}
const first = { model: 'sonnet', input: [{ role: 'user', content: 'hello' }] };
const second = { ...first, input: [...first.input, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'again' }] };
test('parked worker is replaced after token rotation before another turn', async () => {
  const file = setup(false);
  expect((await runClaude(first)).text).toBe('ok');
  writeFileSync(file, 'new-fake-token-for-tests');
  expect((await runClaude(second)).text).toBe('ok');
  expect(readFileSync(join(root, 'launches'), 'utf8')).toBe('launch\nlaunch\n');
  expect(accountStatus()[0].authFailedSince).toBeNull();
  expect(isUnavailable(listAccounts()[0])).toBe(false);
});
test('401 from an active worker using a rotated token cannot block the replacement', async () => {
  setup(true);
  expect((await runClaude(first)).text).toBe('ok');
  await expect(runClaude(second)).rejects.toThrow('invalid authentication credentials');
  expect(accountStatus()[0].authFailedSince).toBeNull();
  expect(isUnavailable(listAccounts()[0])).toBe(false);
});
test('parked login worker is reused after CLI credential refresh', async () => {
  const token = setup(false); rmSync(token);
  const credentials = join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
  const login = (accessToken: string) => JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'fake-refresh' } });
  writeFileSync(credentials, login('fake-before-refresh'));
  expect((await runClaude(first)).text).toBe('ok');
  writeFileSync(credentials, login('fake-after-refresh'));
  expect((await runClaude(second)).text).toBe('ok');
  expect(readFileSync(join(root, 'launches'), 'utf8')).toBe('launch\n');
});
for (const toToken of [false, true]) test(`parked worker is replaced on auth mode change to ${toToken ? 'token' : 'login'}`, async () => {
  const token = setup(false);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-login', refreshToken: 'fake-refresh' } }));
  if (toToken) rmSync(token);
  expect((await runClaude(first)).text).toBe('ok');
  if (toToken) writeFileSync(token, 'new-fake-token-for-tests', { mode: 0o600 });
  else rmSync(token);
  expect((await runClaude(second)).text).toBe('ok');
  expect(readFileSync(join(root, 'launches'), 'utf8')).toBe('launch\nlaunch\n');
});
