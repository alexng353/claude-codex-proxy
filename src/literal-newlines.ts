/**
 * Line breaks for an answer the model double-escaped (literal-newline-text, Nov 12).
 *
 * Claude sometimes writes `\\n` inside its StructuredOutput JSON, so the answer text
 * holds a literal backslash-n wherever a line break belonged and no real newline at
 * all. Cairn and Today then show one long paragraph (Bubble's 11:18 checklist: 28
 * literal, 0 real). This turns those back into newlines, and only where that is
 * clearly what happened:
 *
 * 1. Only text with no real newline (LF or CR); anything else comes back unchanged.
 * 2. A backslash-n not itself escaped (an odd run of backslashes ends in it) becomes a
 *    newline; an even run before n is an escaped backslash and stays. A literal
 *    backslash-r-backslash-n is one newline.
 * 3. Inline code spans and fenced blocks (a backtick run up to the next run of the
 *    same length) stay exactly as written: "literal `\n`" is a real mention. A run
 *    with no closing run is plain text.
 * 4. With nothing to repair, the input itself comes back with a count of 0.
 */
export function repairLiteralNewlines(text: string): { text: string; repaired: number } {
  if (/[\r\n]/.test(text)) return { text, repaired: 0 };
  let out = "";
  let repaired = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = runEnd(text, i, "`");
      const close = closingRun(text, end, end - i);
      const stop = close < 0 ? end : close + (end - i);
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "\\") {
      const end = runEnd(text, i, "\\");
      if ((end - i) % 2 === 1) {
        // All but the last backslash are escaped pairs; the last escapes what follows.
        const kept = text.slice(i, end - 1);
        if (text.startsWith("r\\n", end)) {
          out += `${kept}\n`;
          repaired++;
          i = end + 3;
          continue;
        }
        if (text[end] === "n") {
          out += `${kept}\n`;
          repaired++;
          i = end + 1;
          continue;
        }
      }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return repaired > 0 ? { text: out, repaired } : { text, repaired: 0 };
}

/** The index just past the run of `ch` that starts at `from`. */
function runEnd(text: string, from: number, ch: string): number {
  let end = from;
  while (text[end] === ch) end++;
  return end;
}

/** Where the next backtick run of exactly `length` starts after `from`, or -1. */
function closingRun(text: string, from: number, length: number): number {
  let at = text.indexOf("`", from);
  while (at >= 0) {
    const end = runEnd(text, at, "`");
    if (end - at === length) return at;
    at = text.indexOf("`", end);
  }
  return -1;
}
