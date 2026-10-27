import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldHere, lockOwner, tryLock, unlock, withLock } from "../src/filelock";

// alex-0230: two proxy copies share lock files during a handoff.

const dir = () => mkdtemp(join(tmpdir(), "filelock-"));

/** Another process holding a real flock on `path` until killed. */
async function holder(path: string) {
  // -o: the sleep child does not inherit the lock, so killing flock frees it.
  const other = Bun.spawn(["flock", "-o", path, "sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 100 && tryLock(path).held; i++) {
    unlock(path);
    await Bun.sleep(10);
  }
  return other;
}

test("a free lock is taken with this pid in it, and let go", async () => {
  const path = join(await dir(), "lock");
  expect(tryLock(path).held).toBe(true);
  expect(heldHere(path)).toBe(true);
  expect(lockOwner(path)).toBe(process.pid);
  expect(tryLock(path).held).toBe(true); // re-taking our own adds a hold
  unlock(path);
  expect(heldHere(path)).toBe(true); // one hold left
  unlock(path);
  expect(heldHere(path)).toBe(false);
  expect(lockOwner(path)).toBeUndefined();
});

test("another process's lock holds until that process dies", async () => {
  const path = join(await dir(), "lock");
  const other = await holder(path);
  expect(tryLock(path).held).toBe(false);
  other.kill("SIGKILL");
  await other.exited;
  expect(tryLock(path).held).toBe(true);
  unlock(path);
});

test("a pre-flock copy's pid lock is honoured while it runs", async () => {
  const path = join(await dir(), "lock");
  const legacy = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
  writeFileSync(path, String(legacy.pid));
  expect(tryLock(path)).toEqual({ held: false, owner: legacy.pid });
  legacy.kill();
  await legacy.exited;
  expect(tryLock(path).held).toBe(true);
  unlock(path);
});

test("a pid left behind by a holder that died does not block", async () => {
  const path = join(await dir(), "lock");
  const other = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] }); // alive, not a proxy copy
  writeFileSync(path, String(other.pid));
  expect(tryLock(path).held).toBe(true);
  unlock(path);
  other.kill();
});

test("withLock waits for another process, then runs", async () => {
  const path = join(await dir(), "lock");
  const other = await holder(path);
  expect(() => withLock(path, () => 1, 50)).toThrow(/busy/);
  other.kill("SIGKILL");
  await other.exited;
  expect(withLock(path, () => 2, 50)).toBe(2);
  expect(heldHere(path)).toBe(false);
});
