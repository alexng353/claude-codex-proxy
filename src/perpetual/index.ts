import { readFileSync } from "node:fs";
import { join } from "node:path";
import { turnMetadata } from "../hygiene";
import { scrubText } from "../scrub.mjs";
import {
  PERPETUAL_VIEW_TYPE,
  isCompactionRequest,
  leadingContextCount,
  textFromContent,
} from "../request";
import { stateDir } from "../sessions";
import type {
  ProxyOutput,
  ResponseContentPart,
  ResponseInputItem,
  ResponsesRequest,
  ResponseTool,
} from "../types";
import { codexTitle, inScope, loadConfig, type PerpetualConfig, type TitleLookup } from "./config";
import {
  isLogged,
  isMessage,
  isModelOutput,
  isToolOutput,
  itemKeys,
  itemMessages,
} from "./messages";
import { TURN_PROMPT } from "./prompts";
import {
  FINAL_PREFIX,
  LockedError,
  ThreadStore,
  type Injection,
  type LogMessage,
  type NewMessage,
} from "./store";
import { Compactor, summaryRunner, viewBlocks, type SummaryRunner } from "./summarizer";
import { BLOCK_LINES, advanceView, nextMark, nodeStart, viewLine, type NodeRef } from "./view";

/**
 * Perpetual chats: a Codex thread whose history the proxy replaces with a
 * summary view plus the raw messages the view does not cover yet.
 *
 *   [tools][system prompt][view][unsummarized raw items][current turn]
 *
 * The current turn (Alex's message and every tool call and result since)
 * stays raw, so tool loops continue in the same Claude worker. The view only
 * changes when a new turn starts. Other threads are never touched.
 */

export const ZOOM_TOOL = "zoom";
export const DATE_TOOL = "date";
const LOCAL_TOOLS: ResponseTool[] = [
  {
    type: "function",
    name: ZOOM_TOOL,
    description:
      "Open the line id+n of the perpetual-memory view into the two lines of n/2 under it; n = 1 gives message id whole, with its images. n is a power of 2 and id a multiple of n. Answered by the proxy from this chat's log.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", minimum: 0 }, n: { type: "integer", minimum: 1 } },
      required: ["id", "n"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: DATE_TOOL,
    description: "The date and time of message id in this chat's log. Answered by the proxy.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", minimum: 0 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const TURN_PROMPT_ITEM: ResponseInputItem = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: TURN_PROMPT }],
};

/** What a Codex compaction gets: the log already keeps everything. */
export const COMPACTION_NOTE =
  "This chat runs in the proxy's perpetual-memory mode. Its whole history is kept in the proxy's log and summary tree, and every turn receives a view of it, so this compaction keeps nothing else.";

/** Hops of proxy-answered calls inside one Codex request before zoom is refused. */
const LOCAL_HOP_LIMIT = 24;
/** Hops after which the answer goes to Codex without its proxy calls. */
const LOCAL_HOP_STOP = LOCAL_HOP_LIMIT + 4;

type Thread = {
  store: ThreadStore;
  compactor: Compactor;
};
const threads = new Map<string, Thread>();

export type PerpetualDeps = {
  config?: () => PerpetualConfig | undefined;
  title?: TitleLookup;
  runner?: SummaryRunner;
  root?: string;
};
let deps: PerpetualDeps = {};

/** Test seam: replaces config, title lookup, summarizer and storage root. */
export function setPerpetualDeps(next: PerpetualDeps): void {
  deps = next;
  threads.clear();
}

const root = () => deps.root ?? join(stateDir(), "perpetual");
const safeName = (threadId: string) => threadId.replace(/[^A-Za-z0-9_-]/g, "_");

function openThread(threadId: string, config: PerpetualConfig): Thread {
  const existing = threads.get(threadId);
  if (existing) return existing;
  const store = new ThreadStore(join(root(), safeName(threadId)));
  const compactor = new Compactor(store, {
    threadId,
    runner: deps.runner ?? summaryRunner(config.summaryModel, config.summaryEffort),
  });
  const thread = { store, compactor };
  threads.set(threadId, thread);
  return thread;
}

/** An open perpetual chat, for the status route and tests. */
export const perpetualThread = (threadId: string): Thread | undefined => threads.get(threadId);

