import { normalizeContext } from "./context.mjs";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  accountEnv,
  listAccounts,
  isLimitError,
  isUnavailable,
  isAuthError,
  markAuthFailed,
  markLimited,
  observeRateLimit,
  pickAccount,
  soonestAccount,
  type Account,
} from "./accounts";
import { recordUsage } from "./usage";
import { failureCategory, recordFailure } from "./failures";
import { normalizeVisualizeReferences } from "./visualize";
import {
  estimateRequestTokens,
  estimateVisibleTokens,
  fitReplay,
  promptTooLong,
  replayBudget,
  replayTokens,
  retryBudget,
} from "./budget";
import {
  findSessions,
  threadAccount,
  claimThreadAccount,
  pinThreadAccount,
  pruneSessions,
  registerSession,
  resumeCheckpoint,
  saveSession,
  stateDir,
  type SessionKey,
} from "./sessions";
import {
  conversationRequest,
  deltaRequest,
  isCompactionRequest,
  outputSchema,
  prepareClaudePrompt,
  requestTools,
  stableJson,
  systemContext,
  textFromContent,
  toolDescriptors,
  validateCompactionItems,
  type ClaudeInputBlock,
} from "./request";
import type {
  ClaudeResult,
  ProxyOutput,
  ResponseInputItem,
  ResponsesRequest,
} from "./types";

const MODEL_ALIASES: Record<string, string> = {
  "claude-opus": "opus",
  "claude-sonnet": "sonnet",
  "claude-haiku": "haiku",
};

const CODEX_TOOL_SYSTEM_PROMPT = `You are running inside a Codex agent loop. Tools described in <available_tools> are real, available Codex tools even though they are not present in Claude Code's native tool registry. Invoke them by returning their exact name and arguments in the required structured tool_calls output. Never claim that a listed Codex tool is unavailable merely because it is absent from the native registry. When a Codex browser, node_repl, cua_repl, or computer tool is listed, use it for browser requests instead of substituting WebFetch, web search, curl, or another native tool.`;

/** How many times one answer may be sent back to its worker for correction. */
const MAX_CORRECTIONS = 2;

const COMPACTION_CORRECTION: Correction = {
  message: `<compaction_error>\nNo tools were executed. This turn must produce only the handoff summary: put all of it in text and leave tool_calls empty.\n</compaction_error>`,
  failure: "Claude CLI did not return a compaction summary",
};

export function resolveModel(model: string): string {
  const resolved = MODEL_ALIASES[model] ?? model;
  if (
    !/^[a-zA-Z0-9._-]+$/.test(resolved) ||
    (!resolved.startsWith("claude-") &&
      !["opus", "sonnet", "haiku"].includes(resolved))
  ) {
    // Never substitute a Claude model. Name where the request should have gone.
    const hint = model.startsWith("gpt-")
      ? " This endpoint serves only Claude; OpenAI models route through the openai provider."
      : "";
    throw new Error(`Unsupported Claude model: ${model}.${hint}`);
  }
  return resolved;
}

