/**
 * One hygiene gate for every machine. Today on Forge and Codex Desktop on arch
 * each run a proxy; with two gate states, proofs sent to arch never reached
 * Forge, and Forge's gate locked Today all afternoon (Oct 21). Forge's gate is
 * the authority. A proxy with HYGIENE_GATE_REMOTE set (arch: an SSH tunnel to
 * Forge's 127.0.0.1:3456) keeps no gate of its own: it asks Forge about every
 * turn and passes the /hygiene routes and Cairn's hygiene API through.
 *
 * With Forge unreachable, turns still go through (a gate outage must never stop
 * Alex's chats), but photos don't: nothing checked them, and a bathroom photo
 * must never reach the working model. Their hashes are kept here, so the same
 * photo stays withheld in every later request that carries it in history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { partsOf, type GateState } from "./hygiene";
import type { GateDecision } from "./hygiene-gate";
import { decodeDataUrl, sha256 } from "./hygiene-proof";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

/** Asks /hygiene/gate for the decision only, without the skill preload. */
export const GATE_ONLY_HEADER = "x-hygiene-gate-only";
/** Marks a request one proxy sent another, so a proxy pointed at a follower fails instead of looping. */
export const HOP_HEADER = "x-hygiene-gate-hop";

/** Under the model router's 90 s wait, so this proxy, not the router, decides what happens. */
const DECISION_TIMEOUT_MS = 85_000;
/** A proof is classified by a model before the answer comes back. */
const PASS_THROUGH_TIMEOUT_MS = 180_000;

const UNCHECKED_MARKER = "[hygiene-gate: photo not checked (gate unreachable); image withheld]";

