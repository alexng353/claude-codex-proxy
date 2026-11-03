import { readFileSync } from "node:fs";

// A process can be reaped between an existence check and the read of its
// /proc entry; that read then throws ESRCH or ENOENT. Both mean it is gone,
// which is what these tests want, so they count as not alive.
export function processAlive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "ENOENT") return false;
    throw e;
  }
  return !stat.includes(") Z ");
}

// A SIGKILLed process can still read as running for a moment after the kill
// returns. Poll until it is gone or the deadline passes; true means gone.
export async function waitGone(pid: number, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (processAlive(pid)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

// Cleanup kill that tolerates the process having exited meanwhile.
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
