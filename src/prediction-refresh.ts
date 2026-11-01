import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** Demand-driven refresh: readers use the last snapshot without awaiting ingestion. */
export class CorpusRefresh {
  private active = false;
  private last = -Infinity;
  constructor(
    private run: () => Promise<void>,
    private now = Date.now,
  ) {}
  kick(): void {
    const now = this.now();
    if (this.active || now - this.last < 60_000) return;
    this.active = true;
    this.last = now;
    void this.run()
      .catch(() => {})
      .finally(() => {
        this.active = false;
      });
  }
}
const refresh = new CorpusRefresh(async () => {
  const root = join(homedir(), ".local/state/today");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(
    [
      "flock",
      "--nonblock",
      "--no-fork",
      join(root, "prediction-refresh.lock"),
      process.execPath,
      join(import.meta.dir, "../scripts/prediction-refresh.ts"),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
});
export function refreshCorpusInBackground(): void {
  if (hostname() === "forge") refresh.kick();
}