// Exact desktop models whose picker offers effort, so an unset effort means the picker default.
const MEDIUM_DEFAULT_MODELS = new Set([
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

export function resolveEffort(request: ResponsesRequest): string | undefined {
  const effort = request.reasoning?.effort;
  if (effort === undefined)
    return MEDIUM_DEFAULT_MODELS.has(request.model) ? "medium" : undefined;
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new Error(`Unsupported Claude effort: ${effort}`);
  return effort;
}

/** A fresh session, or a fork of a persisted one (`--resume` + `--fork-session`
 * so concurrent continuations of one history never share a transcript). */
export type SessionLaunch = { id: string; resumeFrom?: string; resumeAt?: string };

/** Identifies a Codex request in usage records. */
export type TurnContext = {
  requestId: string;
  threadId?: string;
  pinnedAccount?: string;
  /** The account that produced the latest result for this request. */
  account?: Account;
};

export function buildClaudeArgs(
  request: ResponsesRequest,
  session?: SessionLaunch,
): string[] {
  const effort = resolveEffort(request);
  return [
    ...(effort ? ["--effort", effort] : []),
    "-p",
    "--dangerously-skip-permissions",
    ...sessionArgs(session),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    resolveModel(request.model),
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "",
    "--system-prompt-file",
    systemPromptFile(request),
    "--json-schema",
    JSON.stringify(outputSchema(request.tools ?? [])),
  ];
}

function sessionArgs(session?: SessionLaunch): string[] {
  if (!session) return ["--no-session-persistence"];
  return [
    ...(session.resumeFrom
      ? ["--resume", session.resumeFrom, "--fork-session"]
      : []),
    "--session-id",
    session.id,
    ...(session.resumeAt ? ["--resume-session-at", session.resumeAt] : []),
  ];
}

export function systemPrompt(request: ResponsesRequest): string {
  return [CODEX_TOOL_SYSTEM_PROMPT, systemContext(request)]
    .filter(Boolean)
    .join("\n\n");
}

const systemPromptDir = () => join(stateDir(), "system-prompts");

/**
 * The system prompt goes through a file because a tool registry easily exceeds
 * Linux's 128 KiB limit on one argv entry. Content addressing lets concurrent
 * workers share it; rewriting through a rename refreshes its age for pruning
 * without exposing a partial file to a starting worker.
 */
export function systemPromptFile(request: ResponsesRequest): string {
  const prompt = systemPrompt(request);
  const directory = systemPromptDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${sha256(prompt)}.txt`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, prompt, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

// Claude Code reads the file when a worker starts, and every launch rewrites
// it, so a day-old file belongs to no worker that could still need it.
const SYSTEM_PROMPT_RETENTION_MS = 86_400_000;

function pruneSystemPrompts(): void {
  const directory = systemPromptDir();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - SYSTEM_PROMPT_RETENTION_MS;
  for (const name of names) {
    const path = join(directory, name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Another launch may have replaced or removed it; nothing to clean.
    }
  }
}

type PendingTurn = {
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
  // Plain text the model wrote this turn outside StructuredOutput.
  prose: string[];
};
/** What the worker answered last, so the next request can be checked against it. */
type LastTurn = { text: string; callIds: Set<string> };

/**
 * Idle workers, least recently used first. Claude Code caches a conversation
 * only at the end of its own message history, so a new process that receives
 * the conversation re-flattened into one message misses the cache entirely.
 * Workers therefore stay alive across Codex turns, including final answers
 * and tool searches, and receive only the items they have not seen.
 */
const idleWorkers = new Set<ClaudeWorker>();
/** Every running worker, so pruning never deletes a transcript in use. */
const liveWorkers = new Set<ClaudeWorker>();

const PRUNE_INTERVAL_MS = 300_000;
let lastPrune = 0;

function maybePrune(): void {
  if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = Date.now();
  try {
    pruneSessions(
      Number(process.env.CLAUDE_SESSION_RETENTION_MS ?? 3_600_000),
      new Set([...liveWorkers].map((worker) => worker.sessionId)),
    );
  } catch (error) {
    console.error("Unable to prune Claude sessions:", (error as Error).message);
  }
  pruneSystemPrompts();
}

class ClaudeWorker {
  readonly model: string;
  readonly effort: string | undefined;
  readonly toolSignature: string;
  readonly instructions: string | undefined;
  readonly sessionId = crypto.randomUUID();
  readonly key: SessionKey;
  readonly account: Account;
  /** Count and hash of the Codex input items this worker has consumed. */
  seenCount = 0;
  prefixHash = "";
  lastTurn: LastTurn = { text: "", callIds: new Set() };
  private readonly subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private pending?: PendingTurn;
  private readonly workerId = crypto.randomUUID();
  private workerTurn = 0;
  private turn: TurnContext = { requestId: "" };
  private attempt = 1;
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** The stored session this process forked, if it did not start fresh. */
  private readonly resumedFrom?: string;

  constructor(
    request: ResponsesRequest,
    account: Account,
    resumeFrom?: string,
    resumeAt?: string,
  ) {
    this.account = account;
    this.resumedFrom = resumeFrom;
    this.model = request.model;
    this.effort = resolveEffort(request);
    this.toolSignature = toolSignature(request);
    this.instructions = request.instructions;
    this.key = sessionKey(request);
    maybePrune();
    try {
      registerSession(this.sessionId, this.key);
    } catch (error) {
      // The map only saves cache; a broken database must not block inference.
      console.error("Unable to register Claude session:", (error as Error).message);
    }
    const {
      CLAUDECODE: _nested,
      CLAUDE_CODE_EFFORT_LEVEL: _effortLevel,
      ...env
    } = process.env;
    this.subprocess = Bun.spawn(
      [
        process.env.CLAUDE_BIN ?? "claude",
        ...buildClaudeArgs(request, {
          id: this.sessionId,
          resumeFrom,
          resumeAt: resumeFrom ? resumeAt : undefined,
        }),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.env.CLAUDE_CWD || process.cwd(),
        env: { ...env, ...accountEnv(account) },
      },
    );
    liveWorkers.add(this);
    void this.readStdout().catch((cause) => this.fail(cause));
    const stderrRead = this.readStderr().catch(() => {});
    void this.subprocess.exited.then(async (exitCode) => {
      // Helpers may inherit the pipe; allow diagnostics to drain without hanging exit.
      await Promise.race([stderrRead, Bun.sleep(1000)]);
      this.closed = true;
      idleWorkers.delete(this);
      liveWorkers.delete(this);
      if (this.pending) {
        const message =
          this.stderr.trim() || `Claude CLI exited with code ${exitCode}`;
        this.pending.reject(new Error(message));
        this.pending = undefined;
      }
    });
  }

  async run(
    content: ClaudeInputBlock[],
    turn: TurnContext,
    attempt: number,
  ): Promise<ClaudeResult> {
    if (this.closed) throw new Error("Claude CLI worker is closed");
    if (this.pending)
      throw new Error("Claude CLI worker is already processing a turn");
    this.turn = turn;
    turn.account = this.account;
    this.attempt = attempt;
    this.workerTurn++;
    idleWorkers.delete(this);
    clearTimeout(this.idleTimer);
    const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.fail(new Error(`Claude CLI timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.pending = {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.noteFailure(undefined, error.message);
          reject(error);
        },
        prose: [],
      };
      const message = { type: "user", message: { role: "user", content } };
      this.subprocess.stdin.write(`${JSON.stringify(message)}\n`);
      this.subprocess.stdin.flush();
    });
  }

  /** Park the worker until the conversation's next request, or evict it. */
  park(input: ResponseInputItem[], lastTurn: LastTurn): void {
    if (this.closed) return;
    this.seenCount = input.length;
    this.prefixHash = prefixHash(input, input.length);
    this.lastTurn = lastTurn;
    try {
      saveSession({
        ...this.key,
        sessionId: this.sessionId,
        seenCount: this.seenCount,
        prefixHash: this.prefixHash,
        lastText: lastTurn.text,
        lastCallIds: [...lastTurn.callIds],
      });
    } catch (error) {
      console.error("Unable to save Claude session:", (error as Error).message);
    }
    idleWorkers.delete(this);
    idleWorkers.add(this);
    const maxIdle = Number(process.env.CLAUDE_MAX_IDLE_WORKERS ?? 8);
    for (const oldest of idleWorkers) {
      if (idleWorkers.size <= maxIdle) break;
      oldest.close();
    }
    // Claude Code writes cache entries with a 1-hour TTL; keep the process just
    // under that so a user returning within the hour still hits its cache.
    const idleMs = Number(process.env.CLAUDE_SESSION_IDLE_MS ?? 3_300_000);
    this.idleTimer = setTimeout(() => this.close(), idleMs);
    this.idleTimer.unref?.();
  }

  close(): void {
    idleWorkers.delete(this);
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      this.subprocess.stdin.end();
    } catch {}
  }

  private abort(): void {
    this.close();
    try {
      this.subprocess.kill();
    } catch {}
  }

  private fail(cause: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    this.abort();
    pending?.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }

  /**
   * Logs a failed turn and benches this account when the error shows it is out
   * of quota or signed out, so the request can fail over to another account.
   */
  private noteFailure(status: unknown, message: string): void {
    if (isLimitError(status, message)) markLimited(this.account);
    if (isAuthError(status, message)) markAuthFailed(this.account);
    recordFailure({
      event: "failure",
      requestId: this.turn.requestId,
      account: this.account.name,
      workerId: this.workerId,
      attempt: this.attempt,
      category: failureCategory(status, message),
      status: typeof status === "number" ? status : undefined,
    });
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.subprocess.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.acceptLine(line);
    }
    if (buffer) this.acceptLine(buffer);
  }

  private acceptLine(line: string): void {
    let event:
      | ClaudeResult
      | { type: "rate_limit_event"; rate_limit_info?: Record<string, unknown> }
      | { type: "assistant"; message?: { content?: Array<{ type: string; text?: string }> } }
      | undefined;
    try {
      event = JSON.parse(line);
    } catch {
      return; // The CLI also prints non-JSON diagnostics.
    }
    if (event?.type === "rate_limit_event") {
      observeRateLimit(this.account, event.rate_limit_info ?? {});
      return;
    }
    if (event?.type === "assistant") {
      for (const block of event.message?.content ?? [])
        if (block.type === "text" && block.text?.trim()) this.pending?.prose.push(block.text);
      return;
    }
    if (event?.type !== "result" || !this.pending) return;
    // The model sometimes answers in plain text and then submits StructuredOutput
    // with empty text; keep the answer instead of returning nothing to Codex.
    const output = event.structured_output;
    if (!event.is_error && output && !output.text.trim() && this.pending.prose.length)
      event.structured_output = { ...output, text: this.pending.prose.join("\n\n") };
    if (event.is_error)
      this.noteFailure(event.api_error_status, resultErrorText(event));
    recordUsage(event, {
      requestId: this.turn.requestId,
      workerId: this.workerId,
      workerTurn: this.workerTurn,
      model: this.model,
      effort: this.effort,
      attempt: this.attempt,
      launchMode: "minimal",
      resumed: this.resumedFrom !== undefined,
      threadId: this.turn.threadId,
      sessionId: this.sessionId,
      resumedFrom: this.resumedFrom,
      account: this.account.name,
    });
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(event);
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.subprocess.stderr)
      this.stderr = (
        this.stderr + decoder.decode(chunk, { stream: true })
      ).slice(-65_536);
  }
}

