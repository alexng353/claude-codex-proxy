import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAuthError, isLimitError } from "./accounts";
import { stateDir } from "./sessions";

export function failureCategory(status: unknown, message: string): string {
  if (isAuthError(status, message)) return "authentication";
  if (isLimitError(status, message)) return "quota";
  if (/Claude CLI timed out/.test(message)) return "timeout";
  return "worker_error";
}

type Failure = {
  event: "failure" | "failover" | "request_failed";
  requestId: string;
  account?: string;
  nextAccount?: string;
  workerId?: string;
  attempt?: number;
  category: string;
  status?: number;
};

/** Store diagnostic metadata only; CLI errors can contain prompts or credentials. */
export function recordFailure(failure: Failure): void {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(stateDir(), "failures.jsonl"), JSON.stringify({
      timestamp: new Date().toISOString(), ...failure,
    }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("Unable to append Claude failure log:", (error as NodeJS.ErrnoException).code ?? "unknown error");
  }
}
