import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accounts from "../accounts";
import { accountEnv, isLimited, listAccounts, type Account } from "../accounts";
import type { ClaudeInputBlock } from "../request";
import { stateDir, threadAccount } from "../sessions";
import type { ClaudeResult } from "../types";
import { recordUsage } from "../usage";
import {
  COMPACTION_PROMPT,
  LINE_BYTES,
  compressTask,
  mergeTask,
  tooLongTask,
} from "./prompts";
import type { ThreadStore } from "./store";
import { advanceView, nodeEnd, nodeName, renderView, viewLine, type NodeRef } from "./view";

/**
 * Builds the summary tree in the background (gist sections 2 and 4). Each node
 * is built once and logged. Turns never wait for it: messages it has not
 * reached yet are sent raw after the view.
 */

export type SummaryConversation = {
  /** Sends one user message in this conversation and returns the reply text. */
  ask(content: ClaudeInputBlock[]): Promise<string>;
  close(): void;
};
export type SummaryRunner = (threadId: string) => SummaryConversation;

export type CompactorOptions = {
  threadId: string;
  runner: SummaryRunner;
  concurrency?: number;
  contextMin?: number;
  contextMax?: number;
  /** First retry delay after a failed call; doubles per failure. */
  retryMs?: number;
  now?: () => number;
};

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const MAX_ATTEMPTS = 5;
/** A line this far over the limit is accepted: the view measures real sizes. */
const SLACK_BYTES = 24;
const MAX_RETRY_MS = 30 * 60_000;
/** Claude Code marks its own cache entries with a 1-hour lifetime; ours must match. */
export const CACHE_MARK = { type: "ephemeral", ttl: "1h" } as const;

/** Text blocks for a rendered view with one cache mark, by default on the last whole block. */
export function viewBlocks(lines: string[], mark?: number): ClaudeInputBlock[] {
  const { blocks, whole } = renderView(lines);
  const at = mark !== undefined && mark >= 0 && mark < whole ? mark : whole - 1;
  return blocks.map((text, index) =>
    index === at ? { type: "text", text, cache_control: CACHE_MARK } : { type: "text", text },
  );
}

export class Compactor {
  private readonly inflight = new Set<string>();
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  private readonly ready: NodeRef[] = [];
  private readonly queued = new Set<string>();
  private leafCursor = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(
    private readonly store: ThreadStore,
    private readonly options: CompactorOptions,
  ) {
    this.concurrency = options.concurrency ?? 8;
    this.now = options.now ?? Date.now;
    for (const [level, index] of store.builtNodes()) this.considerParent(level, index);
    this.advanceContext();
  }