/** Item types the model produced; Codex echoes them back in the next request. */
const MODEL_OUTPUT_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "computer_call",
  "tool_search_call",
]);

export function prefixHash(input: ResponseInputItem[], count: number): string {
  return prefixHashes(input, [count]).get(count)!;
}

/** prefixHash for several counts in one pass over the input. */
export function prefixHashes(
  input: ResponseInputItem[],
  counts: Iterable<number>,
): Map<number, string> {
  const wanted = new Set(counts);
  const hashes = new Map<number, string>();
  const hasher = new Bun.CryptoHasher("sha256");
  const limit = Math.min(Math.max(0, ...wanted), input.length);
  for (let count = 0; ; count++) {
    if (wanted.has(count)) hashes.set(count, hasher.copy().digest("hex"));
    if (count >= limit) break;
    // Server-assigned ids and statuses are not conversation content.
    const { id: _id, status: _status, ...content } = input[count] as Record<
      string,
      unknown
    >;
    hasher.update(stableJson(content));
    hasher.update("\n");
  }
  // A count past the end covers the whole input, as slice() would.
  for (const count of wanted)
    if (!hashes.has(count)) hashes.set(count, hasher.copy().digest("hex"));
  return hashes;
}

/**
 * New items after a worker's last turn, excluding Codex's echo of that turn.
 * Returns undefined unless the echo accounts for exactly the worker's answer,
 * so an edited, forked, or compacted history always starts a fresh worker.
 */