/** The authority's base URL, or null when this proxy is the gate. */
export function remoteGate(): string | null {
  const url = process.env.HYGIENE_GATE_REMOTE?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** A follower received a request from another follower: the remotes form a loop. */
export const loopResponse = () =>
  Response.json({ error: "hygiene gate loop: HYGIENE_GATE_REMOTE points at a follower" }, { status: 508 });

/**
 * The authority's decision for one Responses request, or null when it can't be
 * reached. A timeout is different: the authority is up but still deciding (a
 * proof is classified by a model), so it may yet lock; the turn waits for it.
 */
export async function remoteGateRequest(base: string, request: ResponsesRequest): Promise<GateDecision | null> {
  try {
    const reply = await fetch(`${base}/hygiene/gate`, {
      method: "POST",
      headers: { "content-type": "application/json", [GATE_ONLY_HEADER]: "1", [HOP_HEADER]: "1" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!reply.ok) throw new Error(`answered ${reply.status}`);
    const body = (await reply.json()) as { action?: string; text?: unknown; request?: unknown };
    if (body.action === "respond" && typeof body.text === "string") return { action: "respond", text: body.text };
    // No request back means the authority left it unchanged.
    if (body.action === "forward")
      return { action: "forward", request: (body.request as ResponsesRequest | undefined) ?? request };
    throw new Error("unexpected answer");
  } catch (error) {
    if ((error as Error).name === "TimeoutError")
      return { action: "respond", text: "⏳ the hygiene gate is still checking. Send that again in a minute." };
    console.error("hygiene-gate: remote gate unavailable:", (error as Error).message);
    return null;
  }
}

/**
 * The same request, sent to the authority: method, path, query, body and the
 * caller's bearer token (Cairn's API checks it there). Never proxy-hop headers:
 * the authority must see a local caller, as the tunnel makes it one.
 */
export async function passThrough(base: string, request: Request, url: URL): Promise<Response> {
  if (request.headers.has(HOP_HEADER)) return loopResponse();
  const headers: Record<string, string> = { [HOP_HEADER]: "1" };
  for (const name of ["authorization", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const reply = await fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      signal: AbortSignal.timeout(PASS_THROUGH_TIMEOUT_MS),
    });
    const out: Record<string, string> = { "content-type": reply.headers.get("content-type") ?? "application/json" };
    // Cairn's photo routes are private; a follower must not make them cacheable.
    const cache = reply.headers.get("cache-control");
    if (cache) out["cache-control"] = cache;
    return new Response(reply.body, { status: reply.status, headers: out });
  } catch (error) {
    return Response.json({ error: `hygiene gate unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}

/** The authority's whole state now, or null when it doesn't answer within `timeoutMs`. */
export async function fetchRemoteState(base: string, timeoutMs: number): Promise<GateState | null> {
  try {
    const reply = await fetch(`${base}/hygiene/state`, {
      headers: { [HOP_HEADER]: "1" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!reply.ok) throw new Error(`answered ${reply.status}`);
    return (await reply.json()) as GateState;
  } catch (error) {
    console.error("hygiene-gate: remote state unavailable:", (error as Error).message);
    return null;
  }
}

// ---- Photos no gate checked ----

const uncheckedPath = () => join(stateDir(), "hygiene-unchecked.json");

/**
 * A photo's key: the hash of its bytes, or of its URL when it is fetched rather
 * than inline (the model adapter fetches http URLs too).
 */
function imageKey(url: string): string {
  const decoded = decodeDataUrl(url);
  return decoded ? sha256(decoded.bytes) : `url:${sha256(Buffer.from(url))}`;
}

/**
 * Keys of photos no gate checked. Kept in memory too, so a photo stays withheld
 * in this process even if saving the list fails. Never trimmed: a trimmed key
 * would release its photo the next time history carries it. Null when the file
 * can't be read: then every photo is withheld (fail closed).
 */
let unchecked: { path: string; keys: Set<string> | null } | null = null;

function uncheckedKeys(): Set<string> | null {
  const path = uncheckedPath();
  if (unchecked?.path === path) return unchecked.keys;
  let keys: Set<string> | null = new Set();
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { keys?: unknown; sha256?: unknown };
      const list = value.keys ?? value.sha256;
      if (!Array.isArray(list)) throw new Error("no key list");
      keys = new Set(list.filter((s): s is string => typeof s === "string"));
    } catch (error) {
      console.error("hygiene-gate: unchecked photo list unreadable; withholding every photo:", (error as Error).message);
      keys = null;
    }
  }
  unchecked = { path, keys };
  return keys;
}

/** Remembers photos sent while the authority was unreachable. Saving may fail; the memory copy holds. */
function markUnchecked(urls: string[]): void {
  const keys = uncheckedKeys();
  if (!keys || !urls.length) return;
  for (const url of urls) keys.add(imageKey(url));
  try {
    const path = uncheckedPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify({ keys: [...keys] }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error("hygiene-gate: could not save the unchecked photo list:", (error as Error).message);
  }
}

/** `request` with each user photo `hide` picks replaced by the marker. */
function replaceImages(request: ResponsesRequest, hide: (url: string) => boolean): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  let changed = false;
  const input = (request.input as ResponseInputItem[]).map((item) => {
    if (item?.role !== "user" || !Array.isArray(item.content)) return item;
    let hit = false;
    const content = partsOf(item).map((part) => {
      if (part.type !== "input_image" || typeof part.image_url !== "string" || !hide(part.image_url)) return part;
      hit = true;
      return { type: "input_text", text: UNCHECKED_MARKER };
    });
    if (!hit) return item;
    changed = true;
    return { ...item, content } as ResponseInputItem;
  });
  return changed ? { ...request, input } : request;
}

/** Replaces each photo no gate checked with a marker (every photo when the list is unreadable). */
export function withholdUnchecked(request: ResponsesRequest): ResponsesRequest {
  const keys = uncheckedKeys();
  if (keys && !keys.size) return request;
  return replaceImages(request, (url) => !keys || keys.has(imageKey(url)));
}

/**
 * The authority can't be asked: every user photo in the request is withheld,
 * since nothing here knows which ones it accepted or withheld. The photos of
 * the turn's own messages (the trailing user messages, the ones no gate saw)
 * are remembered, so they stay withheld after the authority is back.
 */
export function withholdForOutage(request: ResponsesRequest): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const input = request.input as ResponseInputItem[];
  const fresh: string[] = [];
  for (let index = input.length - 1; index >= 0 && input[index]?.role === "user"; index--)
    for (const part of partsOf(input[index]))
      if (part.type === "input_image" && typeof part.image_url === "string") fresh.push(part.image_url);
  markUnchecked(fresh);
  return replaceImages(request, () => true);
}
