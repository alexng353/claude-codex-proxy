import { expect, test } from 'bun:test';
import { createScrubber, defaultSecretFiles, loadSecretEntries } from '../src/scrub.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const key = 'CLAUDE_CODE_OAUTH_TOKEN';
const token = 'opaque-fake-test-token';
const marker = '[REDACTED:CLAUDE_CODE_OAUTH_TOKEN]';
const scrub = createScrubber({ files: [] }).scrub;
for (const text of [
  `{ ${key}: token.token }`, `${key}=$(cat ~/.claude/oauth-token)`, `${key}=\${token}`,
  `${key}=someLongVariableName`, `${key}: this is an explanation about tokens`,
  `${key}=\nnext_command=unchanged123456789`, JSON.stringify({ [key]: 'opaque' }),
  `${key}="some prose with spaces"`, `${key}=config.credentials.accessToken`,
]) test(`token scrub preserves code or prose: ${text}`, () => expect(scrub(text)).toBe(text));
for (const [input, output] of [
  [`${key}=${token} claude`, `${key}=${marker} claude`],
  [`${key}='${token}' claude`, `${key}='${marker}' claude`],
  [`${key}="${token}"; next`, `${key}="${marker}"; next`],
  [JSON.stringify({ [key]: token }), JSON.stringify({ [key]: marker })],
  [`{"${key}":"opaque\\u002dfake-test-token"}`, JSON.stringify({ [key]: marker })],
  [JSON.stringify(JSON.stringify({ [key]: token })), JSON.stringify(JSON.stringify({ [key]: marker }))],
  [`${key}='opaque-fake-'"test-token" claude`, `${key}='${marker}' claude`],
  [`${key}=${marker}`, `${key}=${marker}`],
]) test(`token scrub preserves delimiters: ${input}`, () => {
  expect(scrub(input)).toBe(output);
  expect(scrub(scrub(input))).toBe(output);
  if (input.startsWith('{') || input.startsWith('"')) expect(() => JSON.parse(scrub(input))).not.toThrow();
});
test('token scrub discovers bare account token files including overridden paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'token-scrub-'));
  const env = { CLAUDE_CONFIG_DIR: join(root, 'base'), PROXY_STATE_DIR: join(root, 'state') };
  const files = [join(env.CLAUDE_CONFIG_DIR, 'oauth-token'), join(env.PROXY_STATE_DIR, 'accounts/extra/oauth-token')];
  try {
    for (const file of files) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, token, { mode: 0o600 }); }
    expect(loadSecretEntries(files[0])).toEqual([[key, token]]);
    const defaults = defaultSecretFiles(env);
    expect(defaults).toContain(files[0]);
    expect(defaults).toContain(join(env.PROXY_STATE_DIR, 'accounts/*/oauth-token'));
    expect(createScrubber({ files: defaults.filter(p => p.startsWith(root)) }).scrub(`bare ${token}`)).toBe(`bare ${marker}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