export function conversationDelta(
  items: ResponseInputItem[],
  lastTurn: LastTurn,
): ResponseInputItem[] | undefined {
  const unmatchedCalls = new Set(lastTurn.callIds);
  const expectedText = lastTurn.text.trim();
  let textMatched = expectedText === "";
  const delta: ResponseInputItem[] = [];
  for (const item of items) {
    if (item.type && MODEL_OUTPUT_TYPES.has(item.type)) {
      if (!item.call_id || !unmatchedCalls.delete(item.call_id)) return undefined;
      continue;
    }
    if (item.role === "assistant") {
      if (textMatched || textFromContent(item.content).trim() !== expectedText)
        return undefined;
      textMatched = true;
      continue;
    }
    delta.push(item);
  }
  if (unmatchedCalls.size > 0 || !textMatched || delta.length === 0)
    return undefined;
  return delta;
}

function claimWorker(
  request: ResponsesRequest,
  account?: Account,
): { worker: ClaudeWorker; delta: ResponseInputItem[] } | undefined {
  const input = inputItems(request);
  const effort = resolveEffort(request);
  const signature = toolSignature(request);
  // Most recently parked first.
  for (const worker of [...idleWorkers].reverse()) {
    // A limited account cannot answer; the session resumes on another one.
    if (isUnavailable(worker.account)) {
      worker.close();
      continue;
    }
    if (
      (account && worker.account.name !== account.name) ||
      worker.model !== request.model ||
      worker.effort !== effort ||
      worker.instructions !== request.instructions ||
      worker.toolSignature !== signature ||
      input.length <= worker.seenCount ||
      prefixHash(input, worker.seenCount) !== worker.prefixHash
    )
      continue;
    const delta = conversationDelta(
      input.slice(worker.seenCount),
      worker.lastTurn,
    );
    if (!delta) continue;
    // Claim it so a concurrent fork of the same history gets its own worker.
    idleWorkers.delete(worker);
    return { worker, delta };
  }
  return undefined;
}

