import { outputSchema, prepareClaudePrompt } from "./request";
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
    "--output-format", "json",
    "--model", resolveModel(request.model),
    "--append-system-prompt", CODEX_TOOL_SYSTEM_PROMPT,
    "--json-schema", JSON.stringify(outputSchema(request.tools ?? [])),
  ];
}

function parseResult(stdout: string): ClaudeResult {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]) as ClaudeResult;
      if (value.type === "result") return value;
    } catch {
      // Ignore non-JSON diagnostics and continue looking for the result.
    }
  }
  throw new Error("Claude CLI did not return a result");
}

export async function runClaude(request: ResponsesRequest): Promise<ProxyOutput> {
  const args = buildClaudeArgs(request);
  const prepared = await prepareClaudePrompt(request);

  const subprocess = Bun.spawn([process.env.CLAUDE_BIN ?? "claude", ...args], {
    stdin: new Blob([prepared.prompt]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.env.CLAUDE_CWD || process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CLAUDECODE")) as Record<string, string>,
  });
  const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS ?? 900_000);
  const timeout = setTimeout(() => subprocess.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]).finally(async () => {
    clearTimeout(timeout);
    await prepared.cleanup();
  });

  if (exitCode !== 0) throw new Error(stderr.trim() || `Claude CLI exited with code ${exitCode}`);
  const result = parseResult(stdout);
  if (result.is_error) throw new Error(result.result || "Claude CLI returned an error");
  const structured = result.structured_output ?? JSON.parse(result.result ?? "{}") as ClaudeResult["structured_output"];
  if (!structured || typeof structured.text !== "string" || !Array.isArray(structured.tool_calls)) {
    throw new Error("Claude CLI returned invalid structured output");
  }
  const inputTokens = (result.usage?.input_tokens ?? 0)
    + (result.usage?.cache_creation_input_tokens ?? 0)
    + (result.usage?.cache_read_input_tokens ?? 0);
  const outputTokens = result.usage?.output_tokens ?? 0;
  return {
    text: structured.text,
    toolCalls: structured.tool_calls,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}
