/**
 * The BYPASS challenge (Alex, 2026-11-04 01:07): "instead of BYPASS its a random
 * string of 3 words BYPASS A B C". A bare BYPASS had become a reflex; three
 * fresh words make every bypass a deliberate act.
 *
 * A lock gets a phrase the first time its lock text is shown. The phrase lasts
 * while that lock lasts: the gate keeps it while any slot it was issued for is
 * still due (a lock that grows keeps its phrase), and retires it once the gate
 * is seen clear or a bypass opens it. A later lock always gets new words, and
 * retired phrases are never issued again.
 */
import { randomInt } from "node:crypto";

/**
 * Short, common, concrete words that are easy to type on a phone: no
 * homophones (sea/see), no gate vocabulary (teeth, photo), no stopwords, so
 * "bypass the cache" is never mistaken for an attempt.
 */
export const BYPASS_WORDS: readonly string[] = [
  "acorn", "anchor", "apple", "arrow", "badge", "bamboo", "banjo", "barrel", "basket", "beach",
  "berry", "birch", "bison", "blade", "bloom", "board", "brick", "bridge", "brook", "button",
  "cabin", "cable", "cactus", "camel", "candle", "canoe", "cargo", "carrot", "castle", "cedar",
  "chalk", "cherry", "cliff", "cloud", "clover", "coast", "comet", "cookie", "copper", "coral",
  "cotton", "crane", "creek", "crown", "daisy", "delta", "donkey", "drum", "eagle", "earth",
  "ember", "fable", "falcon", "fern", "field", "flame", "flute", "forest", "fox", "frost",
  "garden", "gecko", "ginger", "glove", "goat", "grape", "gravel", "harbor", "hazel", "honey",
  "igloo", "island", "ivory", "jacket", "jelly", "jungle", "kayak", "kettle", "kite", "koala",
  "ladder", "lake", "lamp", "lemon", "lily", "lime", "lion", "mango", "maple", "marble",
  "meadow", "melon", "mirror", "moon", "moose", "moss", "mug", "nest", "nickel", "noodle",
  "ocean", "olive", "onion", "orbit", "otter", "owl", "oyster", "paddle", "palm", "panda",
  "paper", "parrot", "peach", "pebble", "pencil", "pepper", "piano", "pickle", "pillow", "pine",
  "planet", "plum", "pocket", "pond", "puzzle", "quartz", "quilt", "rabbit", "radio", "raven",
  "ribbon", "river", "robin", "rocket", "ruby", "saddle", "salmon", "sand", "scarf", "shell",
  "silk", "silver", "sled", "snow", "sponge", "spoon", "sprout", "spruce", "star", "stone",
  "storm", "straw", "sugar", "summit", "swan", "table", "tablet", "teapot", "tiger", "timber",
  "toast", "tomato", "torch", "tulip", "tunnel", "turtle", "valley", "velvet", "violet", "waffle",
  "wagon", "walnut", "whale", "wheat", "willow", "window", "winter", "wolf", "yarn", "zebra",
];
const WORD_SET = new Set(BYPASS_WORDS);

/** The challenge for one lock. */
export type BypassPhrase = {
  /** Three words, lowercase, space-separated. */
  words: string;
  issuedAt: string;
  /** Every slot that was due while this phrase was shown. */
  slots: string[];
};

/** The part of the gate state this module reads and writes (GateState.bypass). */
export type BypassPhraseState = { phrase?: BypassPhrase; retired?: string[] };

/** Retired phrases kept so none is issued twice (one lock a day keeps ~4 months). */
const RETIRED_KEEP = 128;

/** Three distinct random words from BYPASS_WORDS. Tests may pass their own picker. */
export function randomWords(pick: (n: number) => number = randomInt): string {
  const chosen: string[] = [];
  while (chosen.length < 3) {
    const word = BYPASS_WORDS[pick(BYPASS_WORDS.length)];
    if (!chosen.includes(word)) chosen.push(word);
  }
  return chosen.join(" ");
}

/**
 * The phrase for the lock in force now: the current one while it still covers
 * a due slot (its slot list grows with the lock), else a fresh one. Reports
 * whether the state changed, so the caller saves it.
 */
export function ensurePhrase(
  bypass: BypassPhraseState,
  dueSlots: string[],
  now: number,
  words: () => string = randomWords,
): { words: string; changed: boolean } {
  const current = bypass.phrase;
  if (current && dueSlots.some((slot) => current.slots.includes(slot))) {
    const added = dueSlots.filter((slot) => !current.slots.includes(slot));
    if (added.length) current.slots.push(...added);
    return { words: current.words, changed: added.length > 0 };
  }
  if (current) retire(bypass);
  const used = new Set(bypass.retired ?? []);
  let next = words();
  for (let tries = 0; used.has(next) && tries < 50; tries++) next = words();
  bypass.phrase = { words: next, issuedAt: new Date(now).toISOString(), slots: [...dueSlots] };
  return { words: next, changed: true };
}

/** Ends the current phrase: the gate is clear, or a bypass opened it. */
export function retire(bypass: BypassPhraseState): boolean {
  if (!bypass.phrase) return false;
  bypass.retired = [...(bypass.retired ?? []), bypass.phrase.words].slice(-RETIRED_KEEP);
  delete bypass.phrase;
  return true;
}

/** Lowercase, single spaces, no trailing punctuation a phone keyboard may add. */
export function normalizeAttempt(text: string): string {
  return text.trim().replace(/[.!?,]+$/, "").replace(/\s+/g, " ").toLowerCase();
}

/**
 * A bare "BYPASS", or "BYPASS" plus exactly three words from the list (any
 * case): plainly an attempt, so the gate answers it in every state, as it did
 * a bare BYPASS before ("already clear", "already open", or the lock text).
 */
export function isBareBypass(text: string): boolean {
  const [first, ...words] = normalizeAttempt(text).split(" ");
  return first === "bypass" && (words.length === 0 || (words.length === 3 && words.every((word) => WORD_SET.has(word))));
}

/**
 * Whether a turn is a BYPASS attempt (right, wrong, stale or bare), so a
 * locked gate answers it instead of holding it as a message. Only counts while
 * the gate is armed (the caller checks), so a clear gate never swallows text:
 * - a bare "bypass", any case;
 * - anything starting with the word BYPASS in capitals;
 * - "bypass" plus up to three words that are all in the list (a phone
 *   capitalises the first letter);
 * - "bypass" plus exactly three words, two of them in the list (a typo).
 * "bypass the cache in foo.ts" is an ordinary message.
 */
export function isBypassAttempt(text: string): boolean {
  if (isBareBypass(text) || /^BYPASS(\s|[.!?,]*$)/.test(text.trim())) return true;
  const [first, ...words] = normalizeAttempt(text).split(" ");
  if (first !== "bypass" || words.length > 3) return false;
  const known = words.filter((word) => WORD_SET.has(word)).length;
  return known === words.length || (words.length === 3 && known >= 2 && words.every((word) => /^[a-z]{2,10}$/.test(word)));
}

/** Whether `text` is exactly this phrase's BYPASS line (case and spacing aside). */
export function matchesPhrase(text: string, words: string | undefined): boolean {
  return !!words && normalizeAttempt(text) === `bypass ${words}`;
}