export type PerpetualPlan = {
  /** The request Claude receives on the first hop. */
  request: ResponsesRequest;
  /**
   * Runs the turn, answering zoom and date itself; Codex sees only the rest.
   * `signal` is Codex's connection: once it is gone, the answer is not logged.
   */
  run(runClaude: (request: ResponsesRequest) => Promise<ProxyOutput>, signal?: AbortSignal): Promise<ProxyOutput>;
};

/**
 * The perpetual form of a request, or undefined to pass it through untouched:
 * threads out of scope, subagents, non-turn requests, and any failure here.
 */
export function preparePerpetual(request: ResponsesRequest): PerpetualPlan | undefined {
  try {
    return prepare(request);
  } catch (error) {
    // Fail open to the ordinary path; names only, since messages quote the chat.
    console.error(
      error instanceof LockedError
        ? `perpetual: ${error.message}; passing the request through`
        : `perpetual: ${(error as Error).name} while preparing; passing the request through`,
    );
    return undefined;
  }
}

function prepare(request: ResponsesRequest): PerpetualPlan | undefined {
  if (!Array.isArray(request.input)) return undefined;
  const threadId = request.prompt_cache_key;
  if (typeof threadId !== "string" || !threadId) return undefined;
  const meta = turnMetadata(request);
  // Subagents share their parent's prompt_cache_key; they keep their own history.
  if (meta.threadSource === "subagent" || meta.threadSource === "memory_consolidation") return undefined;
  const compaction = isCompactionRequest(request);
  // Codex tags remote compaction request_kind "compaction". Passing it through
  // would replay the chat's whole raw history, which outgrows Claude's window.
  if (meta.requestKind && meta.requestKind !== "turn" && !(compaction && meta.requestKind === "compaction"))
    return undefined;
  const config = (deps.config ?? loadConfig)();
  if (!config || !inScope(config, threadId, deps.title ?? codexTitle)) return undefined;
  if (compaction)
    return {
      request,
      run: async () => ({
        text: "",
        toolCalls: [],
        compaction: COMPACTION_NOTE,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    };
  const thread = openThread(threadId, config);
  return new Turn(thread, request, config).plan();
}

/** Where the current turn starts: after the last final answer, or an aborted turn. */
export function currentTurnStart(items: ResponseInputItem[]): number {
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k];
    if (isMessage(item) && item.role === "assistant") {
      const next = items[k + 1];
      if (!next) return items.length;
      if (!isModelOutput(next) && !isToolOutput(next)) return k + 1;
    }
    if (isMessage(item) && item.role === "user" && textFromContent(item.content).trimStart().startsWith("<turn_aborted>"))
      return k + 1;
  }
  return 0;
}

/** view.json also keeps which block carries the cache mark (see nextMark). */
type ViewWithMark = { mark?: number };

class Turn {
  private readonly store: ThreadStore;
  private readonly input: ResponseInputItem[];
  private readonly lead: number;
  private readonly conv: ResponseInputItem[];
  private readonly keys: string[];

  constructor(
    private readonly thread: Thread,
    private readonly original: ResponsesRequest,
    private readonly config: PerpetualConfig,
  ) {
    this.store = thread.store;
    this.input = original.input as ResponseInputItem[];
    this.lead = leadingContextCount(this.input);
    this.conv = this.input.slice(this.lead);
    this.keys = itemKeys(this.conv);
  }

  plan(): PerpetualPlan {
    this.logNewItems();
    const start = currentTurnStart(this.conv);
    const turn = this.conv.slice(start);
    const startsTurn = turn.length > 0 && turn.every((item) => isMessage(item) && item.role !== "assistant");
    if (startsTurn) this.advance(this.recentCut(this.boundary(start)));
    const raw = this.rawItems(start);
    if (startsTurn) this.pruneInjections(raw.anchors);
    const anchor = this.keys.at(-1) ?? "^";
    const request: ResponsesRequest = {
      ...this.original,
      input: [TURN_PROMPT_ITEM, ...this.input.slice(0, this.lead), ...this.viewItem(), ...raw.items],
      tools: [
        ...(this.original.tools ?? []),
        ...LOCAL_TOOLS.filter((tool) => !(this.original.tools ?? []).some((other) => other.name === tool.name)),
      ],
    };
    return { request, run: (runClaude, signal) => this.run(request, anchor, runClaude, signal) };
  }

