/**
 * Composer predictions from an invisible fork of the chat's own Claude session.
 *
 * When a worker parks after a final answer it records how it was launched. A
 * prediction for that chat then resumes the worker's transcript with
 * `--fork-session --no-session-persistence`, on the worker's own model, system
 * prompt file, output schema and account, so Anthropic's prompt cache for the
 * chat's whole prefix is read rather than written again (the fork adds one user
 * message). Effort may differ: Claude Code sends it outside the cached prefix.
 *
 * One message in, one result out, then the process is killed. The proxy never
 * executes tools, and this path returns text only: an answer with a tool call
 * counts as a failed fork (as Codex's `thread/sample` returns no text for one).
 * Nothing is written to the session map, usage.jsonl, the hygiene gate, the
 * thread's pin or Claude's transcripts; Codex and Today never see the fork.
 */
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, isUnavailable, type Account } from "./accounts";
import { STRIPPED_ENV } from "./claude-env";
import { stateDir } from "./sessions";

export const FORK_PREDICTION_PROMPT = `<composer_prediction>
This message is from Today, not from Alex, and Alex never sees it. Your answer is thrown away unless it is shown to him as a suggestion in his message box.
Predict the next message Alex is most likely to send in this chat, in reply to your last answer. Write it as he would: his words and tone, usually short, casual and lowercase. One line, at most 80 words.
Put only that message in text and leave tool_calls empty. Do not answer it, continue the work, or call tools. If no useful next message is predictable, set text to "".
</composer_prediction>`;

/** Which model predicts: the fork, or Haiku as before. Haiku unless switched on. */
export type PredictionSource = "fork" | "haiku";

/**
 * The switch: `PREDICTION_SOURCE`, else the first line of `prediction-source` in
 * the proxy's state directory. Read on every request, so flipping the file needs
 * no restart. Anything but `fork` means Haiku.
 */
export function predictionSource(): PredictionSource {
  let value = process.env.PREDICTION_SOURCE;
  if (value === undefined) {
    try {
      value = readFileSync(join(stateDir(), "prediction-source"), "utf8").split("\n")[0];
    } catch {
      value = undefined;
    }
  }
  return value?.trim() === "fork" ? "fork" : "haiku";
}

/** How a parked worker was launched, enough to fork its session. */
export type ForkSource = {
  bin: string;
  args: readonly string[];
  sessionId: string;
  account: Account;
  /** The final answer the worker parked with: the fork must resume exactly there. */
  answer: string;
  /** Input tokens of the worker's last request, cached or not: the fork's context size. */
  contextTokens: number;
  parkedAt: number;
};

const MAX_SOURCES = 256;
/** A prediction follows its turn by seconds; an older source is a later turn's past. */
const SOURCE_MAX_AGE_MS = 10 * 60_000;
const sources = new Map<string, ForkSource>();

/**
 * A worker parked for `threadId`. Only a final answer (no tool calls) is a turn
 * Alex can reply to; a tool-call park clears the entry so a prediction never
 * forks a turn that was still working.
 */
export function recordForkSource(threadId: string, source: ForkSource | undefined): void {
  sources.delete(threadId);
  if (!source) return;
  sources.set(threadId, source);
  for (const oldest of sources.keys()) {
    if (sources.size <= MAX_SOURCES) break;
    sources.delete(oldest);
  }
}

function forkSource(threadId: string): ForkSource | undefined {
  const source = sources.get(threadId);
  if (source && Date.now() - source.parkedAt > SOURCE_MAX_AGE_MS) {
    sources.delete(threadId);
    return undefined;
  }
  return source;
}

/** Flags that name the worker's own session; the fork replaces all of them. */
const SESSION_FLAGS_WITH_VALUE = new Set(["--resume", "--session-id", "--resume-session-at"]);
const SESSION_FLAGS = new Set(["--fork-session", "--no-session-persistence"]);

/**
 * The worker's launch arguments with its session flags swapped for a fork of
 * `sessionId` that persists nothing. `checkpoint` is the transcript entry to
 * resume at (the last accepted StructuredOutput result), so a rejected or
 * partial later answer is never part of the fork's context.
 */
