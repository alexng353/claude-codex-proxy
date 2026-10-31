/**
 * One hygiene gate for every machine. Today on Forge and Codex Desktop on arch
 * each run a proxy; with two gate states, proofs sent to arch never reached
 * Forge, and Forge's gate locked Today all afternoon (Oct 21). Forge's gate is
 * the authority. A proxy with HYGIENE_GATE_REMOTE set (arch: an SSH tunnel to
 * Forge's 127.0.0.1:3456) keeps no gate of its own: it asks Forge about every
 * turn and passes the /hygiene routes and Cairn's hygiene API through.
 *
 * With Forge unreachable, photos still reach the working model. Keep their
 * bytes for a later authority check and remember that they were delivered, so
 * recovery never removes them from the model's conversation history.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { imageMarker, isWithheld, partsOf, type GateState } from "./hygiene";
import type { GateDecision } from "./hygiene-gate";
import { decodeDataUrl, sha256 } from "./hygiene-proof";
import { tryLock, unlock, withLock } from "./filelock";
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

export const UNCHECKED_MARKER = "[hygiene-gate: photo not checked yet (gate unreachable)]";

/** The authority's base URL, or null when this proxy is the gate. */
export function remoteGate(): string | null {
  const url = process.env.HYGIENE_GATE_REMOTE?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** A follower received a request from another follower: the remotes form a loop. */
export const loopResponse = () =>
  Response.json({ error: "hygiene gate loop: HYGIENE_GATE_REMOTE points at a follower" }, { status: 508 });

/** Internal gate traffic uses the same configured bearer credential as local routes. */
function authorityHeaders(): Record<string, string> {
  const key = process.env.PROXY_API_KEY;
  return { [HOP_HEADER]: "1", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/**
 * The authority's decision for one Responses request, or null when it can't be
 * reached, including a timeout: an unknown decision must not block delivery.
 */
export async function remoteGateRequest(base: string, request: ResponsesRequest): Promise<GateDecision | null> {
  try {
    const reply = await fetch(`${base}/hygiene/gate`, {
      method: "POST",
      headers: { "content-type": "application/json", [GATE_ONLY_HEADER]: "1", ...authorityHeaders() },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!reply.ok) throw new Error(`answered ${reply.status}`);
    const body = (await reply.json()) as { action?: string; text?: unknown; request?: unknown; gateUnavailable?: unknown };
    if (body.action === "respond" && typeof body.text === "string") return { action: "respond", text: body.text };
    // No request back means the authority left it unchanged.
    if (body.action === "forward")
      return { action: "forward", request: (body.request as ResponsesRequest | undefined) ?? request, ...(body.gateUnavailable === true ? { gateUnavailable: true } : {}) };
    throw new Error("unexpected answer");
  } catch (error) {
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
  const headers: Record<string, string> = url.pathname.startsWith("/hygiene/api/") ? { [HOP_HEADER]: "1" } : authorityHeaders();
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
      headers: authorityHeaders(),
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

type PendingPhoto = { url: string; at: number; attempts?: number; nextAttemptAt?: number };
type PhotoStore = { keys: Set<string>; checked: Set<string>; dropped: Set<string>; pending: Record<string, PendingPhoto>; withheld: Record<string, string> };
const memory = new Map<string, PhotoStore>();
const unsaved = new Set<string>();
const fingerprints = new Map<string, string>();
const corrupt = new Set<string>();
const MAX_PENDING_ENTRIES = 64;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

const fingerprint = (path: string) => {
  const stat = statSync(path);
  return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
};
const privateDirectory = (path: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
};
const emptyStore = (): PhotoStore => ({ keys: new Set(), checked: new Set(), dropped: new Set(), pending: {}, withheld: {} });

function readStore(path: string): PhotoStore {
  let stamp: string | undefined;
  try {
    if (!existsSync(path)) return memory.get(path) ?? emptyStore();
    stamp = fingerprint(path);
    if (fingerprints.get(path) === stamp && memory.has(path)) return memory.get(path)!;
    const value = JSON.parse(readFileSync(path, "utf8"));
    const keys = value.keys ?? value.sha256;
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) throw new Error("invalid key list");
    const checked = value.checked ?? [];
    if (!Array.isArray(checked) || !checked.every((key) => typeof key === "string")) throw new Error("invalid checked list");
    const dropped = value.dropped ?? [];
    if (!Array.isArray(dropped) || !dropped.every((key) => typeof key === "string")) throw new Error("invalid dropped list");
    const store: PhotoStore = { keys: new Set(keys), checked: new Set(checked), dropped: new Set(dropped), pending: value.pending ?? {}, withheld: value.withheld ?? {} };
    if (
        !store.pending || typeof store.pending !== "object" || Array.isArray(store.pending) ||
        !Object.values(store.pending).every((photo) => photo && typeof photo.url === "string" && Number.isFinite(photo.at)) ||
        !store.withheld || typeof store.withheld !== "object" || Array.isArray(store.withheld) ||
        !Object.values(store.withheld).every((marker) => typeof marker === "string"))
      throw new Error("invalid photo store");
    const held = unsaved.has(path) ? memory.get(path) : undefined;
    if (held) {
      store.keys = new Set([...store.keys, ...held.keys]);
      store.checked = new Set([...store.checked, ...held.checked]);
      store.dropped = new Set([...store.dropped, ...held.dropped]);
      store.pending = { ...store.pending, ...held.pending };
      for (const key of [...store.checked, ...store.dropped]) delete store.pending[key];
      store.withheld = { ...store.withheld, ...held.withheld };
    }
    memory.set(path, store);
    fingerprints.set(path, stamp);
    corrupt.delete(path);
    return store;
  } catch (error) {
    // Preserve unreadable bytes before any subsequent replacement, under the write lock.
    if (existsSync(path)) corrupt.add(path);
    console.error("hygiene-gate: unchecked photo store unreadable; allowing images:", (error as Error).message);
    const store = memory.get(path) ?? emptyStore();
    if (stamp !== undefined) {
      memory.set(path, store);
      fingerprints.set(path, stamp);
    }
    return store;
  }
}

function capPending(store: PhotoStore): void {
  const entries = Object.entries(store.pending).sort(([, a], [, b]) => a.at - b.at);
  let bytes = entries.reduce((sum, [, photo]) => sum + Buffer.byteLength(photo.url), 0);
  let count = entries.length;
  for (const [key, photo] of entries) {
    if (count <= MAX_PENDING_ENTRIES && bytes <= MAX_PENDING_BYTES) break;
    delete store.pending[key];
    // Do not requeue an evicted image when history is replayed.
    store.dropped.add(key);
    count--;
    bytes -= Buffer.byteLength(photo.url);
    console.error(`hygiene-gate: dropped oldest pending photo ${key} (queue cap)`);
  }
}

/** Merge under flock: overlapping proxy copies must not lose each other's photos. */
function updateStore(path: string, edit: (store: PhotoStore) => void): PhotoStore {
  let updated: PhotoStore | undefined;
  try {
    privateDirectory(path);
    return withLock(`${path}.lock`, () => {
      const store = readStore(path);
      edit(store);
      capPending(store);
      updated = store;
      memory.set(path, store);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...store, keys: [...store.keys], checked: [...store.checked], dropped: [...store.dropped] }), { mode: 0o600 });
      if (corrupt.has(path) && existsSync(path)) {
        const backup = `${path}.corrupt.${randomUUID()}`;
        renameSync(path, backup);
        console.error(`hygiene-gate: preserved unreadable photo store at ${backup}`);
        corrupt.delete(path);
      }
      renameSync(temporary, path);
      fingerprints.set(path, fingerprint(path));
      unsaved.delete(path);
      return store;
    });
  } catch (error) {
    console.error("hygiene-gate: could not save unchecked photos:", (error as Error).message);
    const store = updated ?? memory.get(path) ?? readStore(path);
    if (!updated) edit(store);
    capPending(store);
    memory.set(path, store);
    unsaved.add(path);
    return store;
  }
}

export function wasDelivered(url: string): boolean {
  return readStore(uncheckedPath()).keys.has(imageKey(url));
}

/** Unknown photos pass through unchanged; known authority verdicts still apply. */
export function deliverForOutage(request: ResponsesRequest, now = Date.now()): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const input = request.input as ResponseInputItem[];
  let freshStart = input.length;
  while (freshStart > 0 && input[freshStart - 1]?.role === "user") freshStart--;
  const store = updateStore(uncheckedPath(), (store) => {
    for (const [index, item] of input.entries()) {
      if (item?.role !== "user") continue;
      for (const part of partsOf(item)) {
        if (part.type !== "input_image" || typeof part.image_url !== "string") continue;
        const key = imageKey(part.image_url);
        if (store.withheld[key] && !store.keys.has(key)) continue;
        if (!store.keys.has(key)) store.keys.add(key);
        if (index >= freshStart && !store.checked.has(key) && !store.dropped.has(key) && !store.pending[key])
          store.pending[key] = { url: part.image_url, at: now };
      }
    }
  });
  return { ...request, input: request.input.map((item) => {
    if (item?.role !== "user" || !Array.isArray(item?.content)) return item;
    const content = partsOf(item).flatMap((part) => {
      if (part.type !== "input_image" || typeof part.image_url !== "string") return [part];
      const key = imageKey(part.image_url);
      if (store.withheld[key] && !store.keys.has(key))
        return [{ type: "input_text", text: store.withheld[key] }];
      return [part, { type: "input_text", text: UNCHECKED_MARKER }];
    });
    return { ...item, content };
  }) as ResponseInputItem[] };
}

/** Cache actual verdicts for outages; restore only photos already delivered here. */
export function preserveDelivered(original: ResponsesRequest, rewritten: ResponsesRequest): ResponsesRequest {
  if (!Array.isArray(original.input) || !Array.isArray(rewritten.input)) return rewritten;
  const input = rewritten.input as ResponseInputItem[];
  const store = updateStore(uncheckedPath(), (store) => {
    (original.input as ResponseInputItem[]).forEach((item, index) => {
      if (item?.role !== "user") return;
      partsOf(item).forEach((part, offset) => {
        if (part.type !== "input_image" || typeof part.image_url !== "string") return;
        const replacement = partsOf(input[index])[offset];
        if (replacement?.type === "input_text" && typeof replacement.text === "string" && replacement.text.startsWith("[hygiene-gate:"))
          store.withheld[imageKey(part.image_url)] = replacement.text;
      });
    });
  });
  return { ...rewritten, input: input.map((item, index) => {
    const source = (original.input as ResponseInputItem[])[index];
    if (source?.role !== "user" || !Array.isArray(item?.content)) return item;
    const content = [...partsOf(item)];
    partsOf(source).forEach((part, offset) => {
      if (part.type === "input_image" && typeof part.image_url === "string" && store.keys.has(imageKey(part.image_url)))
        content[offset] = part;
    });
    return { ...item, content } as ResponseInputItem;
  }) };
}

export function rememberVerdicts(state: GateState): void {
  updateStore(uncheckedPath(), (store) => {
    for (const record of state.images)
      if (isWithheld(record)) store.withheld[record.sha256] = imageMarker(record, state);
  });
}

const retries = new Map<string, Promise<void>>();
const missingEndpointLogged = new Set<string>();
/** Acknowledged entries lose their bytes; delivered hashes remain for history. */
export function retryUnchecked(base: string, path = uncheckedPath(), now = Date.now()): Promise<void> {
  const current = retries.get(path);
  if (current) return current;
  const work = (async () => {
    if (!Object.keys(readStore(path).pending).length) return;
    const lock = `${path}.retry.lock`;
    let held = false;
    try {
      privateDirectory(path);
      held = tryLock(lock).held;
      if (!held) return;
      // Existing stores from older versions also need their limits applied before submission.
      const store = updateStore(path, () => {});
      for (const [key, photo] of Object.entries(store.pending)) {
        if ((photo.nextAttemptAt ?? 0) > now) continue;
        try {
          const reply = await fetch(`${base}/hygiene/recheck`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authorityHeaders() },
            body: JSON.stringify({ url: photo.url, at: photo.at }),
            signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
          });
          if (!reply.ok) {
            if (reply.status !== 404 || !missingEndpointLogged.has(base))
              console.error(`hygiene-gate: queued photo check HTTP ${reply.status} (${key}); backing off`);
            if (reply.status === 404) missingEndpointLogged.add(base);
            await reply.body?.cancel();
          } else {
            const body = await reply.json() as { checked?: boolean };
            if (body.checked === true) {
              updateStore(path, (store) => {
                delete store.pending[key];
                store.checked.add(key);
              });
              continue;
            }
            console.error(`hygiene-gate: queued photo ${key} not checked; backing off`);
          }
        } catch (error) {
          console.error(`hygiene-gate: queued photo ${key} deferred:`, (error as Error).message);
        }
        updateStore(path, (store) => {
          const pending = store.pending[key];
          if (!pending) return;
          pending.attempts = Math.min((pending.attempts ?? 0) + 1, 7);
          pending.nextAttemptAt = Math.max(now, Date.now()) + Math.min(30_000 * 2 ** (pending.attempts - 1), 30 * 60_000);
        });
      }
    } catch (error) {
      console.error("hygiene-gate: queued photo check deferred:", (error as Error).message);
    } finally {
      if (held) unlock(lock);
    }
  })();
  retries.set(path, work);
  void work.finally(() => { if (retries.get(path) === work) retries.delete(path); });
  return work;
}

/** Retry even when no new chat arrives; restart reloads the durable queue. */
export function startPhotoRetries(base: string): () => Promise<void> {
  const path = uncheckedPath();
  const tick = () => { void retryUnchecked(base, path); };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return async () => { clearInterval(timer); await retries.get(path); };
}
