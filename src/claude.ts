import { recordUsage } from "./usage";
import {
  findSessions,
  pruneSessions,
  registerSession,
  saveSession,
  type SessionKey,
} from "./sessions";
import {
  deltaRequest,
  outputSchema,
  prepareClaudePrompt,
  requestToPrompt,
  requestTools,
  stableJson,
  textFromContent,
  toolDescriptors,
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

export function resolveModel(model: string): string {
  const resolved = MODEL_ALIASES[model] ?? model;
  if (
    !/^[a-zA-Z0-9._-]+$/.test(resolved) ||
    (!resolved.startsWith("claude-") &&
      !["opus", "sonnet", "haiku"].includes(resolved))
  ) {
    throw new Error(`Unsupported Claude model: ${model}`);
  }
  return resolved;
}

export function resolveEffort(request: ResponsesRequest): string | undefined {
  const effort = request.reasoning?.effort;
  if (effort === undefined)
    return request.model === "claude-opus-5-5" ? "medium" : undefined;
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new Error(`Unsupported Claude effort: ${effort}`);
  return effort;
}

/** A fresh session, or a fork of a persisted one (`--resume` + `--fork-session`
 * so concurrent continuations of one history never share a transcript). */
export type SessionLaunch = { id: string; resumeFrom?: string };

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
    "--system-prompt",
    CODEX_TOOL_SYSTEM_PROMPT,
    "--json-schema",
    JSON.stringify(outputSchema(request.tools ?? [])),
  ];
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
}

class ClaudeWorker {
  readonly model: string;
  readonly effort: string | undefined;
  readonly toolSignature: string;
  readonly instructions: string | undefined;
  readonly sessionId = crypto.randomUUID();
  readonly key: SessionKey;
  /** Count and hash of the Codex input items this worker has consumed. */
  seenCount = 0;
  prefixHash = "";
  lastTurn: LastTurn = { text: "", callIds: new Set() };
  private readonly subprocess: ClaudeProcess;
  private pending?: PendingTurn;
  private readonly workerId = crypto.randomUUID();
  private workerTurn = 0;
  private requestId = "";
  private attempt = 1;
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(request: ResponsesRequest, resumeFrom?: string) {
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
        ...buildClaudeArgs(request, { id: this.sessionId, resumeFrom }),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.env.CLAUDE_CWD || process.cwd(),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              key !== "CLAUDECODE" && key !== "CLAUDE_CODE_EFFORT_LEVEL",
          ),
        ) as Record<string, string>,
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
        this.pending.reject(new Error(message));
        this.pending = undefined;
      }
    });
  }

  async run(
    content: ClaudeInputBlock[],
    requestId: string,
    attempt = 1,
  ): Promise<ClaudeResult> {
    this.requestId = requestId;
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
      const value = JSON.parse(line) as ClaudeResult;
      if (value.type !== "result" || !this.pending) return;
      recordUsage(value, {
        requestId: this.requestId,
        workerId: this.workerId,
        workerTurn: this.workerTurn,
        model: this.model,
        effort: this.effort,
        attempt: this.attempt,
        launchMode: "minimal",
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
  const hasher = new Bun.CryptoHasher("sha256");
  for (const item of input.slice(0, count)) {
    // Server-assigned ids and statuses are not conversation content.
    const { id: _id, status: _status, ...content } = item as Record<
      string,
      unknown
    >;
    hasher.update(stableJson(content));
    hasher.update("\n");
  }
  return hasher.digest("hex");
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
): { worker: ClaudeWorker; delta: ResponseInputItem[] } | undefined {
  const input = inputItems(request);
  const effort = resolveEffort(request);
  const signature = toolSignature(request);
  // Most recently parked first.
  for (const worker of [...idleWorkers].reverse()) {
    if (
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
  for (const session of candidates) {
    if (prefixHash(input, session.seenCount) !== session.prefixHash) continue;
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
  const requestId = crypto.randomUUID();
  const live = claimWorker(request);
  const stored = live ? undefined : findStoredSession(request);
  const delta = live?.delta ?? stored?.delta;
  let worker = live?.worker ?? new ClaudeWorker(request, stored?.resumeFrom);
  let prepared = await prepareClaudePrompt(
    delta ? deltaRequest(request, delta) : request,
  );
  let result: ClaudeResult;
  try {
    result = await worker.run(prepared.content, requestId);
  } catch (error) {
    worker.close();
    if (!delta) throw error;
    // A parked worker can die while idle, or a transcript can be missing;
    // replay the full request once in a fresh session.
    await prepared.cleanup();
    prepared = await prepareClaudePrompt(request);
    worker = new ClaudeWorker(request);
    try {
      result = await worker.run(prepared.content, requestId, 2);
    } catch (fallbackError) {
      worker.close();
      throw fallbackError;
    }
  } finally {
    await prepared.cleanup();
  }

  // Tool names are validated here instead of by a schema enum (see
  // outputSchema). Correct them in the same process to keep its cache.
  const allowedTools = new Set(
    toolDescriptors(requestTools(request)).map((tool) => tool.proxyName),
  );
  let structured = structuredOutput(worker, result);
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
        requestId,
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
  const inputTokens = estimateVisibleTokens(requestToPrompt(request));
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