export function forkArgs(
  workerArgs: readonly string[],
  sessionId: string,
  checkpoint?: string,
  effort?: string,
): string[] {
  const args: string[] = [];
  for (let index = 0; index < workerArgs.length; index++) {
    const arg = workerArgs[index]!;
    if (SESSION_FLAGS_WITH_VALUE.has(arg)) {
      index++;
      continue;
    }
    if (SESSION_FLAGS.has(arg)) continue;
    args.push(arg);
  }
  const at = args.indexOf("-p");
  args.splice(at < 0 ? 0 : at + 1, 0,
    "--resume", sessionId, "--fork-session", "--no-session-persistence",
    ...(checkpoint ? ["--resume-session-at", checkpoint] : []));
  if (effort) {
    const flag = args.indexOf("--effort");
    if (flag >= 0) args[flag + 1] = effort;
    else args.push("--effort", effort);
  }
  return args;
}

export type ForkUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

/** What a fork produced. `failed` sends the request on to Haiku; `declined` does not.
 * `account` names the subscription account the fork ran on, for quota accounting. */
export type ForkOutcome = (
  | { kind: "suggested"; text: string; usage?: ForkUsage }
  | { kind: "declined"; usage?: ForkUsage }
  | {
      kind: "failed";
      reason: string;
      usage?: ForkUsage;
      /** A fork that ran but reported no usage (cancelled, late, broken) may still have
       * read its whole context: the chat's last context size, an upper bound. */
      unmeteredContextTokens?: number;
    }
) & { account?: string };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Reads Claude Code's final `result` event of a fork. */
export function parseForkResult(event: Record<string, unknown>): ForkOutcome {
  const raw = event.usage as Record<string, unknown> | undefined;
  const usage = raw
    ? {
        inputTokens: count(raw.input_tokens),
        cacheReadTokens: count(raw.cache_read_input_tokens),
        cacheWriteTokens: count(raw.cache_creation_input_tokens),
        outputTokens: count(raw.output_tokens),
      }
    : undefined;
  if (event.is_error) return { kind: "failed", reason: "error", usage };
  let structured = event.structured_output as Record<string, unknown> | undefined;
  if (!structured && typeof event.result === "string") {
    try {
      structured = JSON.parse(event.result);
    } catch {}
  }
  if (!structured || typeof structured.text !== "string") return { kind: "failed", reason: "no answer", usage };
  if (Array.isArray(structured.tool_calls) && structured.tool_calls.length > 0)
    return { kind: "failed", reason: "tool call", usage };
  const text = structured.text.trim();
  if (!text) return { kind: "declined", usage };
  if (text.length > 500 || text.includes("\n")) return { kind: "failed", reason: "not one short line", usage };
  return { kind: "suggested", text, usage };
}

/** Larger chats are slow to answer even from cache; they keep Haiku (measured 2026-11-02). */
const maxContextTokens = () => Number(process.env.PREDICTION_FORK_MAX_CONTEXT_TOKENS ?? 300_000);
/** Unset keeps the chat's own effort: on 2026-11-02 a forced low effort was no faster
 * at the median and had a far longer tail (p90 10.3 s against 4.1 s). */
const forkEffort = () => process.env.PREDICTION_FORK_EFFORT || undefined;

/** Bytes read from a transcript's end for the checkpoint; the answer is its last entries. */
const CHECKPOINT_TAIL_BYTES = 1 << 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the daemon's context for the completed turn ends with this parked answer. */
function endsWithAnswer(context: string | undefined, answer: string): boolean {
  const tail = answer.trim().slice(-2000);
  return !!tail && !!context && context.trimEnd().endsWith(tail);
}

/**
 * The transcript entry to resume at: the accepted StructuredOutput result of `answer`,
 * found in the last MiB of the transcript without blocking the event loop. Anything
 * else (a later answer, a cut line, no transcript) gives undefined, so no fork runs.
 */
