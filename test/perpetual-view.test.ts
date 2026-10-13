import { expect, test } from "bun:test";
import {
  advanceView,
  emptyView,
  mostDuePair,
  nextMark,
  nodeEnd,
  nodeStart,
  renderView,
  shrink,
  viewLine,
  type NodeRef,
} from "../src/perpetual/view";

// Taelin's rollback push (rollback_state_list.js), as quoted in the gist.
type Push = { keep: number; life: number; state: number; older: Push | null };
function push(state: number, states: Push | null): Push {
  if (states === null) return { keep: 0, life: 0, state, older: null };
  const { keep, life, state: newest, older } = states;
  if (keep === 0) return { keep: 1, life, state: newest, older };
  if (life > 0)
    return { keep: 0, life: 0, state, older: { keep: 0, life: life - 1, state: newest, older } };
  return { keep: 0, life, state, older: push(newest, older) };
}

/** The push list read as view lines: each state runs to the next newer one. */
function pushLines(states: Push | null, total: number): NodeRef[] {
  const starts: number[] = [];
  for (let entry = states; entry; entry = entry.older) starts.unshift(entry.state);
  return starts.map((start, k) => {
    const size = (starts[k + 1] ?? total) - start;
    expect(Math.log2(size) % 1).toBe(0);
    return [Math.log2(size), start / size] as NodeRef;
  });
}

const allBuilt = () => true;

test("merge order matches Taelin's push at every step with its list length as budget", () => {
  let states: Push | null = null;
  const view: NodeRef[] = [];
  for (let t = 0; t <= 4096; t++) {
    states = push(t, states);
    const expected = pushLines(states, t + 1);
    view.push([0, t]);
    shrink(view, t + 1, allBuilt, (lines) => lines.length > expected.length);
    expect(view).toEqual(expected);
  }
});

test("the first ten pushes match the gist's table", () => {
  let states: Push | null = null;
  const view: NodeRef[] = [];
  const names: string[] = [];
  for (let t = 0; t < 10; t++) {
    states = push(t, states);
    view.push([0, t]);
    shrink(view, t + 1, allBuilt, (lines) => lines.length > pushLines(states, t + 1).length);
    names.push(view.map((ref) => nodeStart(ref)).reverse().join(","));
  }
  // t=0..9: newest state first, as in the gist's table.
  expect(names).toEqual(["0", "0", "2,0", "2,0", "4,0", "4,0", "6,4,0", "6,4,0", "8,4,0", "8,4,0"]);
});

test("one view mark, stepping at most 16 blocks so the last entry stays in Anthropic's lookback", () => {
  expect(nextMark(undefined, 0, false)).toBeUndefined();
  expect(nextMark(undefined, 10, false)).toBe(9);
  expect(nextMark(9, 12, false)).toBe(11);
  // A long turn added 30 blocks: step 16 now, the rest on later turns.
  expect(nextMark(9, 40, false)).toBe(25);
  expect(nextMark(25, 41, false)).toBe(40);
  // A batch rewrote the view; nothing earlier is reusable.
  expect(nextMark(25, 12, true)).toBe(11);
  expect(nextMark(40, 12, false)).toBe(11);
});

test("measures due from a pair's last message, not its first (gist T=10 example)", () => {
  const view: NodeRef[] = [[2, 0], [2, 1], [0, 8], [0, 9]];
  // (T - last) / 2^l: 0-7 ended 3 messages ago (0.75 of its size), 8-9 one ago (1).
  expect(mostDuePair(view, 10, allBuilt)).toBe(2);
});

test("a pair merges only when its parent is built; ties go to the oldest pair", () => {
  const view: NodeRef[] = [[0, 0], [0, 1], [0, 2], [0, 3]];
  expect(mostDuePair(view, 4, () => false)).toBe(-1);
  expect(mostDuePair(view, 4, (level, index) => !(level === 1 && index === 0))).toBe(2);
  // 0-1 is more due than 2-3, being older at the same size.
  expect(mostDuePair(view, 4, allBuilt)).toBe(0);
  const tied: NodeRef[] = [[1, 0], [1, 1], [0, 4], [0, 5]];
  // 0-3: (6-3)/2 = 1.5; 4-5: (6-5)/1 = 1, so 0-3 merges first.
  expect(mostDuePair(tied, 6, allBuilt)).toBe(0);
});

test("the sawtooth grows one line per message, then drops from max to min in one batch", () => {
  const state = emptyView();
  const sizes: number[] = [];
  let batches = 0;
  for (let end = 1; end <= 600; end++) {
    if (advanceView(state, end, () => 100, allBuilt, 6_400, 12_800)) batches++;
    sizes.push(state.lines.length * 100);
    // Lines always tile [0, end).
    let at = 0;
    for (const ref of state.lines) {
      expect(nodeStart(ref)).toBe(at);
      at = nodeEnd(ref);
    }
    expect(at).toBe(end);
  }
  expect(Math.max(...sizes)).toBeLessThanOrEqual(12_800);
  expect(batches).toBeGreaterThan(0);
  for (let k = 1; k < sizes.length; k++)
    if (sizes[k] < sizes[k - 1]) expect(sizes[k]).toBeLessThanOrEqual(6_400);
    else expect(sizes[k] - sizes[k - 1]).toBe(100);
});

test("a batch short of built parents keeps merging at later messages", () => {
  const state = emptyView();
  let ready = false;
  const built = (level: number) => level <= 1 || ready;
  advanceView(state, 40, () => 100, built, 2_000, 4_000);
  expect(state.lines.length).toBe(40);
  // 4,100 bytes: only level-1 parents are built, so the batch stops at 2,000+.
  advanceView(state, 41, () => 100, built, 2_000, 4_000);
  expect(state.shrinking).toBe(true);
  expect(state.lines.length).toBeGreaterThan(20);
  ready = true;
  advanceView(state, 42, () => 100, built, 2_000, 4_000);
  expect(state.shrinking).toBe(false);
  expect(state.lines.length).toBeLessThanOrEqual(20);
});

test("between batches every whole block stays byte-identical, so the cache prefix holds", () => {
  const state = emptyView();
  const text = (ref: NodeRef) => viewLine(ref, `summary of ${nodeStart(ref)}+${2 ** ref[0]}\nsecond line`);
  let previous = renderView([]);
  for (let end = 1; end <= 300; end++) {
    const merged = advanceView(state, end, (ref) => Buffer.byteLength(text(ref)) + 1, allBuilt, 3_000, 6_000);
    const rendered = renderView(state.lines.map(text));
    if (!merged) {
      // Every whole block of the previous render is unchanged.
      expect(rendered.blocks.slice(0, previous.whole)).toEqual(previous.blocks.slice(0, previous.whole));
      expect(rendered.whole).toBeGreaterThanOrEqual(previous.whole);
    }
    expect(rendered.blocks.join("")).toBe(`<chat>\n${rendered.blocks.join("").slice(7, -7)}</chat>`);
    // Newlines inside a summary become spaces: one line per node.
    expect(rendered.blocks.join("")).not.toContain("\nsecond line");
    previous = rendered;
  }
});
