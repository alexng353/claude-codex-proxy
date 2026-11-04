import { describe, expect, test } from "bun:test";
import {
  BYPASS_WORDS,
  ensurePhrase,
  isBypassAttempt,
  matchesPhrase,
  randomWords,
  retire,
  type BypassPhraseState,
} from "../src/bypass-phrase";

describe("BYPASS words", () => {
  test("a fixed list of short lowercase words, no repeats and no stopwords", () => {
    expect(new Set(BYPASS_WORDS).size).toBe(BYPASS_WORDS.length);
    expect(BYPASS_WORDS.length).toBeGreaterThanOrEqual(150);
    for (const word of BYPASS_WORDS) expect(word).toMatch(/^[a-z]{3,6}$/);
    for (const word of ["the", "a", "it", "this", "that", "and", "to", "teeth", "photo"]) expect(BYPASS_WORDS).not.toContain(word);
  });

  test("three distinct words from the list", () => {
    for (let i = 0; i < 200; i++) {
      const words = randomWords().split(" ");
      expect(words).toHaveLength(3);
      expect(new Set(words).size).toBe(3);
      for (const word of words) expect(BYPASS_WORDS).toContain(word);
    }
    // A picker that repeats still ends with three distinct words.
    let n = 0;
    expect(randomWords(() => [0, 0, 1, 1, 2][n++]).split(" ")).toEqual([BYPASS_WORDS[0], BYPASS_WORDS[1], BYPASS_WORDS[2]]);
  });
});

describe("attempts and matching", () => {
  test("what counts as a BYPASS attempt", () => {
    for (const yes of ["BYPASS", "bypass", "Bypass.", "BYPASS please", "BYPASS maple river otter", "Bypass maple river otter", "bypass  cedar"])
      expect(isBypassAttempt(yes)).toBe(true);
    for (const no of ["bypass the cache in foo.ts", "bypassing", "BYPASSES", "can I bypass", "bypass maple river otter tulip", ""])
      expect(isBypassAttempt(no)).toBe(false);
  });

  test("only the exact phrase matches, ignoring case, spacing and a trailing full stop", () => {
    const words = "maple river otter";
    for (const yes of ["BYPASS maple river otter", "bypass Maple RIVER otter", "  BYPASS   maple\triver otter. "])
      expect(matchesPhrase(yes, words)).toBe(true);
    for (const no of ["BYPASS", "BYPASS maple river", "BYPASS river maple otter", "BYPASS maple river otters", "maple river otter"])
      expect(matchesPhrase(no, words)).toBe(false);
    expect(matchesPhrase("BYPASS", undefined)).toBe(false);
  });
});

describe("one phrase per lock", () => {
  const sequence = (...phrases: string[]) => {
    let i = 0;
    return () => phrases[i++];
  };

  test("kept while the lock lasts (even as it grows), new for a disjoint lock, never reissued once retired", () => {
    const bypass: BypassPhraseState = {};
    const words = sequence("maple river otter", "maple river otter", "cedar comet tulip", "lemon kite swan");
    expect(ensurePhrase(bypass, ["d/night-teeth"], 0, words)).toEqual({ words: "maple river otter", changed: true });
    expect(ensurePhrase(bypass, ["d/night-teeth"], 1, words)).toEqual({ words: "maple river otter", changed: false });
    // The morning arms while last night's slot still locks: same lock, same words.
    expect(ensurePhrase(bypass, ["d/night-teeth", "e/morning-teeth"], 2, words)).toEqual({ words: "maple river otter", changed: true });
    expect(ensurePhrase(bypass, ["e/morning-teeth"], 3, words).words).toBe("maple river otter");
    // Nothing from that lock is due any more: a new lock. The generator's repeat of a retired phrase is skipped.
    expect(ensurePhrase(bypass, ["e/shower"], 4, words)).toEqual({ words: "cedar comet tulip", changed: true });
    expect(bypass.retired).toEqual(["maple river otter"]);
    expect(retire(bypass)).toBe(true);
    expect(retire(bypass)).toBe(false);
    expect(ensurePhrase(bypass, ["e/shower"], 5, words).words).toBe("lemon kite swan");
    expect(bypass.retired).toEqual(["maple river otter", "cedar comet tulip"]);
  });
});
