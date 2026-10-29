import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { baseConfigDir, type Account } from './accounts';

type Token = { state: 'present'; token: string; version: string; expiresAt: number | null }
  | { state: 'failed'; version: string; expiresAt: null };
/** Never fall back to login when an installed token is invalid or unreadable. */
export function accountToken(account: Account): Token | undefined {
  // Older handoff slots linked all non-login files into named accounts. Such a
  // link is inherited default auth, not an explicit token for this account.
  if (!account.isDefault) {
    try { if (readlinkSync(join(account.dir, 'oauth-token')) === join(baseConfigDir(), 'oauth-token')) return undefined; } catch {}
  }
  let fd: number;
  try { fd = openSync(join(account.dir, 'oauth-token'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { lstatSync(join(account.dir, 'oauth-token')); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined; }
    }
    return { state: 'failed', version: 'token-unreadable', expiresAt: null };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384 || stat.nlink !== 1 || stat.uid !== process.getuid?.())
      return { state: 'failed', version: 'token-invalid-file', expiresAt: null };
    const token = readFileSync(fd, 'utf8').trim();
    const version = `token:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (!token || /\s|[^\x21-\x7e]/.test(token)) return { state: 'failed', version, expiresAt: null };
    // setup-token is opaque. Only explicitly supplied metadata is an expiry;
    // file mtime is not the token's creation time.
    const expiresAt = readExpiry(join(account.dir, 'oauth-token.expires-at'));
    return { state: 'present', token, version, expiresAt };
  } catch { return { state: 'failed', version: 'token-unreadable', expiresAt: null }; }
  finally { closeSync(fd); }
}

/** Nonblocking and bounded: metadata is optional, never a reason to hang a turn. */
function readExpiry(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64) return null;
    const bytes = Buffer.alloc(65);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 64) return null;
    const date = bytes.subarray(0, size).toString('utf8').trim();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(date) || date.startsWith('0000')) return null;
    const parsed = Date.parse(date);
    const canonical = date.includes('.') ? date : date.replace('Z', '.000Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : null;
  } catch { return null; }
  finally { closeSync(fd); }
}