  /** Starts whatever work is ready. Called after every logged message. */
  kick(): void {
    for (;;) {
      const next = this.nextTask();
      if (!next) break;
      this.start(next);
    }
    if (this.inflight.size === 0) for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** Resolves once no call is running (tests and the smoke script use it). */
  idle(): Promise<void> {
    if (this.inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get running(): number {
    return this.inflight.size;
  }

  private canStart(ref: NodeRef): boolean {
    const key = ref.join(":");
    if (this.inflight.has(key) || this.store.built(...ref)) return false;
    const failure = this.failures.get(key);
    return !failure || failure.retryAt <= this.now();
  }

  /**
   * Free nodes first (they cost no call), then merges whose halves are built,
   * then leaves: a message starts once fewer than `concurrency` messages
   * before it are still unbuilt, so each call's context is nearly complete.
   * Work comes from queues; the tree is never scanned.
   */
  private nextTask(): NodeRef | undefined {
    const slots = this.inflight.size < this.concurrency;
    for (let k = 0; k < this.ready.length; k++) {
      const ref = this.ready[k];
      if (this.store.built(...ref)) {
        this.ready.splice(k--, 1);
        this.queued.delete(ref.join(":"));
        continue;
      }
      if (this.canStart(ref) && (slots || this.freeText(ref) !== undefined)) return ref;
    }
    while (this.leafCursor < this.store.length && this.store.built(0, this.leafCursor)) this.leafCursor++;
    let unbuilt = 0;
    for (let index = this.leafCursor; index < this.store.length && unbuilt < this.concurrency; index++) {
      if (this.store.built(0, index)) continue;
      unbuilt++;
      const ref: NodeRef = [0, index];
      if (this.canStart(ref) && (slots || this.freeText(ref) !== undefined)) return ref;
    }
    return undefined;
  }

  /** A node that needs no model call: a short message, or two short lines. */
  private freeText([level, index]: NodeRef): string | undefined {
    if (level === 0) {
      const message = this.store.messages[index];
      const text = `${message.kind}: ${message.text}`;
      return !message.images?.length && bytes(text) <= LINE_BYTES ? text : undefined;
    }
    const a = this.store.node(level - 1, 2 * index);
    const b = this.store.node(level - 1, 2 * index + 1);
    if (a === undefined || b === undefined) return undefined;
    const joined = `${a}\n${b}`;
    return bytes(joined) <= LINE_BYTES ? joined : undefined;
  }

  private start(ref: NodeRef): void {
    const free = this.freeText(ref);
    if (free !== undefined) {
      this.finish(ref, free);
      return;
    }
    const key = ref.join(":");
    this.inflight.add(key);
    void this.build(ref)
      .then(
        (text) => {
          this.failures.delete(key);
          this.finish(ref, text);
        },
        (error) => {
          const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
          const delay = Math.min(MAX_RETRY_MS, (this.options.retryMs ?? 15_000) * 2 ** (attempts - 1));
          this.failures.set(key, { attempts, retryAt: this.now() + delay });
          // Error names only: messages may quote the chat.
          console.error(`perpetual: building ${nodeName(ref)} failed (${(error as Error).name}); retrying later`);
        },
      )
      .finally(() => {
        this.inflight.delete(key);
        this.kick();
      });
  }

  private finish(ref: NodeRef, text: string): void {
    this.store.addNode(ref[0], ref[1], text);
    this.considerParent(...ref);
    if (ref[0] === 0) this.advanceContext();
  }

  private considerParent(level: number, index: number): void {
    if (!this.store.built(level, index ^ 1)) return;
    const parent: NodeRef = [level + 1, index >> 1];
    const key = parent.join(":");
    if (this.store.built(...parent) || this.queued.has(key)) return;
    this.queued.add(key);
    this.ready.push(parent);
  }

  /** The compactions' view: 16-32 KB of built lines, with the same sawtooth. */
  private advanceContext(): void {
    const view = this.store.cview;
    let end = view.end;
    while (end < this.store.length && this.store.built(0, end)) end++;
    if (end === view.end && !view.shrinking) return;
    const lineBytes = (ref: NodeRef) => bytes(this.line(ref)) + 1;
    advanceView(
      view,
      end,
      lineBytes,
      (level, index) => this.store.built(level, index),
      this.options.contextMin ?? 16_000,
      this.options.contextMax ?? 32_000,
    );
    this.store.saveCView();
  }

  private line(ref: NodeRef): string {
    return viewLine(ref, this.store.node(...ref) ?? "");
  }

  /** Context lines that end at or before `limit`: built lines only, never part of a message. */
  private context(limit: number): ClaudeInputBlock[] {
    const lines = this.store.cview.lines.filter((ref) => nodeEnd(ref) <= limit).map((ref) => this.line(ref));
    return viewBlocks(lines);
  }

  private async build([level, index]: NodeRef): Promise<string> {
    let content: ClaudeInputBlock[];
    if (level === 0) {
      const message = this.store.messages[index];
      const images: ClaudeInputBlock[] = [];
      for (const image of message.images ?? []) {
        const block = imageBlock(image.path, image.caption);
        if (block) images.push(block);
      }
      content = [
        ...this.context(index),
        { type: "text", text: compressTask(index, message.kind, message.text, images.length) },
        ...images,
      ];
    } else {
      const a: NodeRef = [level - 1, 2 * index];
      const b: NodeRef = [level - 1, 2 * index + 1];
      const end = nodeEnd([level, index]);
      content = [
        ...this.context(end),
        {
          type: "text",
          text: mergeTask(nodeName(a), nodeName(b), index * 2 ** level, end, this.line(a), this.line(b)),
        },
      ];
    }
    const conversation = this.options.runner(this.options.threadId);
    try {
      let reply = cleanLine(await conversation.ask(content));
      let best = reply;
      for (let attempt = 1; attempt < MAX_ATTEMPTS && bytes(reply) > LINE_BYTES + SLACK_BYTES; attempt++) {
        reply = cleanLine(await conversation.ask([{ type: "text", text: tooLongTask(bytes(reply), reply) }]));
        if (reply && bytes(reply) < bytes(best)) best = reply;
      }
      if (!best) throw new Error("empty summary");
      return best;
    } finally {
      conversation.close();
    }
  }
}

/** Drops a head the model may copy (`12+4|`) and surrounding whitespace. */
function cleanLine(text: string): string {
  return text.trim().replace(/^\d+\+\d+\|\s*/, "").trim();
}

function imageBlock(path: string, caption: string): ClaudeInputBlock | undefined {
  const mediaType = /^image\/[a-z0-9.+-]+/.exec(caption)?.[0];
  if (!mediaType || !path.startsWith("/")) return undefined;
  try {
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") },
    };
  } catch {
    return undefined;
  }
}

export { imageBlock as loggedImageBlock };

// ---- Alternative runner: one `codex exec` per call (gpt-* models) ----

/**
 * A private CODEX_HOME so summaries skip Alex's config, hooks, MCP servers and
 * AGENTS.md, and never show up as threads. It shares his ChatGPT login through
 * a symlink to ~/.codex/auth.json.
 */
function summaryCodexHome(): string {
  const home = join(stateDir(), "perpetual", "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = join(home, "auth.json");
  const target = join(process.env.HOME ?? "", ".codex", "auth.json");
  let linked = false;
  try {
    linked = lstatSync(auth).isSymbolicLink();
  } catch {}
  if (!linked) {
    rmSync(auth, { force: true });
    symlinkSync(target, auth);
  }
  if (!existsSync(join(home, "config.toml"))) writeFileSync(join(home, "config.toml"), "", { mode: 0o600 });
  return home;
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function codexRunner(model: string, effort?: string): SummaryRunner {
  return () => {
    // Codex exec is one-shot, so a follow-up (the "too long" retry) replays the earlier exchange as text.
    const history: string[] = [];
    return {
      async ask(content) {
        const directory = mkdtempSync(join(tmpdir(), "perp-summary-"));
        try {
          const texts: string[] = [];
          const images: string[] = [];
          for (const block of content as any[]) {
            if (block.type === "text") texts.push(block.text);
            else if (block.type === "image" && block.source?.type === "base64") {
              const path = join(directory, `image-${images.length}.${IMAGE_EXT[block.source.media_type] ?? "png"}`);
              writeFileSync(path, Buffer.from(block.source.data, "base64"));
              images.push(path);
            }
          }
          const task = texts.join("\n\n");
          const prompt = [
            COMPACTION_PROMPT,
            "Reply with the line only. Do not run commands or use tools.",
            ...(history.length ? ["Earlier in this task:", ...history] : []),
            task,
          ].join("\n\n");
          const out = join(directory, "out.txt");
          const child = Bun.spawn(
            [
              process.env.CODEX_BIN ?? "codex",
              "exec",
              "--ephemeral",
              "--skip-git-repo-check",
              "-s",
              "read-only",
              "-C",
              directory,
              "-m",
              model,
              ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
              ...images.flatMap((path) => ["-i", path]),
              "-o",
              out,
              "-",
            ],
            {
              stdin: new TextEncoder().encode(prompt),
              stdout: "ignore",
              stderr: "ignore",
              cwd: directory,
              env: { ...process.env, CODEX_HOME: summaryCodexHome() },
            },
          );
          const deadline = setTimeout(() => child.kill(), SUMMARY_TIMEOUT_MS);
          const code = await child.exited.finally(() => clearTimeout(deadline));
          let reply = "";
          try {
            reply = readFileSync(out, "utf8");
          } catch {}
          if (code !== 0 || !reply.trim()) throw new Error(`summarizer (codex ${model}) exited ${code}`);
          history.push(`Task:\n${task}`, `Your reply:\n${reply.trim()}`);
          return reply;
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
      close() {},
    };
  };
}

/** gpt-* (and o-series) models run through Codex; everything else through Claude Code. */
export function summaryRunner(model: string, effort?: string): SummaryRunner {
  return /^(gpt-|o\d)/.test(model) ? codexRunner(model, effort) : claudeRunner(model, effort);
}

// ---- The default runner: one Claude Code process per compaction ----

/** Prefer the newer check that also skips accounts whose login failed. */
const unavailable: (account: Account) => boolean =
  ((accounts as Record<string, unknown>).isUnavailable as ((account: Account) => boolean) | undefined) ??
  ((account: Account) => isLimited(account));

/** The thread's pinned account when it can serve, else the first that can. */
function summaryAccount(threadId: string): Account {
  const all = listAccounts();
  let pinned: string | undefined;
  try {
    pinned = threadAccount(threadId);
  } catch {}
  return (
    all.find((account) => account.name === pinned && !unavailable(account)) ??
    all.find((account) => !unavailable(account)) ??
    all[0]
  );
}

function compactionPromptFile(): string {
  const directory = join(stateDir(), "perpetual");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = new Bun.CryptoHasher("sha256").update(COMPACTION_PROMPT).digest("hex").slice(0, 16);
  const path = join(directory, `compaction-prompt-${hash}.txt`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, COMPACTION_PROMPT, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

const SUMMARY_TIMEOUT_MS = 180_000;

export function claudeRunner(model: string, effort?: string): SummaryRunner {
  return (threadId) => {
    const account = summaryAccount(threadId);
    const { CLAUDECODE: _nested, CLAUDE_CODE_EFFORT_LEVEL: _effort, ...env } = process.env;
    const child = Bun.spawn(
      [
        process.env.CLAUDE_BIN ?? "claude",
        ...(effort ? ["--effort", effort] : []),
        "-p",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--safe-mode",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "",
        "--system-prompt-file",
        compactionPromptFile(),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        cwd: process.env.CLAUDE_CWD || process.cwd(),
        env: { ...env, ...accountEnv(account) },
      },
    );
    const results: ClaudeResult[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          let event: { type?: string; rate_limit_info?: Record<string, unknown> };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "rate_limit_event") accounts.observeRateLimit(account, event.rate_limit_info ?? {});
          if (event.type === "result") {
            results.push(event as ClaudeResult);
            wake?.();
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        ended = true;
        wake?.();
      });
    const requestId = crypto.randomUUID();
    let turn = 0;
    return {
      async ask(content) {
        turn++;
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
        child.stdin.flush();
        const deadline = setTimeout(() => child.kill(), SUMMARY_TIMEOUT_MS);
        try {
          while (results.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
        } finally {
          clearTimeout(deadline);
        }
        const result = results.shift();
        if (!result) throw new Error("summarizer exited without a result");
        recordUsage(result, {
          requestId,
          workerId: requestId,
          workerTurn: turn,
          model,
          effort,
          attempt: 1,
          launchMode: "perpetual-summary",
          resumed: false,
          threadId,
          account: account.name,
        });
        if (result.is_error || typeof result.result !== "string") {
          const status = result.api_error_status;
          if (accounts.isLimitError(status, result.result)) accounts.markLimited(account);
          throw new Error(`summarizer error${status ? ` ${status}` : ""}`);
        }
        return result.result;
      },
      close() {
        try {
          child.stdin.end();
        } catch {}
      },
    };
  };
}
