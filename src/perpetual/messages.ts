import { stableJson, textFromContent, toolOutputText } from "../request";
import type { ResponseContentPart, ResponseInputItem } from "../types";
import type { LoggedImage, MessageKind, NewMessage } from "./store";

/** Head plus tail kept of a tool output, and the split size of other long text (gist 1). */
export const MESSAGE_CHARS = 30_000;

/** Items that are never logged: thoughts, and Codex compaction bookkeeping. */
const UNLOGGED_TYPES = new Set([
  "reasoning",
  "compaction",
  "compaction_summary",
  "context_compaction",
  "compaction_trigger",
]);

export const isLogged = (item: ResponseInputItem): boolean => !UNLOGGED_TYPES.has(item.type ?? "");

const OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "computer_call_output",
  "tool_search_output",
]);
const CALL_TYPES = new Set(["function_call", "custom_tool_call", "computer_call", "tool_search_call"]);

export const isModelOutput = (item: ResponseInputItem): boolean =>
  CALL_TYPES.has(item.type ?? "") || (item.role === "assistant" && isMessage(item));
export const isToolOutput = (item: ResponseInputItem): boolean => OUTPUT_TYPES.has(item.type ?? "");
export const isMessage = (item: ResponseInputItem): boolean =>
  item.type === undefined || item.type === "message";

/**
 * Stable identities for Codex items: a hash of the content (without server ids
 * or statuses) plus how many identical items came before. Codex replays the
 * same items every request, so a key tells whether an item is logged already.
 */
export function itemKeys(items: ResponseInputItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const { id: _id, status: _status, ...content } = item as Record<string, unknown>;
    const hash = new Bun.CryptoHasher("sha256").update(stableJson(content)).digest("hex").slice(0, 32);
    const count = seen.get(hash) ?? 0;
    seen.set(hash, count + 1);
    return `${hash}#${count}`;
  });
}

/** A tool's output, clipped to its head and tail. */
export function clipOutput(text: string, limit = MESSAGE_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters clipped ...]\n${text.slice(-half)}`;
}

/** Other long text is never cut: it becomes several messages in a row. */
export function splitText(text: string, limit = MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += limit) parts.push(text.slice(at, at + limit));
  return parts;
}

export type ImageSaver = (mediaType: string, data: Buffer) => LoggedImage;

function imageUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const { type, image_url } = part as ResponseContentPart;
    return (type === "input_image" || type === "computer_screenshot") && typeof image_url === "string"
      ? [image_url]
      : [];
  });
}

function saveImages(urls: string[], save: ImageSaver): LoggedImage[] {
  return urls.map((url) => {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
    if (!match) return { path: url, caption: "remote image, not stored" };
    return save(match[1], Buffer.from(match[2], "base64"));
  });
}

const imageNote = (images: LoggedImage[]) =>
  images.map((image, index) => `[image ${index + 1}: ${image.path} (${image.caption})]`).join("\n");

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return toolOutputText(output);
  return JSON.stringify(output) ?? "";
}

function messageKind(item: ResponseInputItem, text: string): MessageKind {
  if (item.role === "assistant") return "assistant";
  if (item.role === "developer" || item.role === "system") return "note";
  if (text.trimStart().startsWith("<subagent_notification>")) return "work";
  return "user";
}

/** The log messages for one Codex item (several when its text is long). */
export function itemMessages(item: ResponseInputItem, key: string, save: ImageSaver): NewMessage[] {
  const type = item.type ?? "message";
  let kind: MessageKind;
  let text: string;
  let urls: string[] = [];
  let clip = false;
  if (type === "function_call" || type === "custom_tool_call") {
    kind = "tool";
    const name = item.namespace ? `${item.namespace}.${item.name}` : item.name;
    text = `${name} ${item.arguments ?? item.input ?? ""}`;
  } else if (type === "tool_search_call") {
    kind = "tool";
    text = `tool_search ${JSON.stringify(item.arguments ?? {})}`;
  } else if (type === "computer_call") {
    kind = "tool";
    text = `computer ${JSON.stringify(item.actions ?? item.action ?? {})}`;
  } else if (type === "tool_search_output") {
    kind = "echo";
    const names = (Array.isArray(item.tools) ? item.tools : []).map((tool) =>
      tool && typeof tool === "object" ? String((tool as { name?: unknown }).name ?? "?") : "?",
    );
    text = `tool_search loaded: ${names.join(", ") || "(nothing)"}`;
  } else if (type === "computer_call_output") {
    kind = "echo";
    urls = imageUrls(item.output);
    text = urls.length ? "computer: screenshot" : clipOutput(outputText(item.output));
  } else if (OUTPUT_TYPES.has(type)) {
    kind = "echo";
    urls = imageUrls(item.output);
    text = outputText(item.output);
    clip = true;
  } else if (type === "message") {
    text = textFromContent(item.content);
    urls = imageUrls(item.content);
    kind = messageKind(item, text);
  } else {
    kind = "note";
    text = `${type} ${JSON.stringify(item)}`;
    clip = true;
  }
  const images = saveImages(urls, save);
  if (images.length) text = [text, imageNote(images)].filter(Boolean).join("\n");
  const parts = clip ? [clipOutput(text)] : splitText(text);
  return parts.map((part, index) => ({
    kind,
    text: part,
    key,
    ...(parts.length > 1 ? { part: index } : {}),
    ...(index === 0 && images.length ? { images } : {}),
  }));
}