  private logNewItems(): void {
    const fresh: NewMessage[] = [];
    const seen = new Set<string>();
    const save = (type: string, data: Buffer) => this.store.saveImage(type, data);
    for (const [k, item] of this.conv.entries()) {
      const key = this.keys[k];
      if (!isLogged(item) || this.store.idsOf(key) || seen.has(key)) continue;
      seen.add(key);
      const messages = itemMessages(item, key, save);
      // The echo of a final answer logged when its turn ended: nothing new
      // comes before it, so it would have landed exactly on those ids.
      const pending = fresh.length === 0 ? this.store.pendingFinal() : undefined;
      if (pending && isMessage(item) && item.role === "assistant" && sameMessages(messages, pending)) {
        this.store.alias(key, pending[0].key);
        continue;
      }
      fresh.push(...messages);
    }
    if (fresh.length) this.store.append(fresh);
    this.kick();
  }

  /**
   * Logs a turn's final answer as soon as it is returned, instead of when
   * Codex echoes it on the next request; logNewItems then aliases the echo.
   * Two rare cases keep an extra message without reordering ids: an answer
   * Codex loses after the proxy returned it (a hang-up during delivery, or a
   * retry answered differently), and an echo whose text differs, which is
   * logged again after it.
   */
  private logFinal(text: string, anchor: string): void {
    // The same redaction every incoming item gets (scrubRequest): a secret in an
    // answer must not reach the log, and the scrubbed echo must match this copy.
    text = scrubText(text);
    const item: ResponseInputItem = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
    const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 32);
    // The key carries the answer and the request it answers, so a retry after a
    // restart is still recognised (the log is the only durable record).
    const identity = `${FINAL_PREFIX}${digest(text)}~${digest(anchor)}@`;
    const key = `${identity}${this.store.length}`;
    const messages = itemMessages(item, key, (type, data) => this.store.saveImage(type, data));
    // A retried request (same history) answered the same way: Codex keeps one copy.
    const pending = this.store.pendingFinal();
    if (pending && pending[0].key.startsWith(identity) && sameMessages(messages, pending)) return;
    this.store.append(messages);
    this.kick();
  }

  private kick(): void {
    try {
      this.thread.compactor.kick();
    } catch (error) {
      console.error("perpetual: summarizer scheduling failed:", (error as Error).name);
    }
  }

  /** The first log id of the current turn: the view never reaches into it. */
  private boundary(start: number): number {
    let boundary = this.store.length;
    for (let k = start; k < this.conv.length; k++)
      for (const id of this.store.idsOf(this.keys[k]) ?? []) boundary = Math.min(boundary, id);
    return boundary;
  }

  /**
   * Holds the newest messages before `boundary` out of the view, up to
   * `recentBytes`, so they reach the model raw (short-term memory). Only
   * messages Codex still sends can stay raw; the view never moves back.
   */
  private recentCut(boundary: number): number {
    const budget = this.config.recentBytes ?? 0;
    if (budget <= 0) return boundary;
    const present = new Set<number>();
    for (const key of this.keys) for (const id of this.store.idsOf(key) ?? []) present.add(id);
    let cut = boundary;
    let used = 0;
    const local = (i: number) => this.store.messages[i]?.key.startsWith("local:") ?? false;
    while (cut > this.store.view.end) {
      const message = this.store.messages[cut - 1];
      if (!message || !(present.has(message.i) || local(message.i)) || used + message.size > budget) break;
      used += message.size;
      cut--;
    }
    // Proxy-answered items stay raw only beside their anchor, so a cut that
    // would strand them without it leaves them in the view.
    while (cut < boundary && local(cut)) cut++;
    return cut;
  }

  /** Appends built leaves up to the turn and runs the sawtooth; only at a turn start. */
  private advance(boundary: number): void {
    const store = this.store;
    const view = store.view as typeof store.view & ViewWithMark;
    let end = view.end;
    while (end < boundary && store.built(0, end)) end++;
    if (end === view.end && !view.shrinking) return;
    const lineBytes = (ref: NodeRef) => Buffer.byteLength(this.line(ref), "utf8") + 1;
    const merged = advanceView(
      view,
      end,
      lineBytes,
      (level, index) => store.built(level, index),
      this.config.viewMin,
      this.config.viewMax,
    );
    view.mark = nextMark(view.mark, Math.floor(view.lines.length / BLOCK_LINES), merged);
    store.saveView();
  }

  private line(ref: NodeRef): string {
    return viewLine(ref, this.store.node(...ref) ?? "");
  }

  private viewItem(): ResponseInputItem[] {
    const view = this.store.view as typeof this.store.view & ViewWithMark;
    if (view.lines.length === 0) return [];
    const blocks = viewBlocks(view.lines.map((ref) => this.line(ref)), view.mark);
    const content: ResponseContentPart[] = blocks.map((block) => ({
      type: "input_text",
      text: block.type === "text" ? block.text : "",
      ...(block.type === "text" && block.cache_control ? { cache_mark: block.cache_control } : {}),
    }));
    return [{ type: PERPETUAL_VIEW_TYPE, role: "user", content }];
  }

  /** Items the view does not cover, with proxy-answered items back in place. */
  private rawItems(start: number): { items: ResponseInputItem[]; anchors: Set<string> } {
    const end = this.store.view.end;
    const injected = new Map<string, Injection[]>();
    for (const injection of this.store.injections)
      injected.set(injection.anchor, [...(injected.get(injection.anchor) ?? []), injection]);
    const items: ResponseInputItem[] = [];
    const anchors = new Set<string>();
    const place = (anchor: string) => {
      for (const injection of injected.get(anchor) ?? []) {
        anchors.add(anchor);
        items.push(...injection.items.map((item) => materialize(item as ResponseInputItem)));
      }
    };
    if (this.conv.length === 0) place("^");
    for (const [k, item] of this.conv.entries()) {
      if (!isLogged(item)) continue;
      const ids = this.store.idsOf(this.keys[k]);
      if (k < start && ids && ids.every((id) => id < end)) continue;
      items.push(item);
      place(this.keys[k]);
    }
    return { items, anchors };
  }

  private pruneInjections(anchors: Set<string>): void {
    const kept = this.store.injections.filter((injection) => anchors.has(injection.anchor));
    if (kept.length !== this.store.injections.length) this.store.setInjections(kept);
  }

  private async run(
    first: ResponsesRequest,
    anchor: string,
    runClaude: (request: ResponsesRequest) => Promise<ProxyOutput>,
    signal?: AbortSignal,
  ): Promise<ProxyOutput> {
    const output = await this.hops(first, anchor, runClaude);
    // An interrupted turn's answer never reaches Codex, so it is never echoed
    // and the old path never logged it either.
    if (output.toolCalls.length === 0 && output.text && !signal?.aborted)
      try {
        this.logFinal(output.text, anchor);
      } catch (error) {
        // The echo still logs it on the next request.
        console.error("perpetual: logging the final answer failed:", (error as Error).name);
      }
    return output;
  }

  private async hops(
    first: ResponsesRequest,
    anchor: string,
    runClaude: (request: ResponsesRequest) => Promise<ProxyOutput>,
  ): Promise<ProxyOutput> {
    let request = first;
    for (let hop = 1; ; hop++) {
      const output = await runClaude(request);
      const local = output.toolCalls.filter((call) => call.name === ZOOM_TOOL || call.name === DATE_TOOL);
      if (local.length === 0) return output;
      if (hop > LOCAL_HOP_STOP) {
        console.error("perpetual: memory lookups did not converge; returning the answer without them");
        return { ...output, toolCalls: output.toolCalls.filter((call) => !local.includes(call)) };
      }
      const calls: ResponseInputItem[] = local.map((call) => ({
        type: "function_call",
        name: call.name,
        arguments: call.arguments,
        call_id: call.callId,
      }));
      const results = local.map((call) => this.answer(call, hop));
      const rest = output.toolCalls.filter((call) => !local.includes(call));
      // Codex echoes (and so logs) the text only when its own calls go back to it.
      this.logLocal(rest.length ? "" : output.text, local, results);
      // Codex will echo the text and its own calls; the proxy's calls and
      // results go back in just before that echo, as the worker saw them.
      const group = rest.length
        ? [...calls, ...results]
        : [
            ...(output.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: output.text }] }] : []),
            ...calls,
            ...results,
          ];
      this.store.setInjections([...this.store.injections, { anchor, items: group }]);
      if (rest.length) return { ...output, toolCalls: rest };
      request = { ...request, input: [...(request.input as ResponseInputItem[]), ...group.map(materialize)] };
    }
  }

  private logLocal(text: string, calls: ProxyOutput["toolCalls"], results: ResponseInputItem[]): void {
    const messages: NewMessage[] = [];
    const first = calls[0]?.callId ?? crypto.randomUUID();
    if (text) messages.push({ kind: "assistant", text, key: `local:${first}:text` });
    for (const [k, call] of calls.entries()) {
      messages.push({ kind: "tool", text: `${call.name} ${call.arguments}`, key: `local:${call.callId}` });
      const output = String(results[k].output ?? "");
      messages.push({
        kind: "echo",
        text: `${call.name}: ${Buffer.byteLength(output)} bytes from this chat's memory (not repeated in the log)`,
        key: `local:${call.callId}:out`,
      });
    }
    this.store.append(messages);
    this.kick();
  }

  /** A proxy-answered call's result, as Codex would have returned it. */
  private answer(call: ProxyOutput["toolCalls"][number], hop: number): ResponseInputItem {
    const result = (output: string, images: Array<{ path: string; caption: string }> = []) => ({
      type: "function_call_output",
      call_id: call.callId,
      output,
      ...(images.length ? { perpetual_images: images } : {}),
    });
    if (hop > LOCAL_HOP_LIMIT)
      return result("Memory lookups are exhausted for this step. Answer with what you have, and say what you could not check.");
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return result("Error: arguments must be a JSON object.");
    }
    const store = this.store;
    const id = Number(args.id);
    if (!Number.isInteger(id) || id < 0 || id >= store.length)
      return result(`Error: id must be a message id from 0 to ${store.length - 1}.`);
    if (call.name === DATE_TOOL) {
      const date = new Date(store.messages[id].date);
      return result(`${id}: ${date.toISOString()} (${date.toLocaleString("en-CA", { timeZoneName: "short" })})`);
    }
    const n = Number(args.n);
    if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0)
      return result("Error: n must be a power of 2 and id a multiple of n, as in a view line id+n.");
    if (n === 1) {
      const message = store.messages[id];
      const part = message.part !== undefined ? ` (part ${message.part + 1} of a long item)` : "";
      return result(`${id}+1|${message.kind}${part}: ${message.text}`, message.images ?? []);
    }
    const level = Math.log2(n);
    const lines: string[] = [];
    for (const child of [[level - 1, 2 * (id / n)], [level - 1, 2 * (id / n) + 1]] as NodeRef[]) {
      if (nodeStart(child) >= store.length) continue;
      lines.push(viewLine(child, store.node(...child) ?? "(not summarized yet: zoom it)"));
    }
    return result(lines.join("\n"));
  }
}

