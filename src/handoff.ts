// alex-0230: two copies of the proxy can run at once while one hands the port to
// the other (reusePort). This is what /health says about this copy, so the handoff
// can check the new one by its own port and confirm what it is running.
import { readFileSync } from "node:fs";

let draining = false;
let commit: string | undefined;

function gitHead(): string {
  try {
    const run = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir });
    return run.exitCode === 0 ? run.stdout.toString().trim() : "unknown";
  } catch {
    return "unknown";
  }
}

/** The commit this copy started from (`PROXY_COMMIT`, else the checkout's HEAD at start). */
export function runningCommit(): string {
  commit ??= process.env.PROXY_COMMIT || gitHead();
  return commit;
}

export function setDraining(value: boolean): void {
  draining = value;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * The first move off the old single-copy units (alex-0230): `LEGACY_PID` names the
 * old copy, which locks perpetual chats by pid alone and probes without the shared
 * lease. While it runs, this copy takes no chat lock and runs no probe, so the two
 * protocols never share a lock or an account directory.
 */
export function legacyRunning(env: Record<string, string | undefined> = process.env): boolean {
  const pid = Number(env.LEGACY_PID);
  if (!(pid > 0)) return false;
  // LEGACY_STARTTIME (field 22 of /proc/PID/stat) pins the process, so a pid reused
  // after the old copy exits never keeps this one waiting.
  if (env.LEGACY_STARTTIME) return processStartTime(pid) === env.LEGACY_STARTTIME;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process's start time in clock ticks since boot, or undefined if it is gone. */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces; fields restart after its ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

export function healthInfo(pending?: number) {
  return {
    status: "ok",
    commit: runningCommit(),
    pid: process.pid,
    slot: process.env.PROXY_SLOT ?? null,
    draining,
    ...(pending === undefined ? {} : { pending }),
  };
}
