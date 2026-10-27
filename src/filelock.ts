import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";

/**
 * Locks shared between processes (alex-0230: two proxy copies run at once during a
 * handoff). Each is a kernel flock(2) on a file that is never deleted, so the kernel
 * drops it when its owner exits or dies: there is no stale lock to reclaim, and so no
 * reclaim race. The file holds the owner's pid while held (empty once let go), for
 * messages, and for copies from before flock, which locked by pid alone.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const libc = dlopen("libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** Locks this process holds: path -> the open file the flock is on, and how many holds. */
const held = new Map<string, { fd: number; holds: number }>();
// Clear the pid from every held lock on the way out (the kernel drops the flocks).
process.on("exit", () => {
  for (const { fd } of held.values())
    try {
      ftruncateSync(fd, 0);
    } catch {}
});

/** Whether this process holds `path`. */
export const heldHere = (path: string): boolean => held.has(path);

export function processAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a lock file names, or undefined when it names none. */
export function lockOwner(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pre-flock proxy copy (still running during the first move) holds a lock by
 * writing its pid. Honour that while that pid is still a bun process; a pid left by
 * a flock owner that died is not, unless the pid was reused by another bun.
 */
function legacyHolder(pid: number | undefined): boolean {
  if (!pid || pid === process.pid || !processAlive(pid)) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("bun");
  } catch {
    return true;
  }
}

/**
 * Takes `path` for this process unless another process holds it, without waiting.
 * Re-taking a lock this process holds succeeds and adds a hold; it is let go when
 * every hold has been given back with `unlock`.
 */
export function tryLock(path: string): { held: true } | { held: false; owner?: number } {
  const mine = held.get(path);
  if (mine) {
    mine.holds++;
    return { held: true };
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return { held: false, owner: lockOwner(path) };
  }
  const named = lockOwner(path);
  if (legacyHolder(named)) {
    closeSync(fd); // drops the flock
    return { held: false, owner: named };
  }
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid), 0);
  held.set(path, { fd, holds: 1 });
  return { held: true };
}

/** Gives back one hold on `path`; the lock goes with the last. */
export function unlock(path: string): void {
  const mine = held.get(path);
  if (!mine) return;
  if (--mine.holds > 0) return;
  held.delete(path);
  try {
    ftruncateSync(mine.fd, 0);
  } catch {}
  closeSync(mine.fd); // drops the flock
}

/**
 * Runs `fn` holding `path`, waiting up to `waitMs` for another process to let go.
 * Throws when the wait runs out. For short synchronous critical sections (it blocks).
 */
export function withLock<T>(path: string, fn: () => T, waitMs = 2000): T {
  const until = Date.now() + waitMs;
  for (;;) {
    if (tryLock(path).held) break;
    if (Date.now() >= until) throw new Error(`lock ${path} is busy`);
    Bun.sleepSync(5);
  }
  try {
    return fn();
  } finally {
    unlock(path);
  }
}
