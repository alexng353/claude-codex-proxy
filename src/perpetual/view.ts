/**
 * The view: summary lines that cover a perpetual chat, oldest first.
 *
 * Design: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449
 * (UniiChat/OptMem, section 3). Every line is a tree node `[level, index]`,
 * covering the 2^level messages from `index * 2^level` on. New messages
 * append leaves; once the view passes `max` bytes one batch merges the most
 * due sibling pairs until it is at most `min` bytes (a sawtooth), so between
 * batches the view only grows at its end and stays a cache prefix.
 */

export type NodeRef = [level: number, index: number];

export const nodeStart = ([level, index]: NodeRef): number => index * 2 ** level;
export const nodeSize = ([level]: NodeRef): number => 2 ** level;
export const nodeEnd = (ref: NodeRef): number => nodeStart(ref) + nodeSize(ref);
export const nodeName = (ref: NodeRef): string => `${nodeStart(ref)}+${nodeSize(ref)}`;

/** One view line: `id+n|text`, with newlines turned into spaces. */
export const viewLine = (ref: NodeRef, text: string): string =>
  `${nodeName(ref)}|${text.replace(/\r?\n/g, " ")}`;

export type Built = (level: number, index: number) => boolean;

/**
 * Index of the most due mergeable pair, or -1. A pair is two adjacent sibling
 * lines whose parent is built. due = (T - last) / 2^l, where `last` is the
 * pair's last message: how long ago it ended, in its own line size. Ties go to
 * the oldest pair. Measuring from the pair's first message instead rewrites
 * old lines near ties (gist 3.2).
 */
export function mostDuePair(view: NodeRef[], total: number, built: Built): number {
  let best = -1;
  let bestDue = -Infinity;
  for (let k = 0; k + 1 < view.length; k++) {
    const [level, index] = view[k];
    const [nextLevel, nextIndex] = view[k + 1];
    if (level !== nextLevel || index % 2 !== 0 || nextIndex !== index + 1) continue;
    if (!built(level + 1, index / 2)) continue;
    const last = (index + 2) * 2 ** level - 1;
    const due = (total - last) / 2 ** level;
    if (due > bestDue) {
      bestDue = due;
      best = k;
    }
  }
  return best;
}

/** Replaces the pair at `k` with its parent. */
export function mergeAt(view: NodeRef[], k: number): void {
  const [level, index] = view[k];
  view.splice(k, 2, [level + 1, index / 2]);
}

/** Merges the most due pairs while `tooBig` holds; false if it ran out of pairs. */
export function shrink(
  view: NodeRef[],
  total: number,
  built: Built,
  tooBig: (view: NodeRef[]) => boolean,
): boolean {
  while (tooBig(view)) {
    const k = mostDuePair(view, total, built);
    if (k < 0) return false;
    mergeAt(view, k);
  }
  return true;
}

export type ViewState = {
  /** Lines, oldest first; they cover messages [0, end). */
  lines: NodeRef[];
  end: number;
  /** A batch could not reach `min` yet; keep merging at each new message. */
  shrinking: boolean;
};

export const emptyView = (): ViewState => ({ lines: [], end: 0, shrinking: false });

/**
 * Appends leaves for messages [state.end, end) and runs the sawtooth. Every
 * leaf must be built. Returns whether a batch merged anything.
 */
export function advanceView(
  state: ViewState,
  end: number,
  lineBytes: (ref: NodeRef) => number,
  built: Built,
  min: number,
  max: number,
): boolean {
  for (let index = state.end; index < end; index++) state.lines.push([0, index]);
  state.end = Math.max(state.end, end);
  const bytes = (lines: NodeRef[]) => lines.reduce((sum, ref) => sum + lineBytes(ref), 0);
  if (!state.shrinking && bytes(state.lines) <= max) return false;
  const before = state.lines.length;
  const reached = shrink(state.lines, state.end, built, (lines) => bytes(lines) > min);
  state.shrinking = !reached;
  return state.lines.length !== before;
}

/** Lines per cache block (gist 3.3): a cache mark sits on the last whole one. */
export const BLOCK_LINES = 4;

/**
 * Anthropic looks back about 20 blocks from a mark for an earlier entry, and
 * Claude Code already spends 3 of the 4 marks a request may carry, so the view
 * gets exactly one. Measured 2026-10-13: a second mark fails the turn with
 * HTTP 400, and an entry 31 blocks back was not found.
 */
export const MARK_STEP_BLOCKS = 16;

/**
 * Which whole block carries the view's mark this turn: the last whole block,
 * unless that is more than MARK_STEP_BLOCKS past the previous turn's mark (a
 * long turn), when the mark steps forward only that far so the previous entry
 * stays in reach. After a batch every block is new, so it goes to the end.
 */
export function nextMark(previous: number | undefined, whole: number, merged: boolean): number | undefined {
  if (whole === 0) return undefined;
  const last = whole - 1;
  if (merged || previous === undefined || previous > last) return last;
  return Math.min(last, previous + MARK_STEP_BLOCKS);
}

export type RenderedView = {
  /** `<chat>` opens the first block; the last block closes it. */
  blocks: string[];
  /** How many leading blocks are whole (BLOCK_LINES lines each). */
  whole: number;
};

export function renderView(lines: string[]): RenderedView {
  const blocks: string[] = [];
  const whole = Math.floor(lines.length / BLOCK_LINES);
  for (let k = 0; k < whole; k++)
    blocks.push(
      (k === 0 ? "<chat>\n" : "") +
        lines
          .slice(k * BLOCK_LINES, (k + 1) * BLOCK_LINES)
          .map((line) => `${line}\n`)
          .join(""),
    );
  const rest = lines.slice(whole * BLOCK_LINES).map((line) => `${line}\n`).join("");
  blocks.push((whole === 0 ? "<chat>\n" : "") + rest + "</chat>");
  return { blocks, whole };
}