/** Whether an item's log messages are exactly ones already logged. */
const sameMessages = (fresh: NewMessage[], logged: LogMessage[]): boolean =>
  fresh.length === logged.length &&
  fresh.every(
    (message, k) =>
      message.kind === logged[k].kind &&
      message.text === logged[k].text &&
      message.part === logged[k].part &&
      !message.images?.length &&
      !logged[k].images?.length,
  );

/** Turns stored image references into the content parts Claude receives. */
function materialize(item: ResponseInputItem): ResponseInputItem {
  const images = (item as { perpetual_images?: Array<{ path: string; caption: string }> }).perpetual_images;
  if (!images?.length) return item;
  const { perpetual_images: _images, ...rest } = item as ResponseInputItem & { perpetual_images?: unknown };
  const parts: ResponseContentPart[] = [{ type: "input_text", text: String(item.output ?? "") }];
  for (const image of images) {
    const mediaType = /^image\/[a-z0-9.+-]+/.exec(image.caption)?.[0];
    try {
      if (!mediaType) throw new Error("not stored");
      parts.push({ type: "input_image", image_url: `data:${mediaType};base64,${readFileSync(image.path).toString("base64")}` });
    } catch {
      parts.push({ type: "input_text", text: `[image ${image.path} is not available]` });
    }
  }
  return { ...rest, output: parts };
}

/** GET /perpetual/<thread id>: counts only, never chat content. */
export function perpetualStatus(threadId: string): Record<string, unknown> | undefined {
  const thread = threads.get(threadId);
  if (!thread) return undefined;
  const { store, compactor } = thread;
  let builtLeaves = 0;
  while (builtLeaves < store.length && store.built(0, builtLeaves)) builtLeaves++;
  return {
    messages: store.length,
    builtLeaves,
    nodes: store.builtNodes().length,
    summarizing: compactor.running,
    view: { lines: store.view.lines.length, covers: store.view.end, shrinking: store.view.shrinking },
    context: { lines: store.cview.lines.length, covers: store.cview.end },
    pendingLocalItems: store.injections.length,
  };
}
