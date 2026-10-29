import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account } from './accounts';

type Token = { state: 'present'; token: string; version: string; expiresAt: number | null }
  | { state: 'failed'; version: string; expiresAt: null };
/** Never fall back to login when an installed token is invalid or unreadable. */
export function accountToken(account: Account): Token | undefined {
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
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384)
      return { state: 'failed', version: 'token-invalid-file', expiresAt: null };
    const token = readFileSync(fd, 'utf8').trim();
    const version = `token:${createHash('sha256').update(token).digest('hex')}`;
    if (!token || /\s|[^\x21-\x7e]/.test(token)) return { state: 'failed', version, expiresAt: null };
    // setup-token is opaque. Only explicitly supplied metadata is an expiry;
    // file mtime is not the token's creation time.
    let expiresAt: number | null = null;
    try {
      const date = readFileSync(join(account.dir, 'oauth-token.expires-at'), 'utf8').trim();
      const parsed = /^\d{4}-\d\d-\d\dT.*Z$/.test(date) ? Date.parse(date) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) expiresAt = parsed;
    } catch {}
    return { state: 'present', token, version, expiresAt };
  } catch { return { state: 'failed', version: 'token-unreadable', expiresAt: null }; }
  finally { closeSync(fd); }
}
