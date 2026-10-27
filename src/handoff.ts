// alex-0230: two copies of the proxy can run at once while one hands the port to
// the other (reusePort). This is what /health says about this copy, so the handoff
// can check the new one by its own port and confirm what it is running.

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
