import {
  conversationRequest,
  isCompactionRequest,
  itemImageUrls,
  leadingContextCount,
  requestImageCount,
  requestToPrompt,
  serializeItem,
  systemContext,
  toolOutputText,
} from "./request";
import type {
  ResponseContentPart,
  ResponseInputItem,
  ResponsesRequest,
} from "./types";

/**
 * UTF-8 bytes per Claude token. Four bytes per token is the usual rule of
 * thumb, but full-history replays on Opus 5.5 measured 1.3-1.9x that estimate
 * (median about 1.6x): Codex histories are mostly JSON, code, paths, and ids.
 * Reporting the optimistic figure let Codex believe a 1.02M-token history was
 * 613k, so it never compacted and the replay exceeded Claude's window.
 */
export const BYTES_PER_TOKEN =
  Number(process.env.CLAUDE_BYTES_PER_TOKEN) || 2.2;

// Claude bills an image by its pixel area, capped near 4,800 tokens at the largest
// size current models accept. Assuming the cap keeps Codex compacting early
// rather than letting a screenshot-heavy task outgrow the real window.
export const IMAGE_TOKEN_ESTIMATE = 4_800;

export function estimateVisibleTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / BYTES_PER_TOKEN);
}

export function estimateRequestTokens(request: ResponsesRequest): number {
  return (
    estimateVisibleTokens(requestToPrompt(request)) +
    requestImageCount(request) * IMAGE_TOKEN_ESTIMATE
  );
}

/** Claude's input window for a model, in tokens. */
export function contextLimit(model: string): number {
  const configured = Number(process.env.CLAUDE_CONTEXT_TOKENS);
  if (configured > 0) return configured;
  return /haiku/i.test(model) ? 200_000 : 1_000_000;
}

// Claude Code adds its own system prompt, native tool schemas, and the answer
// on top of what the proxy sends, and the estimate is only an estimate.
const REPLAY_SHARE = 0.85;

/** Estimated tokens a replay may use before older tool outputs are elided. */
export const replayBudget = (model: string): number =>
  Math.floor(contextLimit(model) * REPLAY_SHARE);

/** Estimated tokens for a fresh worker: system context plus the conversation. */
export function replayTokens(request: ResponsesRequest): number {
  return (
    estimateVisibleTokens(systemContext(request)) +
    estimateRequestTokens(conversationRequest(request))
  );
}

const ELIDABLE = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "computer_call_output",
]);
/** Items at the end of the history that only the last stage may trim. */
const RECENT_ITEMS = 24;
/** Items at the very end that are never elided. */
const PROTECTED_ITEMS = 4;
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 1_000;
const MARKER = "claude-codex-proxy elided";
const IMAGE_MARKER = `[${MARKER} an image from this older tool output to fit Claude's context window.]`;

const isImage = (part: unknown): boolean =>
  !!part &&
  typeof part === "object" &&
  (part as ResponseContentPart).type === "input_image";

function plainOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return toolOutputText(
      output.map((part) =>
        isImage(part) ? { type: "input_text", text: IMAGE_MARKER } : part,
      ),
    );
  return JSON.stringify(output) ?? "";
}

/** Keeps cuts off the middle of a surrogate pair. */
function cut(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** A smaller copy of a tool output item, or undefined when nothing would shrink. */
function elide(
  item: ResponseInputItem,
  mode: "trim" | "drop",
): ResponseInputItem | undefined {
  if (item.type === "computer_call_output") {
    const output = `[${MARKER} this older computer result and its screenshot to fit Claude's context window.]`;
    return item.output === output ? undefined : { ...item, output };
  }
  const text = plainOutput(item.output);
  const hadImages = itemImageUrls(item).length > 0;
  if (mode === "drop") {
    if (text.startsWith(`[${MARKER} this older tool output`)) return undefined;
    return {
      ...item,
      output: `[${MARKER} this older tool output (${text.length} characters) to fit Claude's context window. Run the tool again if you need it.]`,
    };
  }
  const marked = (count: number) =>
    `\n[${MARKER} ${count} characters from the middle of this older tool output to fit Claude's context window. Run the tool again if you need it.]\n`;
  if (text.length <= HEAD_CHARS + TAIL_CHARS + marked(text.length).length) {
    return hadImages ? { ...item, output: text } : undefined;
  }
  const head = cut(text, HEAD_CHARS);
  const tail = cut(text, text.length - TAIL_CHARS);
  return {
    ...item,
    output: text.slice(0, head) + marked(tail - head) + text.slice(tail),
  };
}

const itemTokens = (item: ResponseInputItem): number =>
  Buffer.byteLength(serializeItem(item), "utf8") / BYTES_PER_TOKEN +
  itemImageUrls(item).length * IMAGE_TOKEN_ESTIMATE;

export type FittedReplay = {
  request: ResponsesRequest;
  /** Estimated tokens of the fitted replay. */
  tokens: number;
  /** How many tool outputs were shortened or replaced. */
  elided: number;
  /** How many of the oldest items a compaction left out to fit. */
  omitted: number;
  fits: boolean;
};

const SUMMARY_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);

