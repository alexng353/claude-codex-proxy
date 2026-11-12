// literal-newline-text (Alex 11:18 Nov 12, phone): Bubble's replies reached Cairn with a
// literal backslash-n for every line break, so a checklist read as one paragraph. The
// model had double-escaped its StructuredOutput JSON (session e81caa5b, lines 50, 61, 79
// by 0-based index): no real newline anywhere, a backslash-n wherever one belonged.
import { expect, test } from "bun:test";
import { repairLiteralNewlines } from "../src/literal-newlines";

const BS = "\\";
const N = `${BS}n`; // a literal backslash-n, two characters

// Line 79 of the session, as the model sent it (28 literal, 0 real).
const CHECKLIST = [
  "Here's a quick tap-through, with the unticked items from your list first:",
  "",
  "**Can't fix at the airport**",
  "- [ ] Passport",
  "- [ ] Indonesia e-VOA and All Indonesia arrival card. Both are still unticked, so check whether you already did them.",
  "- [ ] Printed travel letter",
  "",
  "**Backpack**",
  "- [ ] MacBook and charger, demo adapters, Government demo account ready",
  "- [ ] A7III, Sigma 20-200, 24/1.4, 85",
  "- [ ] Camera batteries, charger and SD cards; flash battery stays in the backpack",
  "- [ ] Power bank, phone charger, headphones, spare USB-C cable",
  "- [ ] Movie SSD",
  "- [ ] 3.5 mm to USB-C adapter from the back of the PC",
  "- [ ] Glasses case",
  "",
  "**Checked bag**",
  "- [ ] Suit in the suit bag, dress shoes stuffed, in shoe bags",
  "- [ ] About 7 days of light clothes, light jacket, rain shell, sneakers and sandals",
  "- [ ] Gym clothes and straps",
  "- [ ] Bali water stuff: swimwear, quick-dry towel, reef-safe sunscreen, dry bag",
  "- [ ] Plug adapters: Type A for Japan, Type C/F for Indonesia",
  "- [ ] Flash, with the battery out",
  "",
  "**Health**",
  "- [ ] Toothbrush, nasal spray, painkillers, lozenges, ORS, Imodium, sunscreen, bug spray",
  "- [ ] Creatine, optional since it's paused for the trip",
  "",
  "**Before you walk out:** do ANA check-in (`2KKZSE`) and open the Tamachi PDF once.",
];

test("the 11:18 checklist comes out with real line breaks, every item on its own line", () => {
  const sent = CHECKLIST.join(N);
  expect(sent.includes("\n")).toBe(false);
  expect(sent.split(N)).toHaveLength(29);
  const { text, repaired } = repairLiteralNewlines(sent);
  expect(text).toBe(CHECKLIST.join("\n"));
  expect(repaired).toBe(28);
  expect(text.split("\n").filter((l) => l.startsWith("- [ ] "))).toHaveLength(18);
});

// The real one-line answers that day that mention a backslash-n in inline code
// (session e81caa5b, indexes 167, 177, 221, 245): they stay exactly as written.
test("a single line whose backslash-n is only inside inline code is unchanged", () => {
  for (const sent of [
    `Finding Bubble's 11:11 reply in \`events\` by a phrase from the screenshot, then checking whether its stored body has real newlines or literal \`${N}\`.`,
    `The heredoc came through as one line. I had written \`${BS}${N}\` in the JSON, which reaches the shell as a literal backslash-n: the same failure Bubble hit.`,
    `In Bubble's Claude session, the model's own StructuredOutput \`input.text\` already held literal \`${N}\` with no real newlines: 11:11 (6), 11:16 (2) and 11:18 (28).`,
    `Three of them have exactly one \`${N}\`, and the guard has to handle those correctly.`,
    // A longer backtick run, matched by its own length.
    `Use \`\`a\` and ${N}\`\` here.`,
  ]) {
    expect(repairLiteralNewlines(sent)).toEqual({ text: sent, repaired: 0 });
  }
});

test("text that already has a real newline is returned byte-identical", () => {
  for (const sent of [`First line\nthen a literal ${N} in prose`, `crlf\r\nand ${N}`, `just a CR\rthen ${N}`]) {
    expect(repairLiteralNewlines(sent)).toEqual({ text: sent, repaired: 0 });
  }
});

test("an escaped backslash before n is unchanged; an odd run still ends in a newline", () => {
  const escaped = `printf uses ${BS}${N} for a backslash-n`;
  expect(repairLiteralNewlines(escaped)).toEqual({ text: escaped, repaired: 0 });
  // Three backslashes: an escaped backslash, then a backslash-n.
  expect(repairLiteralNewlines(`a${BS}${BS}${N}b`)).toEqual({ text: `a${BS}${BS}\nb`, repaired: 1 });
});

test("a literal backslash-r-backslash-n is one newline", () => {
  expect(repairLiteralNewlines(`one${BS}r${N}two${BS}r${N}${BS}r${N}three`)).toEqual({
    text: "one\ntwo\n\nthree",
    repaired: 3,
  });
  // A lone backslash-r is not touched.
  expect(repairLiteralNewlines(`a${BS}rb${N}c`)).toEqual({ text: `a${BS}rb\nc`, repaired: 1 });
});

test("a fenced block keeps its backslash-n; only the prose around it is repaired", () => {
  const fence = `\`\`\`sh${N}printf 'a${N}b'${N}\`\`\``;
  const { text, repaired } = repairLiteralNewlines(`Run this:${N}${N}${fence}${N}${N}Then check.`);
  expect(text).toBe(`Run this:\n\n${fence}\n\nThen check.`);
  expect(repaired).toBe(4);
});

test("an unclosed backtick run is plain text, not code", () => {
  expect(repairLiteralNewlines(`a \` b${N}c`)).toEqual({ text: "a ` b\nc", repaired: 1 });
});

test("nothing to repair: the input itself comes back, with a count of 0", () => {
  for (const sent of ["", "plain words", `only code \`${N}\``, `${BS}${N}`]) {
    expect(repairLiteralNewlines(sent)).toEqual({ text: sent, repaired: 0 });
  }
});
