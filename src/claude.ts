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
  isLimited,
  markLimited,
  observeRateLimit,
  pickAccount,
  soonestAccount,
  type Account,
} from "./accounts";
import { recordUsage } from "./usage";
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
  requestImageCount,
  requestToPrompt,
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
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  "claude-opus": "opus",
  "claude-sonnet": "sonnet",
  "claude-haiku": "haiku",
};

const CODEX_TOOL_SYSTEM_PROMPT = `You are running inside a Codex agent loop. Tools described in <available_tools> are real, available Codex tools even though they are not present in Claude Code's native tool registry. Invoke them by returning their exact name and arguments in the required structured tool_calls output. Never claim that a listed Codex tool is unavailable merely because it is absent from the native registry. When a Codex browser, node_repl, cua_repl, or computer tool is listed, use it for browser requests instead of substituting WebFetch, web search, curl, or another native tool.`;

const MAX_TOOL_NAME_RETRIES = 2;

const COMPACTION_CORRECTION = `<compaction_error>\nNo tools were executed. This turn must produce only the handoff summary: put all of it in text and leave tool_calls empty.\n</compaction_error>`;

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
    ...(session
      ? [
          ...(session.resumeFrom
            ? ["--resume", session.resumeFrom, "--fork-session"]
            : []),
          "--session-id",
          session.id,
          ...(session.resumeAt ? ["--resume-session-at", session.resumeAt] : []),
        ]
      : ["--no-session-persistence"]),
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
};
type ClaudeProcess = {
  stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
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
  private readonly subprocess: ClaudeProcess;
  private pending?: PendingTurn;
  private readonly workerId = crypto.randomUUID();
  private workerTurn = 0;
  private turn: TurnContext = { requestId: "" };
  private attempt = 1;
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  /** Whether this process forked a stored session instead of starting fresh. */
  private readonly resumed: boolean;
  private readonly resumedFrom?: string;

  constructor(
    request: ResponsesRequest,
    resumeFrom?: string,
    account: Account = pickAccount() ?? soonestAccount(),
  ) {
    this.account = account;
    this.resumed = resumeFrom !== undefined;
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
    this.subprocess = Bun.spawn(
      [
        process.env.CLAUDE_BIN ?? "claude",
        ...buildClaudeArgs(request, {
          id: this.sessionId,
          resumeFrom,
          resumeAt: resumeFrom ? resumeCheckpoint(resumeFrom) : undefined,
        }),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.env.CLAUDE_CWD || process.cwd(),
        env: {
          ...(Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                key !== "CLAUDECODE" && key !== "CLAUDE_CODE_EFFORT_LEVEL",
            ),
          ) as Record<string, string>),
          ...accountEnv(account),
        },
      },
    ) as unknown as ClaudeProcess;
    liveWorkers.add(this);
    void this.readStdout().catch((cause) => this.fail(cause));
    void this.readStderr();
    void this.subprocess.exited.then((exitCode) => {
      this.closed = true;
      idleWorkers.delete(this);
      liveWorkers.delete(this);
      if (this.pending) {
        const message =
          this.stderr.trim() || `Claude CLI exited with code ${exitCode}`;
        if (isLimitError(undefined, this.stderr)) markLimited(this.account);
        this.pending.reject(new Error(message));
        this.pending = undefined;
      }
    });
  }

  async run(
    content: ClaudeInputBlock[],
    turn: TurnContext,
    attempt = 1,
  ): Promise<ClaudeResult> {
    this.turn = turn;
    this.attempt = attempt;
    this.workerTurn++;
    if (this.closed) throw new Error("Claude CLI worker is closed");
    if (this.pending)
      throw new Error("Claude CLI worker is already processing a turn");
    idleWorkers.delete(this);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        this.abort();
        reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
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

  private async readStdout(): Promise<void> {
    const reader = this.subprocess.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.acceptLine(line);
    }
    if (buffer) this.acceptLine(buffer);
  }

  private acceptLine(line: string): void {
    try {
      const value = JSON.parse(line) as
        | ClaudeResult
        | { type: "rate_limit_event"; rate_limit_info?: Record<string, unknown> };
      if (value.type === "rate_limit_event") {
        observeRateLimit(this.account, value.rate_limit_info ?? {});
        return;
      }
      if (value.type !== "result" || !this.pending) return;
      if (value.is_error && isLimitError(value.api_error_status, value.result))
        markLimited(this.account);
      this.turn.account = this.account;
      recordUsage(value, {
        requestId: this.turn.requestId,
        workerId: this.workerId,
        workerTurn: this.workerTurn,
        model: this.model,
        effort: this.effort,
        attempt: this.attempt,
        launchMode: "minimal",
        resumed: this.resumed,
        threadId: this.turn.threadId,
        sessionId: this.sessionId,
        resumedFrom: this.resumedFrom,
        account: this.account.name,
      });
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve(value);
    } catch {
      // Ignore non-JSON diagnostics from the CLI.
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.subprocess.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderr = (
        this.stderr + decoder.decode(value, { stream: true })
      ).slice(-65_536);
    }
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
    if (isLimited(worker.account)) {
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

/** Close idle workers; their sessions stay resumable. Used on shutdown and in tests. */
export function closeIdleWorkers(): void {
  for (const worker of [...idleWorkers]) worker.close();
}

function toolSignature(request: ResponsesRequest): string {
  // Only the base registry: tools loaded later arrive as conversation items.
  return stableJson(toolDescriptors(request.tools ?? []));
}

export function estimateVisibleTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

// Claude bills an image by its pixel area, capped near 4,800 tokens at the largest
// size current models accept. Assuming the cap keeps Codex compacting early
// rather than letting a screenshot-heavy task outgrow the real window.
export const IMAGE_TOKEN_ESTIMATE = 4_800;

export function estimateRequestTokens(request: ResponsesRequest): number {
  return (
    estimateVisibleTokens(requestToPrompt(request)) +
    requestImageCount(request) * IMAGE_TOKEN_ESTIMATE
  );
}

type StructuredOutput = NonNullable<ClaudeResult["structured_output"]>;

function structuredOutput(
  worker: ClaudeWorker,
  result: ClaudeResult,
): StructuredOutput {
  if (result.is_error) {
    worker.close();
    throw new Error(result.result || "Claude CLI returned an error");
  }
  let structured: ClaudeResult["structured_output"];
  try {
    structured =
      result.structured_output ??
      (JSON.parse(result.result ?? "{}") as ClaudeResult["structured_output"]);
  } catch {
    worker.close();
    throw new Error("Claude CLI returned invalid structured output");
  }
  if (
    !structured ||
    typeof structured.text !== "string" ||
    !Array.isArray(structured.tool_calls)
  ) {
    worker.close();
    throw new Error("Claude CLI returned invalid structured output");
  }
  return structured;
}

export async function runClaude(
  request: ResponsesRequest,
): Promise<ProxyOutput> {
  let turn: TurnContext = {
    requestId: crypto.randomUUID(),
    threadId:
      typeof request.prompt_cache_key === "string"
        ? request.prompt_cache_key
        : undefined,
  };
  let output: ProxyOutput;
  for (;;) {
    turn = { requestId: turn.requestId, threadId: turn.threadId };
    try {
      output = await runClaudeTurn(request, turn);
      break;
    } catch (error) {
      // Corrections can also hit quota; replay before any tool calls are returned.
      if (!turn.account || !isLimited(turn.account) || !pickAccount()) throw error;
    }
  }
  if (turn.threadId && turn.account) {
    try {
      pinThreadAccount(turn.threadId, turn.account.name, turn.pinnedAccount);
    } catch (error) {
      // Persistence failure must not discard an already completed response.
      console.error("Unable to save thread account:", (error as Error).message);
    }
  }
  return { ...output, account: turn.account?.name };
}

async function runClaudeTurn(
  request: ResponsesRequest,
  turn: TurnContext,
): Promise<ProxyOutput> {
  validateCompactionItems(request);
  const original = request;
  request = normalizeContext(request);
  const pinnedName = turn.threadId
    ? threadAccount(turn.threadId) ?? claimThreadAccount(turn.threadId, (pickAccount() ?? soonestAccount()).name)
    : undefined;
  const pinned = listAccounts().find((account) => account.name === pinnedName);
  const account = pinned && !isLimited(pinned) ? pinned : pickAccount() ?? soonestAccount();
  if (turn.threadId) {
    turn.pinnedAccount = pinnedName ?? account.name;
  }
  let live = claimWorker(request, turn.threadId ? account : undefined);
  let stored = live ? undefined : findStoredSession(request);
  // Existing sessions must keep the exact prefix they were originally sent.
  if (!live && !stored && request !== original) {
    live = claimWorker(original, turn.threadId ? account : undefined);
    stored = live ? undefined : findStoredSession(original);
    if (live || stored) request = original;
  }
  let delta = live?.delta ?? stored?.delta;
  let resumeFrom = live?.worker.sessionId ?? stored?.resumeFrom;
  let worker = live?.worker ?? new ClaudeWorker(request, resumeFrom, account);
  let prepared = await prepareClaudePrompt(
    delta ? deltaRequest(request, delta) : conversationRequest(request),
  );
  let result: ClaudeResult;
  let attempt = 1;
  try {
    while (true) {
      try {
        result = await worker.run(prepared.content, turn, attempt++);
      } catch (error) {
        worker.close();
        const next = isLimited(worker.account) ? pickAccount() : undefined;
        if (next) {
          worker = new ClaudeWorker(request, resumeFrom, next);
          continue;
        }
        if (isLimited(worker.account) || !delta) throw error;
        // Missing or unusable transcripts get one full-history fallback.
        await prepared.cleanup();
        prepared = await prepareClaudePrompt(conversationRequest(request));
        delta = undefined;
        resumeFrom = undefined;
        worker = new ClaudeWorker(request, undefined, worker.account);
        continue;
      }
      if (!result.is_error || !isLimited(worker.account)) break;
      const next = pickAccount();
      if (!next) break;
      console.error(
        `Switching Claude account ${worker.account.name} -> ${next.name}`,
      );
      worker.close();
      // Keep the original checkpoint and delta across every rejected account.
      worker = new ClaudeWorker(request, resumeFrom, next);
    }
  } catch (error) {
    worker.close();
    throw error;
  } finally {
    await prepared.cleanup();
  }

  let structured = structuredOutput(worker, result);
  if (isCompactionRequest(request))
    return await compactionOutput(worker, request, turn, structured);

  // Tool names are validated here instead of by a schema enum (see
  // outputSchema). Correct them in the same process to keep its cache.
  const allowedTools = new Set(
    toolDescriptors(requestTools(request)).map((tool) => tool.proxyName),
  );
  for (let retry = 0; ; retry++) {
    const unknown = structured.tool_calls
      .map((call) => call.name)
      .filter((name) => !allowedTools.has(name));
    if (unknown.length === 0) break;
    if (retry >= MAX_TOOL_NAME_RETRIES) {
      worker.close();
      throw new Error(`Claude CLI requested unavailable tool: ${unknown[0]}`);
    }
    const correction = `<tool_error>\nNo tool calls were executed. Unknown tool name(s): ${unknown.join(", ")}. Use only exact names from <available_tools> or tools loaded by tool search, formatted namespace.name for namespaced tools. Reply again with the corrected text and tool_calls.\n</tool_error>`;
    try {
      result = await worker.run(
        [{ type: "text", text: correction }],
        turn,
        retry + 2,
      );
    } catch (error) {
      worker.close();
      throw error;
    }
    structured = structuredOutput(worker, result);
  }

  const toolCalls = structured.tool_calls.map((call) => ({
    ...call,
    callId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
  }));
  worker.park(inputItems(request), {
    text: structured.text,
    callIds: new Set(toolCalls.map((call) => call.callId)),
  });
  // Claude Code's usage includes its private system prompt, native tool schemas,
  // plugins, MCP definitions, and cache activity. Reporting that hidden runtime
  // overhead makes Codex believe its own conversation exceeds the context window.
  // Only report the request/output content that Codex can retain or compact.
  const inputTokens = estimateRequestTokens(request);
  const outputTokens = estimateVisibleTokens(
    structured.text + JSON.stringify(toolCalls),
  );
  return {
    text: structured.text,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
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
  for (
    let retry = 0;
    structured.tool_calls.length > 0 || !structured.text.trim();
    retry++
  ) {
    if (retry >= MAX_TOOL_NAME_RETRIES) {
      worker.close();
      throw new Error("Claude CLI did not return a compaction summary");
    }
    let result: ClaudeResult;
    try {
      result = await worker.run(
        [{ type: "text", text: COMPACTION_CORRECTION }],
        turn,
        retry + 2,
      );
    } catch (error) {
      worker.close();
      throw error;
    }
    structured = structuredOutput(worker, result);
  }
  // The summary replaces this history, so no later request can extend this worker.
  worker.close();
  const inputTokens = estimateRequestTokens(request);
  const outputTokens = estimateVisibleTokens(structured.text);
  return {
    text: "",
    toolCalls: [],
    compaction: structured.text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}