/** A string input is shorthand for one user message; later turns send arrays. */
function inputItems(request: ResponsesRequest): ResponseInputItem[] {
  return typeof request.input === "string"
    ? [{ role: "user", content: request.input }]
    : request.input;
}

const sha256 = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

function sessionKey(request: ResponsesRequest): SessionKey {
  return {
    model: request.model,
    effort: resolveEffort(request) ?? "",
    instructionsHash: sha256(request.instructions ?? ""),
    toolsHash: sha256(toolSignature(request)),
  };
}

/** A persisted session whose history this request extends; its process is gone. */
function findStoredSession(
  request: ResponsesRequest,
): { resumeFrom: string; delta: ResponseInputItem[] } | undefined {
  const input = inputItems(request);
  let candidates;
  try {
    candidates = findSessions(sessionKey(request), input.length);
  } catch (error) {
    console.error("Unable to read Claude sessions:", (error as Error).message);
    return undefined;
  }
  const hashes = prefixHashes(
    input,
    candidates.map((session) => session.seenCount),
  );
  for (const session of candidates) {
    if (hashes.get(session.seenCount) !== session.prefixHash) continue;
    const delta = conversationDelta(input.slice(session.seenCount), {
      text: session.lastText,
      callIds: new Set(session.lastCallIds),
    });
    if (delta) return { resumeFrom: session.sessionId, delta };
  }
  return undefined;
}

/** A live worker or a stored session that this request's history extends. */
type Continuation = {
  request: ResponsesRequest;
  delta: ResponseInputItem[];
  resumeFrom: string;
  worker?: ClaudeWorker;
};

/** Tries each form of the request in order; live workers win over stored sessions. */
function findContinuation(
  requests: Iterable<ResponsesRequest>,
  account?: Account,
): Continuation | undefined {
  for (const request of requests) {
    const live = claimWorker(request, account);
    if (live)
      return { request, ...live, resumeFrom: live.worker.sessionId };
    const stored = findStoredSession(request);
    if (stored) return { request, ...stored };
  }
  return undefined;
}

