import { homedir } from "node:os";
import { accountEnv, isUnavailable, listAccounts } from "./accounts";
import { STRIPPED_ENV } from "./claude-env";
import { MIN_PREDICTION_CONFIDENCE, parsePredictionReply, PREDICTION_SYSTEM } from "./predictions";

type Child = Bun.Subprocess<"pipe", "pipe", "ignore">;
/** Tokens of one Haiku call, as Claude Code's result reports them. */
export type PredictionTokens = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};
export type PredictionModelMetrics = {
  warm: boolean;
  spawnMs: number;
  initMs?: number;
  modelMs: number;
  apiMs?: number;
  totalMs: number;
  tokens?: PredictionTokens;
  /** The model made a guess but stated less than MIN_PREDICTION_CONFIDENCE: nothing shown. */
  lowConfidence?: boolean;
};
type Result = { text: string; apiMs?: number; tokens?: PredictionTokens; lowConfidence?: boolean };

const tokenCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** The text to show from Haiku's JSON, and whether a guess was held back as unsure. */
function shownGuess(result: string): { text: string; lowConfidence?: boolean } {
  const parsed = parsePredictionReply(result);
  if (!parsed) return { text: "" };
  if (parsed.confidence >= MIN_PREDICTION_CONFIDENCE) return { text: parsed.prediction };
  return parsed.prediction.trim() ? { text: "", lowConfidence: true } : { text: "" };
}
export function predictionTokens(usage: unknown): PredictionTokens | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  return {
    inputTokens: tokenCount(raw.input_tokens),
    cacheReadTokens: tokenCount(raw.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(raw.cache_creation_input_tokens),
    outputTokens: tokenCount(raw.output_tokens),
  };
}
type Worker = {
  child: Child;
  born: number;
  spawnMs: number;
  initAt?: number;
  output: Promise<Result>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

/** Each process receives one prompt only. Prewarming cannot share chat context. */
export class PredictionModelPool {
  private idle?: Worker;
  private workers = new Set<Worker>();
  private warming = false;
  private closed = false;

  constructor(private launch: () => Child = launchSubscriptionModel) {}

  prewarm(): void {
    if (this.closed) return;
    this.warming = true;
    this.fillIdle();
  }

  private fillIdle(): void {
    if (!this.warming || this.closed || this.idle) return;
    try {
      const worker = this.start();
      this.idle = worker;
      worker.idleTimer = setTimeout(() => {
        if (this.idle === worker) this.idle = undefined;
        void this.stop(worker);
      }, 60000);
      worker.idleTimer.unref();
    } catch {
      // No subscription account must not break the caller's ordinary request.
    }
  }

  private start(): Worker {
    const born = performance.now();
    const child = this.launch();
    const worker: Worker = {
      child,
      born,
      spawnMs: performance.now() - born,
      output: Promise.resolve({ text: "" }),
    };
    this.workers.add(worker);
    worker.output = this.read(worker);
    void worker.output.catch(() => this.stop(worker));
    void child.exited.then(() => {
      this.workers.delete(worker);
      if (this.idle === worker) this.idle = undefined;
      clearTimeout(worker.idleTimer);
    });
    return worker;
  }

  private async read(worker: Worker): Promise<Result> {
    const decoder = new TextDecoder();
    let buffer = "",
      bytes = 0;
    const parse = (line: string): Result | undefined => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "system" && event.subtype === "init")
        worker.initAt = performance.now();
      if (event.type !== "result") return;
      if (event.is_error || typeof event.result !== "string")
        throw new Error("prediction model failed");
      return {
        ...shownGuess(event.result),
        apiMs:
          typeof event.duration_api_ms === "number"
            ? event.duration_api_ms
            : undefined,
        tokens: predictionTokens(event.usage),
      };
    };
    for await (const chunk of worker.child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 64000) throw new Error("oversized prediction model output");
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const result = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (result) return result;
      }
    }
    buffer += decoder.decode();
    const result = parse(buffer);
    if (result) return result;
    throw new Error("prediction model exited without a result");
  }

  private async stop(worker: Worker): Promise<void> {
    clearTimeout(worker.idleTimer);
    if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
    await worker.child.exited;
    this.workers.delete(worker);
  }

  async generate(
    prompt: string,
    signal?: AbortSignal,
    onMetrics?: (metrics: PredictionModelMetrics) => void,
    deadlineMs = Date.now() + 11000,
  ): Promise<string> {
    if (this.closed) throw new Error("prediction pool closed");
    signal?.throwIfAborted();
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("prediction deadline exceeded");
    const started = performance.now();
    const warm = this.idle !== undefined;
    const worker = this.idle ?? this.start();
    this.idle = undefined;
    clearTimeout(worker.idleTimer);
    this.fillIdle();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("prediction cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () => reject(new Error("prediction deadline exceeded")),
          remaining,
        );
        if (signal?.aborted) abort();
      });
      worker.child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: prompt },
        }) + "\n",
      );
      worker.child.stdin.flush();
      const result = await Promise.race([worker.output, cancelled]);
      signal?.throwIfAborted();
      if (Date.now() >= deadlineMs)
        throw new Error("prediction deadline exceeded");
      const ended = performance.now();
      onMetrics?.({
        warm,
        spawnMs: worker.spawnMs,
        initMs:
          worker.initAt === undefined
            ? undefined
            : Math.max(0, worker.initAt - started),
        modelMs: ended - Math.max(started, worker.initAt ?? started),
        apiMs: result.apiMs,
        totalMs: ended - started,
        tokens: result.tokens,
        ...(result.lowConfidence ? { lowConfidence: true } : {}),
      });
      return result.text;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      await this.stop(worker);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.idle = undefined;
    await Promise.all([...this.workers].map((worker) => this.stop(worker)));
  }
}

function launchSubscriptionModel(): Child {
  const account = listAccounts().find((account) => !isUnavailable(account));
  if (!account) throw new Error("no subscription account available");
  const env = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  return Bun.spawn(
    [
      process.env.CLAUDE_BIN ?? "claude",
      "-p",
      "--no-session-persistence",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--safe-mode",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
      "--max-turns",
      "1",
      "--system-prompt",
      PREDICTION_SYSTEM,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      cwd: homedir(),
      env: { ...env, ...accountEnv(account), CLAUDE_CODE_EFFORT_LEVEL: "low" },
    },
  );
}

const pool = new PredictionModelPool();
export const prewarmPredictionModel = () => pool.prewarm();
export const closePredictionModel = () => pool.close();
export const generatePrediction = (
  prompt: string,
  signal?: AbortSignal,
  onMetrics?: (metrics: PredictionModelMetrics) => void,
  deadlineMs?: number,
) => pool.generate(prompt, signal, onMetrics, deadlineMs);
