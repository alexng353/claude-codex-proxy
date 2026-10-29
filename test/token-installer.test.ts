import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('README token installer completes in a PTY without echoing its fake token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-installer-'));
  const source = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');
  const block = source.split("python3 - \"$account_dir\" <<'PY'\n")[1].split('\n   PY')[0].split('\n').map(line => line.slice(3)).join('\n');
  const token = 'fake-pty-token-for-testing';
  const expiry = '2030-01-02T03:04:05.123Z';
  const script = `import os, pty, select, sys, time, json
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.executable, [sys.executable, '-c', sys.argv[1], sys.argv[2]])
buffer = b''
steps = [(b'Paste setup token (hidden): ', sys.argv[3]), (b'Known expiry in UTC (ISO timestamp, or blank): ', sys.argv[4])]
deadline = time.monotonic() + 5
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try: data = os.read(fd, 4096)
            except OSError: break
            if not data: break
            buffer += data
            if steps and steps[0][0] in buffer:
                _, answer = steps.pop(0)
                os.write(fd, answer.encode() + b'\\n')
    else:
        os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
    print(json.dumps({'exit': os.waitstatus_to_exitcode(status), 'echoed': sys.argv[3].encode() in buffer}))
finally:
    os.close(fd)
`;
  try {
    const child = Bun.spawn(['python3', '-c', script, block, root, token, expiry], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ exit: 0, echoed: false });
    expect(readFileSync(join(root, 'oauth-token'), 'utf8')).toBe(token + '\n');
    expect(statSync(join(root, 'oauth-token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'oauth-token.expires-at'), 'utf8')).toBe(expiry + '\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