/** The first account with quota left, or the one whose limit resets soonest. */
const availableAccount = (): Account => pickAccount() ?? soonestAccount();

/**
 * The account to replay on when `account` can no longer serve requests, or
 * undefined when the error should stand because none is left.
 */
function failoverAccount(
  requestId: string,
  account: Account | undefined,
  category: string,
): Account | undefined {
  if (!account || !isUnavailable(account)) return undefined;
  const next = pickAccount();
  if (!next) return undefined;
  recordFailure({
    event: "failover",
    requestId,
    account: account.name,
    nextAccount: next.name,
    category,
  });
  console.error(`Switching Claude account ${account.name} -> ${next.name}`);
  return next;
}

/** Close idle workers; their sessions stay resumable. Used on shutdown and in tests. */
export function closeIdleWorkers(): void {
  for (const worker of [...idleWorkers]) worker.close();
}

function toolSignature(request: ResponsesRequest): string {
  // Only the base registry: tools loaded later arrive as conversation items.
  return stableJson(toolDescriptors(request.tools ?? []));
}

export {
  estimateRequestTokens,
  estimateVisibleTokens,
  IMAGE_TOKEN_ESTIMATE,
} from "./budget";

type StructuredOutput = NonNullable<ClaudeResult["structured_output"]>;

function resultErrorText(result: ClaudeResult): string {
  return [result.result, ...(result.errors ?? [])].filter((text) => typeof text === "string").join("\n");
}

class ClaudeFailure extends Error {
  constructor(result: ClaudeResult) {
    super(resultErrorText(result) || "Claude CLI returned an error");
    this.status = result.api_error_status;
  }
  readonly status: number | null | undefined;
}

function errorCategory(error: unknown): string {
  return failureCategory(error instanceof ClaudeFailure ? error.status : undefined, String(error));
}

function parseStructuredOutput(result: ClaudeResult): StructuredOutput {
  if (result.is_error)
    throw new ClaudeFailure(result);
  let structured: ClaudeResult["structured_output"];
  try {
    structured =
      result.structured_output ??
      (JSON.parse(result.result ?? "{}") as ClaudeResult["structured_output"]);
  } catch {}
  if (
    !structured ||
    typeof structured.text !== "string" ||
    !Array.isArray(structured.tool_calls)
  )
    throw new Error("Claude CLI returned invalid structured output");
  return structured;
}

export async function runClaude(
  request: ResponsesRequest,
): Promise<ProxyOutput> {
  const requestId = crypto.randomUUID();
  const threadId =
    typeof request.prompt_cache_key === "string"
      ? request.prompt_cache_key
      : undefined;
  const checkpoints = new Map<string, string | undefined>();
  for (;;) {
    const turn: TurnContext = { requestId, threadId };
    let output: ProxyOutput;
    try {
      output = await runClaudeTurn(request, turn, checkpoints);
    } catch (error) {
      // Corrections can also fail authentication or hit quota; replay before any tool calls are returned.
      if (failoverAccount(requestId, turn.account, errorCategory(error)))
        continue;
      recordFailure({ event: "request_failed", requestId, account: turn.account?.name,
        category: errorCategory(error) });
      throw error;
    }
    if (threadId && turn.account) {
      try {
        pinThreadAccount(threadId, turn.account.name, turn.pinnedAccount);
      } catch (error) {
        // Persistence failure must not discard an already completed response.
        console.error("Unable to save thread account:", (error as Error).message);
      }
    }
    return { ...output, account: turn.account?.name };
  }
}