const isUserTurnStart = (item: ResponseInputItem): boolean =>
  (item.type === undefined || item.type === "message") && item.role === "user";

/**
 * Last resort for a compaction whose messages alone overflow the window: leave
 * out the oldest whole turns, keeping earlier compaction summaries, so the
 * summary covers the most recent history instead of the request failing.
 * Ordinary turns never take this path; they must not silently lose history.
 */
function omitOldestTurns(
  items: ResponseInputItem[],
  start: number,
  tokens: number,
  budget: number,
): { items: ResponseInputItem[]; tokens: number; omitted: number } {
  // The trigger and the turn just before it are what the summary must end on.
  let lastTurn = items.length - 1;
  while (lastTurn > start && !isUserTurnStart(items[lastTurn])) lastTurn--;
  let cut = start;
  let dropped = 0;
  for (let index = start; index < lastTurn && tokens - dropped > budget; index++) {
    if (!SUMMARY_TYPES.has(items[index].type ?? "")) dropped += itemTokens(items[index]);
    cut = index + 1;
  }
  // Finish at a turn boundary so no call is separated from its output.
  while (cut < lastTurn && !isUserTurnStart(items[cut])) {
    if (!SUMMARY_TYPES.has(items[cut].type ?? "")) dropped += itemTokens(items[cut]);
    cut++;
  }
  const removed = items.slice(start, cut).filter((item) => !SUMMARY_TYPES.has(item.type ?? ""));
  if (!removed.length) return { items, tokens, omitted: 0 };
  const kept = items.slice(start, cut).filter((item) => SUMMARY_TYPES.has(item.type ?? ""));
  const marker: ResponseInputItem = {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[${MARKER} the ${removed.length} oldest items of this conversation to fit Claude's context window for this compaction. Summarize what follows; say in the summary that earlier history was not visible.]`,
      },
    ],
  };
  const next = [...items.slice(0, start), ...kept, marker, ...items.slice(cut)];
  return { items: next, tokens: tokens - dropped + itemTokens(marker), omitted: removed.length };
}

/**
 * Shrinks a history whose full replay would not fit `budget` estimated tokens.
 * Messages are never touched, nor are tool_search outputs, which keep loaded
 * tools callable. Tool outputs are shortened oldest first, in stages: trim older
 * outputs to their head and tail, then replace them with a marker, then trim
 * recent outputs except the last few items. Each stage stops once the history
 * fits, so only as much is elided as needed.
 */
export function fitReplay(
  request: ResponsesRequest,
  budget: number,
): FittedReplay {
  let tokens = replayTokens(request);
  if (tokens <= budget || typeof request.input === "string")
    return { request, tokens, elided: 0, omitted: 0, fits: tokens <= budget };
  let items = [...request.input];
  const start = leadingContextCount(items);
  const recent = Math.max(start, items.length - RECENT_ITEMS);
  const protectedFrom = Math.max(start, items.length - PROTECTED_ITEMS);
  const stages = [
    { from: start, to: recent, mode: "trim" },
    { from: start, to: recent, mode: "drop" },
    { from: recent, to: protectedFrom, mode: "trim" },
  ] as const;
  const elided = new Set<number>();
  for (const stage of stages) {
    for (let index = stage.from; index < stage.to; index++) {
      if (tokens <= budget) break;
      const item = items[index];
      if (!item.type || !ELIDABLE.has(item.type)) continue;
      const next = elide(item, stage.mode);
      if (!next) continue;
      tokens += itemTokens(next) - itemTokens(item);
      items[index] = next;
      elided.add(index);
    }
  }
  let omitted = 0;
  if (tokens > budget && isCompactionRequest(request)) {
    const trimmed = omitOldestTurns(items, start, tokens, budget);
    items = trimmed.items;
    tokens = trimmed.tokens;
    omitted = trimmed.omitted;
  }
  return {
    request: elided.size || omitted ? { ...request, input: items } : request,
    tokens: Math.ceil(tokens),
    elided: elided.size,
    omitted,
    fits: tokens <= budget,
  };
}

/**
 * Claude's "Prompt is too long" error and the sizes it names, if any. Claude
 * Code words it "the request is ~N tokens (limit L)"; the API says "N tokens > L".
 */
export function promptTooLong(
  message: string,
): { requested?: number; limit?: number } | undefined {
  if (!/prompt is too long/i.test(message)) return undefined;
  const sizes = /([\d,]+)\s*tokens\s*(?:\(limit\s*|>\s*)([\d,]+)/i.exec(message);
  if (!sizes) return {};
  const number = (value: string) => Number(value.replaceAll(",", ""));
  return { requested: number(sizes[1]), limit: number(sizes[2]) };
}

/**
 * A tighter budget after Claude rejected a prompt the estimate said would fit:
 * scale by how far the estimate was off, and never above the normal budget.
 */
export function retryBudget(
  sentTokens: number,
  error: { requested?: number; limit?: number },
  model: string,
): number {
  const budget = replayBudget(model);
  const scaled =
    error.requested && error.limit
      ? (sentTokens * error.limit * REPLAY_SHARE) / error.requested
      : sentTokens * 0.6;
  return Math.floor(Math.min(budget, scaled));
}