async function answerCheckpoint(sessionId: string, answer: string): Promise<string | undefined> {
  if (!UUID.test(sessionId)) return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const path = join(projects, name, `${sessionId}.jsonl`);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      continue;
    }
    const start = Math.max(0, size - CHECKPOINT_TAIL_BYTES);
    const lines = (await Bun.file(path).slice(start, size).text()).split("\n");
    if (start > 0) lines.shift(); // Cut in the middle.
    const outputs = new Map<string, string>();
    let last: { uuid: string; text: string } | undefined;
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      if (entry.type === "assistant" && !entry.isApiErrorMessage) {
        for (const block of content)
          if (block?.type === "tool_use" && block.name === "StructuredOutput")
            outputs.set(block.id, typeof block.input?.text === "string" ? block.input.text : "");
      } else if (entry.type === "user" && typeof entry.uuid === "string" && UUID.test(entry.uuid)) {
        for (const block of content)
          if (block?.type === "tool_result" && !block.is_error && outputs.has(block.tool_use_id))
            last = { uuid: entry.uuid, text: outputs.get(block.tool_use_id)! };
      }
    }
    return last && last.text.trim() === answer.trim() ? last.uuid : undefined;
  }
  return undefined;
}

/**
 * Predict Alex's next message in `threadId` (Codex's thread id, the requests'
 * `prompt_cache_key`) from a fork of its parked session. Never throws.
 */
export async function forkPrediction(
  threadId: string,
  signal: AbortSignal,
  deadlineMs: number,
  /** The daemon's recent context of the completed turn; it must end with the parked answer. */
  context?: string,
): Promise<ForkOutcome> {
  const source = forkSource(threadId);
  if (!source) return { kind: "failed", reason: "no session" };
  // A newer turn may have finished on another proxy copy: fork only the answer Alex saw.
  if (!endsWithAnswer(context, source.answer)) return { kind: "failed", reason: "stale" };
  if (isUnavailable(source.account)) return { kind: "failed", reason: "account unavailable" };
  if (source.contextTokens > maxContextTokens()) return { kind: "failed", reason: "context too large" };
  const checkpoint = await answerCheckpoint(source.sessionId, source.answer);
  if (!checkpoint) return { kind: "failed", reason: "no checkpoint" };
  // Checked after the last await: runFork adds its abort listener before awaiting anything.
  if (signal.aborted) return { kind: "failed", reason: "cancelled" };
  if (deadlineMs <= Date.now()) return { kind: "failed", reason: "timed out" };
  const outcome = await runFork(source, checkpoint, signal, deadlineMs);
  const unmetered = outcome.kind === "failed" && !outcome.usage && outcome.reason !== "spawn";
  return {
    ...outcome,
    ...(unmetered ? { unmeteredContextTokens: source.contextTokens } : {}),
    account: source.account.name,
  };
}

async function runFork(
  source: ForkSource,
  checkpoint: string,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<ForkOutcome> {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    const { CLAUDE_CODE_EFFORT_LEVEL: _effort, ...inherited } = process.env;
    const env: Record<string, string | undefined> = { ...inherited };
    for (const key of STRIPPED_ENV) delete env[key];
    child = Bun.spawn([source.bin, ...forkArgs(source.args, source.sessionId, checkpoint, forkEffort())], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      // Claude Code keys saved sessions by working directory: resume where the worker ran.
      cwd: process.env.CLAUDE_CWD || process.cwd(),
      env: { ...env, ...accountEnv(source.account) },
    });
  } catch {
    return { kind: "failed", reason: "spawn" };
  }
  let stop!: (outcome: ForkOutcome) => void;
  const stopped = new Promise<ForkOutcome>((resolve) => (stop = resolve));
  const onAbort = () => stop({ kind: "failed", reason: "cancelled" });
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop({ kind: "failed", reason: "timed out" }), deadlineMs - Date.now());
  try {
    child.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: FORK_PREDICTION_PROMPT }] } }) + "\n",
    );
    child.stdin.flush();
    return await Promise.race([readResult(child), stopped]);
  } catch {
    return { kind: "failed", reason: "io" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function readResult(child: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<ForkOutcome> {
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += chunk.byteLength;
    if (bytes > 1_000_000) return { kind: "failed", reason: "oversized output" };
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "result") return parseForkResult(event);
    }
  }
  return { kind: "failed", reason: "exited" };
}
