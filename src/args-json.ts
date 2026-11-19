/**
 * Repairs tool-call arguments Claude wrote as almost-JSON (proxy-args-json-repair).
 *
 * Codex rejects a call whose arguments do not parse ("failed to parse function
 * arguments") and the model pays a whole request to retry: 3,257 such calls Nov 1-11,
 * nearly all one of two shapes. Each JSON string is judged on its own:
 *
 * 1. A backslash inside a string before a character JSON cannot escape (shell or grep
 *    text: `\$`, `\|`, `\(`). The model meant a literal backslash, so it is doubled.
 * 2. A raw U+0000-U+001F inside a string (a heredoc's newline). It becomes `\n`,
 *    `\t` or `\u00XX`, which decodes back to the same character.
 *
 * Either one shows the model wrote that string as raw text, not as JSON. So a string
 * is repaired only when it holds no valid escape at all (`\"` `\\` `\/` `\b` `\f`
 * `\n` `\r` `\t`, `\u` plus four hex digits): in raw text those were meant raw too,
 * and decoding them would run a different command (`reports\note\ files` would split
 * at a newline; PAJR-H1). A string that needs a repair and holds a valid escape has
 * two readings, so the whole call passes through unchanged for Codex to reject, as
 * before. Then every repair has exactly one reading: a lone backslash is itself, a
 * raw control character is itself. A properly encoded string elsewhere in the same
 * object does not block a repair.
 *
 * Only string contents change; whitespace between tokens is valid JSON already.
 * Anything else (an unescaped quote, truncation) has no single reading and is left
 * for Codex to reject as before. Callers parse first and repair only on failure,
 * so valid JSON is never rewritten.
 *
 * Known gap (PAJR-L1, contrived): an unescaped quote ends the string early. If the
 * pieces it splits into happen to form a valid object once repaired, that object is
 * sent instead of being rejected.
 */
export type ArgsRepairKind = "escape" | "control" | "escape+control";

const BACKSLASH = 0x5c;
const QUOTE = 0x22;
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * The repaired text and what changed, or undefined when there is nothing to repair
 * or a string needing a repair also holds a valid escape (the call stays as written).
 */
export function repairJsonStrings(text: string): { text: string; escapes: number; controls: number } | undefined {
  let out = "";
  let escapes = 0;
  let controls = 0;
  let inString = false;
  // The current string's contents, repaired, and what it holds.
  let piece = "";
  let pieceEscapes = 0;
  let pieceControls = 0;
  let pieceValid = 0;
  /** Folds the current string into out; false when it is raw text with a valid escape. */
  const closePiece = () => {
    if (pieceEscapes + pieceControls > 0 && pieceValid > 0) return false;
    out += piece;
    escapes += pieceEscapes;
    controls += pieceControls;
    piece = "";
    pieceEscapes = pieceControls = pieceValid = 0;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (!inString) {
      if (code === QUOTE) inString = true;
      out += ch;
      continue;
    }
    if (code === QUOTE) {
      if (!closePiece()) return undefined;
      inString = false;
      out += ch;
    } else if (code === BACKSLASH) {
      const next = text[i + 1];
      if (next !== undefined && SIMPLE_ESCAPES.has(next)) {
        piece += ch + next;
        pieceValid++;
        i++;
      } else if (next === "u" && HEX4.test(text.slice(i + 2, i + 6))) {
        piece += text.slice(i, i + 6);
        pieceValid++;
        i += 5;
      } else {
        // A literal backslash; what follows is read on its own next iteration.
        piece += "\\\\";
        pieceEscapes++;
      }
    } else if (code < 0x20) {
      piece += code === 0x0a ? "\\n" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      pieceControls++;
    } else {
      piece += ch;
    }
  }
  // Input that ends inside a string never parses; fold it in only to keep the scan whole.
  if (inString && !closePiece()) return undefined;
  return escapes + controls > 0 ? { text: out, escapes, controls } : undefined;
}

/**
 * The arguments to send Codex: unchanged when they parse or when no repair yields a
 * JSON object; otherwise the repaired text, logged as one line with no argument text.
 */
export function repairToolArguments(args: string, context: { tool: string; threadId?: string }): string {
  try {
    JSON.parse(args);
    return args;
  } catch {}
  const repair = repairJsonStrings(args);
  if (!repair) return args;
  let value: unknown;
  try {
    value = JSON.parse(repair.text);
  } catch {
    return args;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return args;
  const kind: ArgsRepairKind = repair.escapes && repair.controls ? "escape+control" : repair.escapes ? "escape" : "control";
  console.log(JSON.stringify({ argsRepaired: repair.escapes + repair.controls, kind, tool: context.tool, threadId: context.threadId }));
  return repair.text;
}