async function runClaudeTurn(
  original: ResponsesRequest,
  turn: TurnContext,
  checkpoints: Map<string, string | undefined>,
): Promise<ProxyOutput> {
  validateCompactionItems(original);
  const pinnedName = turn.threadId
    ? threadAccount(turn.threadId) ??
      claimThreadAccount(turn.threadId, availableAccount().name)
    : undefined;
  turn.pinnedAccount = pinnedName;
  const pinned = listAccounts().find((account) => account.name === pinnedName);
  const account = pinned && !isUnavailable(pinned) ? pinned : availableAccount();

  const normalized = normalizeContext(original);
  // Existing sessions must keep the exact prefix they were originally sent.
  const found = findContinuation(
    new Set([normalized, original]),
    turn.threadId ? account : undefined,
  );
  const request = found?.request ?? normalized;
  let delta = found?.delta;
  let resumeFrom = found?.resumeFrom;
  const replaying = resumeFrom !== undefined && checkpoints.has(resumeFrom);
  // Capture before this turn can append a rejected answer to the transcript.
  if (resumeFrom && !checkpoints.has(resumeFrom))
    checkpoints.set(resumeFrom, resumeCheckpoint(resumeFrom));
  const resumeAt = resumeFrom ? checkpoints.get(resumeFrom) : undefined;
  if (replaying && resumeFrom && !resumeAt && !found?.worker) {
    delta = undefined;
    resumeFrom = undefined;
  }
  let worker = found?.worker ?? new ClaudeWorker(request, account, resumeFrom, resumeAt);
  // Estimated tokens of the last full-history prompt, to rescale after a rejection.
  let replaySent = 0;
  /** The whole conversation for a fresh worker, shortened to fit Claude's window. */
  const replayPrompt = (budget = replayBudget(request.model)) => {
    const fitted = fitReplay(request, budget);
    replaySent = fitted.tokens;
    if (fitted.elided)
      console.error(
        `Elided ${fitted.elided} older tool output(s) to fit a replay into ~${fitted.tokens} estimated tokens${fitted.fits ? "" : " (still over budget)"}`,
      );
    if (fitted.omitted)
      console.error(
        `Compaction left out the ${fitted.omitted} oldest item(s) to fit ~${fitted.tokens} estimated tokens${fitted.fits ? "" : " (still over budget)"}`,
      );
    return prepareClaudePrompt(conversationRequest(fitted.request));
  };
  let prepared = delta
    ? await prepareClaudePrompt(deltaRequest(request, delta))
    : await replayPrompt();
  let shrunk = false;
  const replayWorker = async (next: Account): Promise<ClaudeWorker> => {
    // Without a checkpoint, resuming could include the rejected answer.
    if (resumeFrom && !resumeAt) {
      await prepared.cleanup();
      prepared = await replayPrompt();
      delta = undefined;
      resumeFrom = undefined;
    }
    return new ClaudeWorker(request, next, resumeFrom, resumeAt);
  };
  let structured: StructuredOutput;
  try {
    let result: ClaudeResult;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await worker.run(prepared.content, turn, attempt);
      } catch (error) {
        worker.close();
        const next = failoverAccount(
          turn.requestId,
          worker.account,
          errorCategory(error),
        );
        if (next) {
          worker = await replayWorker(next);
          continue;
        }
        if (isUnavailable(worker.account) || !delta) throw error;
        // Missing or unusable transcripts get one full-history fallback.
        await prepared.cleanup();
        prepared = await replayPrompt();
        delta = undefined;
        resumeFrom = undefined;
        worker = new ClaudeWorker(request, worker.account);
        continue;
      }
      if (!result.is_error) break;
      const tooLong = shrunk ? undefined : promptTooLong(resultErrorText(result));
      if (tooLong) {
        // The estimate was optimistic (or a resumed session outgrew Claude's
        // window): replay once more with the error's own sizes as the scale.
        shrunk = true;
        worker.close();
        await prepared.cleanup();
        const sent = delta ? replayTokens(request) : replaySent;
        prepared = await replayPrompt(retryBudget(sent, tooLong, request.model));
        delta = undefined;
        resumeFrom = undefined;
        worker = new ClaudeWorker(request, worker.account);
        continue;
      }
      const next = failoverAccount(
        turn.requestId,
        worker.account,
        failureCategory(result.api_error_status, resultErrorText(result)),
      );
      if (!next) break;
      worker.close();
      // Keep the original checkpoint and delta across every rejected account.
      worker = await replayWorker(next);
    }
    structured = parseStructuredOutput(result);
  } catch (error) {
    worker.close();
    throw error;
  } finally {
    await prepared.cleanup();
  }

  if (isCompactionRequest(request))
    return await compactionOutput(worker, request, turn, structured);

  // Tool names are validated here instead of by a schema enum (see
  // outputSchema).
  const allowedTools = new Set(
    toolDescriptors(requestTools(request)).map((tool) => tool.proxyName),
  );
  structured = await corrected(worker, turn, structured, (output) => {
    const unknown = output.tool_calls
      .map((call) => call.name)
      .filter((name) => !allowedTools.has(name));
    if (unknown.length === 0) return undefined;
    return {
      message: `<tool_error>\nNo tool calls were executed. Unknown tool name(s): ${unknown.join(", ")}. Use only exact names from <available_tools> or tools loaded by tool search, formatted namespace.name for namespaced tools. Reply again with the corrected text and tool_calls.\n</tool_error>`,
      failure: `Claude CLI requested unavailable tool: ${unknown[0]}`,
    };
  });

  const toolCalls = structured.tool_calls.map((call) => ({
    ...call,
    callId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
  }));
  // Normalize before parking so Codex's echo of this turn matches lastTurn.text.
  const text = normalizeVisualizeReferences(structured.text);
  worker.park(inputItems(request), {
    text,
    callIds: new Set(toolCalls.map((call) => call.callId)),
  });
  return {
    text,
    toolCalls,
    usage: visibleUsage(request, text + JSON.stringify(toolCalls)),
  };
}

