import { continuationRequest, outputSchema, prepareClaudePrompt, requestToPrompt, toolDescriptors } from "./request";
import type { ClaudeResult, ProxyOutput, ResponsesRequest } from "./types";

const MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  "claude-opus": "opus",
  "claude-sonnet": "sonnet",
  "claude-haiku": "haiku",
};

const CODEX_TOOL_SYSTEM_PROMPT = `You are running inside a Codex agent loop. Tools described in <available_tools> are real, available Codex tools even though they are not present in Claude Code's native tool registry. Invoke them by returning their exact name and arguments in the required structured tool_calls output. Never claim that a listed Codex tool is unavailable merely because it is absent from the native registry. When a Codex browser, node_repl, cua_repl, or computer tool is listed, use it for browser requests instead of substituting WebFetch, web search, curl, or another native tool.`;

export function resolveModel(model: string): string {
  const resolved = MODEL_ALIASES[model] ?? model;
  if (!/^[a-zA-Z0-9._-]+$/.test(resolved) || (!resolved.startsWith("claude-") && !["opus", "sonnet", "haiku"].includes(resolved))) {
    throw new Error(`Unsupported Claude model: ${model}`);
  }
  return resolved;
}

export function buildClaudeArgs(request: ResponsesRequest): string[] {
  return [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", resolveModel(request.model),
    "--disallowed-tools", "ToolSearch,WebFetch,WebSearch",
    "--append-system-prompt", CODEX_TOOL_SYSTEM_PROMPT,
    "--json-schema", JSON.stringify(outputSchema(request.tools ?? [])),
  ];
}

type PendingTurn = { resolve: (result: ClaudeResult) => void; reject: (error: Error) => void };
type ClaudeProcess = {
  stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
};

const workersByCallId = new Map<string, ClaudeWorker>();

class ClaudeWorker {
  readonly model: string;
  readonly toolSignature: string;
  readonly callIds = new Set<string>();
  private readonly subprocess: ClaudeProcess;
  private pending?: PendingTurn;
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(request: ResponsesRequest) {
    this.model = request.model;
    this.toolSignature = toolSignature(request);
    this.subprocess = Bun.spawn([process.env.CLAUDE_BIN ?? "claude", ...buildClaudeArgs(request)], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      cwd: process.env.CLAUDE_CWD || process.cwd(),
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CLAUDECODE")) as Record<string, string>,
    }) as unknown as ClaudeProcess;
    void this.readStdout().catch((cause) => this.fail(cause));
    void this.readStderr();
    void this.subprocess.exited.then((exitCode) => {
      this.closed = true;
      this.detach();
      if (this.pending) {
        const message = this.stderr.trim() || `Claude CLI exited with code ${exitCode}`;
        this.pending.reject(new Error(message));
        this.pending = undefined;
      }
    });
  }

  async run(prompt: string): Promise<ClaudeResult> {
    if (this.closed) throw new Error("Claude CLI worker is closed");
    if (this.pending) throw new Error("Claude CLI worker is already processing a turn");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        this.abort();
        reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      const message = { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } };
      this.subprocess.stdin.write(`${JSON.stringify(message)}\n`);
      this.subprocess.stdin.flush();
    });
  }

  retainFor(callIds: string[]): void {
    this.detach();
    for (const callId of callIds) {
      this.callIds.add(callId);
      workersByCallId.set(callId, this);
    }
    const idleMs = Number(process.env.CLAUDE_SESSION_IDLE_MS ?? 900_000);
    this.idleTimer = setTimeout(() => this.close(), idleMs);
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.detach();
    try { this.subprocess.stdin.end(); } catch {}
  }

  private abort(): void {
    this.close();
    try { this.subprocess.kill(); } catch {}
  }

  private fail(cause: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    this.abort();
    pending?.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }

  private detach(): void {
    for (const callId of this.callIds) {
      if (workersByCallId.get(callId) === this) workersByCallId.delete(callId);
    }
    this.callIds.clear();
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
      this.stderr = (this.stderr + decoder.decode(value, { stream: true })).slice(-65_536);
    }
  }
}

function continuationWorker(request: ResponsesRequest): ClaudeWorker | undefined {
  if (typeof request.input === "string") return undefined;
  for (let index = request.input.length - 1; index >= 0; index--) {
    const callId = request.input[index].call_id;
    const worker = callId ? workersByCallId.get(callId) : undefined;
    if (worker?.model !== request.model) continue;
    if (worker.toolSignature === toolSignature(request)) return worker;
    worker.close();
    return undefined;
  }
  return undefined;
}

function toolSignature(request: ResponsesRequest): string {
  return JSON.stringify(toolDescriptors(request.tools ?? []).map((tool) => tool.proxyName));
}

export function estimateVisibleTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

export async function runClaude(request: ResponsesRequest): Promise<ProxyOutput> {
  let worker = continuationWorker(request);
  const delta = worker ? continuationRequest(request, worker.callIds) : undefined;
  let prepared = await prepareClaudePrompt(delta ?? request);
  let result: ClaudeResult;
  try {
    result = await (worker ??= new ClaudeWorker(request)).run(prepared.prompt);
  } catch (error) {
    if (!delta) {
      worker?.close();
      throw error;
    }
    worker!.close();
    await prepared.cleanup();
    prepared = await prepareClaudePrompt(request);
    worker = new ClaudeWorker(request);
    try {
      result = await worker.run(prepared.prompt);
    } catch (fallbackError) {
      worker.close();
      throw fallbackError;
    }
  } finally {
    await prepared.cleanup();
  }
  if (result.is_error) {
    worker.close();
    throw new Error(result.result || "Claude CLI returned an error");
  }
  let structured: ClaudeResult["structured_output"];
  try {
    structured = result.structured_output ?? JSON.parse(result.result ?? "{}") as ClaudeResult["structured_output"];
  } catch {
    worker.close();
    throw new Error("Claude CLI returned invalid structured output");
  }
  if (!structured || typeof structured.text !== "string" || !Array.isArray(structured.tool_calls)) {
    worker.close();
    throw new Error("Claude CLI returned invalid structured output");
  }
  const allowedTools = new Set(toolDescriptors(request.tools ?? []).map((tool) => tool.proxyName));
  for (const call of structured.tool_calls) {
    if (!allowedTools.has(call.name)) {
      worker.close();
      throw new Error(`Claude CLI requested unavailable tool: ${call.name}`);
    }
  }
  const toolCalls = structured.tool_calls.map((call) => ({ ...call, callId: `call_${crypto.randomUUID().replaceAll("-", "")}` }));
  const descriptorTypes = new Map(toolDescriptors(request.tools ?? []).map((tool) => [tool.proxyName, tool.type]));
  const canContinue = toolCalls.length > 0 && toolCalls.every((call) => descriptorTypes.get(call.name) !== "tool_search");
  if (canContinue) worker.retainFor(toolCalls.map((call) => call.callId));
  else worker.close();
  // Claude Code's usage includes its private system prompt, native tool schemas,
  // plugins, MCP definitions, and cache activity. Reporting that hidden runtime
  // overhead makes Codex believe its own conversation exceeds the context window.
  // Only report the request/output content that Codex can retain or compact.
  const inputTokens = estimateVisibleTokens(requestToPrompt(request));
  const outputTokens = estimateVisibleTokens(structured.text + JSON.stringify(toolCalls));
  return {
    text: structured.text,
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}
