import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeResult } from "./types";

export function recordUsage(
  result: ClaudeResult,
  metadata: {
    requestId: string;
    workerId: string;
    workerTurn: number;
    model: string;
    effort?: string;
    attempt: number;
    launchMode: string;
    resumed: boolean;
  },
): void {
  const directory =
    process.env.PROXY_STATE_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
      "claude-codex-proxy",
    );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(directory, "usage.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...metadata,
        isError: result.is_error,
        subtype: result.subtype,
        usage: result.usage ?? null,
        modelUsage: result.modelUsage ?? null,
      }) + "\n",
      { mode: 0o600 },
    );
  } catch (error) {
    // Telemetry must not drop a completed model response. Do not log prompt content.
    console.error(
      "Unable to append Claude usage log:",
      (error as NodeJS.ErrnoException).code ?? "unknown error",
    );
  }
}
