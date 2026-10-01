// Codex Desktop renders an inline visualization only when the content reference
// is wrapped in Private Use Area delimiters: U+E200 visualize U+E202 {json} U+E201.
// The visualize skill spells it that way, but the delimiters are invisible and
// Claude reproduces the reference without them, which the app shows as plain text.
const OPEN = "";
const SEPARATOR = "";
const CLOSE = "";

const BARE_REFERENCE = /^( {0,3})visualize(\{.*\})[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isReference(json: string): boolean {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && typeof (value as { path?: unknown }).path === "string";
  } catch {
    return false;
  }
}

/** Restore the delimiters on bare `visualize{...}` lines outside code fences. */
export function normalizeVisualizeReferences(text: string): string {
  if (!text.includes("visualize{")) return text;
  let fence: { character: string; length: number } | undefined;
  return text.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.character && marker.length >= fence.length
        && line.trim() === marker) fence = undefined;
      return line;
    }
    if (marker) {
      fence = { character: marker[0]!, length: marker.length };
      return line;
    }
    const match = BARE_REFERENCE.exec(line.replace(/\r$/, ""));
    if (!match || !isReference(match[2]!)) return line;
    const ending = line.endsWith("\r") ? "\r" : "";
    return `${match[1]}${OPEN}visualize${SEPARATOR}${match[2]}${CLOSE}${ending}`;
  }).join("\n");
}
