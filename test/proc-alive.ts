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