/** A follow-up asking the worker to fix its answer, and the error if it never does. */
type Correction = { message: string; failure: string };

/**
 * Sends corrections to the same worker, which keeps its prompt cache, until
 * `check` accepts the answer. The worker is closed if it never does.
 */
async function corrected(
  worker: ClaudeWorker,
  turn: TurnContext,
  structured: StructuredOutput,
  check: (output: StructuredOutput) => Correction | undefined,
): Promise<StructuredOutput> {
  try {
    for (let retry = 0; ; retry++) {
      const correction = check(structured);
      if (!correction) return structured;
      if (retry >= MAX_CORRECTIONS) throw new Error(correction.failure);
      const result = await worker.run(
        [{ type: "text", text: correction.message }],
        turn,
        retry + 2,
      );
      structured = parseStructuredOutput(result);
    }
  } catch (error) {
    worker.close();
    throw error;
  }
}

/**
 * Claude Code's usage includes its private system prompt, native tool schemas,
 * plugins, MCP definitions, and cache activity. Reporting that hidden runtime
 * overhead makes Codex believe its own conversation exceeds the context window,
 * so only the request and output content Codex can retain or compact counts.
 */
function visibleUsage(
  request: ResponsesRequest,
  output: string,
): ProxyOutput["usage"] {
  const inputTokens = estimateRequestTokens(request);
  const outputTokens = estimateVisibleTokens(output);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * Answers Codex remote compaction (v2), which a task on the built-in openai
 * provider uses instead of local summarization. Codex requires exactly one
 * `compaction` item back; the summary rides in it and is expanded when the
 * compacted history returns (see request.ts).
 */
async function compactionOutput(
  worker: ClaudeWorker,
  request: ResponsesRequest,
  turn: TurnContext,
  structured: StructuredOutput,
): Promise<ProxyOutput> {
  const { text } = await corrected(worker, turn, structured, (output) =>
    output.tool_calls.length > 0 || !output.text.trim()
      ? COMPACTION_CORRECTION
      : undefined,
  );
  // The summary replaces this history, so no later request can extend this worker.
  worker.close();
  return {
    text: "",
    toolCalls: [],
    compaction: text,
    usage: visibleUsage(request, text),
  };
}
