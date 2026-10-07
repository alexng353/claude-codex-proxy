/**
 * Plate dashboard activity as an ambient block on Alex's newest message.
 *
 * Model-agnostic and dependency-free so the Claude proxy and the Codex model
 * router can share it. Durable state (which block belongs to which message,
 * and the event cursor) lives with the caller; this module only finds the
 * message, keys it, renders events, and splices the block in.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BLOCK_TAG = "plate-activity";
const OPEN = `<${BLOCK_TAG}`;

/**
 * User-role messages Codex synthesizes rather than Alex typing them. Messages
 * that start with ambient context (<in-app-browser-context>, attached files)
 * still carry his words, so they are not listed here.
 */
const SYNTHETIC_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<permissions instructions>",
  "<external_codex_apps_open_page>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<user_shell_command>",
  "<developer>",
];

const partsOf = (item) =>
  typeof item.content === "string"
    ? [{ type: "input_text", text: item.content }]
    : Array.isArray(item.content)
      ? item.content
      : [];

const isBlockPart = (part) =>
  typeof part?.text === "string" && part.text.startsWith(OPEN);

const isUserMessage = (item) =>
  item?.role === "user" && (item.type === undefined || item.type === "message");

function isSynthetic(item) {
  const texts = partsOf(item)
    .filter((part) => !isBlockPart(part))
    .map((part) => (typeof part.text === "string" ? part.text.trimStart() : null));
  return (
    texts.length > 0 &&
    texts.every(
      (text) =>
        text !== null && SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix)),
    )
  );
}

const baseHash = (item) =>
  createHash("sha256")
    .update(JSON.stringify(partsOf(item).filter((part) => !isBlockPart(part))))
    .digest("hex");

/**
 * Every message Alex wrote, oldest first, keyed so a replay of the same
 * history yields the same keys: content (minus any block we added) plus how
 * many earlier user messages had identical content, so two "ok"s stay distinct.
 */
export function messageKeys(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Map();
  const keys = [];
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!isUserMessage(item)) continue;
    const hash = baseHash(item);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    if (isSynthetic(item)) continue;
    keys.push({ index, key: `${hash}:${occurrence}`, hasBlock: partsOf(item).some(isBlockPart) });
  }
  return keys;
}

/** The newest message Alex wrote; see messageKeys. */
export const targetMessage = (input) => messageKeys(input).at(-1) ?? null;

/** A copy of the request with the block appended to input[index]; idempotent. */
export function injectBlock(request, index, block) {
  const item = request.input[index];
  const parts = partsOf(item);
  if (parts.some(isBlockPart)) return request;
  const input = request.input.slice();
  input[index] = { ...item, content: [...parts, { type: "input_text", text: block }] };
  return { ...request, input };
}

// ---- Rendering ----

const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
// Event text is Alex's and agents' free text; never let it close our tag.
const safe = (text) => String(text).replace(/<\/?plate-activity/gi, "‹plate-activity");

/** Agent events Alex would want to hear about: a chat finishing an item. */
const AGENT_FINISH = new Set(["done", "resolved"]);
/** Alex's own events that carry no news for the model. */
const ALEX_SKIP = new Set(["chat-message"]);

export function relevantEvent(event) {
  if (event.actor === "alex") return !ALEX_SKIP.has(event.action);
  return AGENT_FINISH.has(event.action);
}

function localStamp(iso, timeZone, withDate) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (!withDate) return time;
  const day = date.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" });
  return `${day} ${time}`;
}

function untilLabel(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clip(value, 40);
  return date.toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** One event as "<label> (key) …" under its action heading. */
function describe(event, timeZone) {
  const key = event.key ? ` (${event.key})` : "";
  const detail = event.detail ?? "";
  switch (event.action) {
    case "done":
    case "undone":
    case "waiting":
    case "unwaited":
    case "snoozed":
    case "unsnoozed":
    case "noted": {
      // plate writes "title | until <iso> | note"; any piece may be missing.
      const segments = detail ? detail.split(" | ") : [];
      const until = segments.find((s) => s.startsWith("until "));
      const rest = segments.filter((s) => s !== until);
      const title = rest.shift();
      const note = rest.join(" | ");
      let text = `${clip(title ?? event.key ?? "item", 80)}${title ? key : ""}`;
      if (until) text += ` until ${untilLabel(until.slice(6), timeZone)}`;
      if (note) text += `: "${clip(note, 200)}"`;
      return text;
    }
    case "handed-off":
      return clip(detail || event.key || "item", 160);
    case "added-todo":
      return `${clip(detail || "todo", 80)}${key}`;
    default:
      return clip([event.key, detail].filter(Boolean).join(": ") || event.action, 160);
  }
}

const LABELS = { noted: "note", "handed-off": "handed off", "answered-ask": "answered ask", "added-todo": "added todo" };
const MAX_CHARS = 2500;
const MAX_AGENT_KEYS = 6;

/**
 * Renders events (oldest first) as one compact block, or null when none are
 * worth mentioning. `cursor` is the newest event id covered, offered so the
 * model can page further with plate_events if the block was truncated.
 */
export function renderBlock(events, { timeZone, truncated = false } = {}) {
  const relevant = events.filter(relevantEvent);
  if (!relevant.length) return null;
  const groups = new Map();
  const agentKeys = [];
  for (const event of relevant) {
    if (event.actor !== "alex") {
      if (event.key && !agentKeys.includes(event.key)) agentKeys.push(event.key);
      continue;
    }
    const label = LABELS[event.action] ?? event.action;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(describe(event, timeZone));
  }
  const lines = [...groups].map(([label, items]) => `- ${label}: ${items.join("; ")}`);
  if (agentKeys.length) {
    const shown = agentKeys.slice(0, MAX_AGENT_KEYS).join(", ");
    const more = agentKeys.length > MAX_AGENT_KEYS ? ` (+${agentKeys.length - MAX_AGENT_KEYS} more)` : "";
    lines.push(`- agents finished: ${shown}${more}`);
  }
  const first = relevant[0].at;
  const last = relevant.at(-1).at;
  const sameDay =
    localStamp(first, timeZone, true).split(" ").slice(0, 2).join(" ") ===
    localStamp(last, timeZone, true).split(" ").slice(0, 2).join(" ");
  const since = localStamp(first, timeZone, !sameDay);
  const newest = events.at(-1).id;
  const header = `<${BLOCK_TAG} source="plate-dashboard" since="${since}">`;
  const preface =
    "Supplied automatically: what changed on Alex's plate dashboard since his last message. It is not part of what he typed.";
  let body = lines.map(safe);
  const footer = truncated
    ? [`- (older activity omitted; plate_events since_id can page back from ${newest})`]
    : [];
  const size = () => [header, preface, ...body, ...footer].join("\n").length;
  let dropped = 0;
  while (body.length > 1 && size() > MAX_CHARS) {
    body = body.slice(0, -1);
    dropped++;
  }
  if (dropped) footer.push(`- (+${dropped} more lines; call plate_events for the rest)`);
  return [header, preface, ...body, ...footer, `</${BLOCK_TAG}>`].join("\n");
}

// ---- Configuration ----

export function configPath(env = process.env) {
  return (
    env.PLATE_ACTIVITY_CONFIG ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-codex-proxy", "plate-activity.json")
  );
}

let cached = { path: "", mtimeMs: -1, config: null };

/**
 * `{ threads: string[], plateUrl?, timeZone? }`, re-read when the file
 * changes so scope edits apply without a restart. Missing or invalid: off.
 */
export function loadConfig(path = configPath()) {
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cached.path === path && cached.mtimeMs === mtimeMs) return cached.config;
  let config = null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw?.threads))
      config = {
        threads: new Set(raw.threads.filter((t) => typeof t === "string")),
        plateUrl: typeof raw.plateUrl === "string" ? raw.plateUrl : "http://127.0.0.1:4717",
        timeZone: typeof raw.timeZone === "string" ? raw.timeZone : undefined,
      };
  } catch {
    config = null;
  }
  cached = { path, mtimeMs, config };
  return config;
}
