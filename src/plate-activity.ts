import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  injectBlock,
  loadConfig,
  messageKeys,
  renderBlock,
  type PlateActivityConfig,
  type PlateEvent,
} from "./plate-activity.mjs";
import { isCompactionRequest } from "./request";
import { stateDir } from "./sessions";
import type { ResponsesRequest } from "./types";

/**
 * Durable half of the plate-activity block (see plate-activity.mjs).
 *
 * Codex replays history without the text we injected, so every block is
 * stored against (thread, message) and re-applied to that same message on
 * every later request; otherwise the cached prefix would change each turn.
 * A message seen with nothing to report stores a null block for the same
 * reason: events that arrive mid-turn must wait for the next message rather
 * than appear in one already sent.
 *
 * The per-thread cursor advances only when a response using the block
 * succeeds. Until then a retry gets the identical block, and a newer message
 * replaces the unacknowledged one so its events are reported exactly once.
 * Blocks on older messages are re-applied too, since they stay in history.
 */

const PAGE = 100; // plate's /api/events returns at most this many, newest first.
const FETCH_TIMEOUT_MS = 1500;
const RETAIN_DAYS = 60;

let db: Database | undefined;
let dbPath = "";

function open(): Database {
  const directory = stateDir();
  const path = join(directory, "plate-activity.sqlite");
  if (db && dbPath === path) return db;
  db?.close();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  dbPath = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(`CREATE TABLE IF NOT EXISTS cursors (
    thread_id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS blocks (
    thread_id TEXT NOT NULL,
    message_key TEXT NOT NULL,
    block TEXT,
    through_id INTEGER NOT NULL,
    committed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_key)
  )`);
  db.query("DELETE FROM blocks WHERE committed = 1 AND created_at < ?").run(
    new Date(Date.now() - RETAIN_DAYS * 86_400_000).toISOString(),
  );
  return db;
}

type BlockRow = { block: string | null; through_id: number; committed: number };

const getRow = (threadId: string, key: string) =>
  open()
    .query<BlockRow, [string, string]>(
      "SELECT block, through_id, committed FROM blocks WHERE thread_id = ? AND message_key = ?",
    )
    .get(threadId, key);

const storedBlocks = (threadId: string) =>
  new Map(
    open()
      .query<{ message_key: string; block: string }, [string]>(
        "SELECT message_key, block FROM blocks WHERE thread_id = ? AND block IS NOT NULL",
      )
      .all(threadId)
      .map((row) => [row.message_key, row.block]),
  );

const getCursor = (threadId: string) =>
  open()
    .query<{ event_id: number }, [string]>("SELECT event_id FROM cursors WHERE thread_id = ?")
    .get(threadId)?.event_id;

async function fetchEvents(plateUrl: string, since: number): Promise<PlateEvent[]> {
  const url = new URL("/api/events", plateUrl);
  url.searchParams.set("since", String(since));
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`plate events returned HTTP ${response.status}`);
  const events = (await response.json()) as PlateEvent[];
  if (!Array.isArray(events)) throw new Error("plate events returned a non-array");
  return events.sort((a, b) => a.id - b.id);
}

/** Block text for a message not seen before, and the event id it covers. */
async function freshBlock(
  config: PlateActivityConfig,
  threadId: string,
): Promise<{ block: string | null; through: number }> {
  const cursor = getCursor(threadId);
  if (cursor === undefined) {
    // First message in scope: start from now rather than replaying plate's history.
    const latest = (await fetchEvents(config.plateUrl, 0)).at(-1)?.id ?? 0;
    open()
      .query("INSERT OR IGNORE INTO cursors (thread_id, event_id) VALUES (?, ?)")
      .run(threadId, latest);
    return { block: null, through: latest };
  }
  const events = await fetchEvents(config.plateUrl, cursor);
  if (!events.length) return { block: null, through: cursor };
  const truncated = events.length >= PAGE && events[0].id > cursor + 1;
  return {
    block: renderBlock(events, { timeZone: config.timeZone, truncated }),
    through: events.at(-1)!.id,
  };
}

export type PreparedActivity = {
  request: ResponsesRequest;
  /** Call once the model's response succeeded; advances the thread's cursor. */
  commit(): void;
};

const unchanged = (request: ResponsesRequest): PreparedActivity => ({
  request,
  commit() {},
});

/**
 * Adds the thread's plate-activity block to Alex's newest message. Never
 * throws: plate being down or the store failing must not fail the turn.
 * Errors are logged without event text, which can contain private notes.
 */
export async function preparePlateActivity(
  request: ResponsesRequest,
  config: PlateActivityConfig | null = loadConfig(),
): Promise<PreparedActivity> {
  const threadId = request.prompt_cache_key;
  if (!config || typeof threadId !== "string" || !config.threads.has(threadId))
    return unchanged(request);
  const messages = messageKeys(request.input);
  const target = messages.at(-1);
  // A block already present came from an upstream hook that owns its commit.
  if (!target || messages.some((message) => message.hasBlock)) return unchanged(request);
  try {
    if (!getRow(threadId, target.key)) {
      // Compaction only summarizes; a new block belongs on a real turn.
      if (isCompactionRequest(request)) return reapply(request, threadId, messages);
      let fresh: { block: string | null; through: number };
      try {
        fresh = await freshBlock(config, threadId);
      } catch (error) {
        console.error("plate-activity: events unavailable:", (error as Error).name);
        // Pin "nothing" to this message so a later loop request cannot add
        // text to it; -1 leaves an unset cursor unset.
        fresh = { block: null, through: getCursor(threadId) ?? -1 };
      }
      const store = open();
      store.transaction(() => {
        // An unanswered earlier message's events move to this newer one.
        store
          .query("DELETE FROM blocks WHERE thread_id = ? AND committed = 0 AND message_key != ?")
          .run(threadId, target.key);
        store
          .query(
            "INSERT OR IGNORE INTO blocks (thread_id, message_key, block, through_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(threadId, target.key, fresh.block, fresh.through, new Date().toISOString());
      })();
    }
    const prepared = reapply(request, threadId, messages);
    return { ...prepared, commit: () => commitPlateActivity(threadId, target.key) };
  } catch (error) {
    console.error("plate-activity: store unavailable:", (error as Error).name);
    return unchanged(request);
  }
}

/** Puts each stored block back on its message, exactly as first sent. */
function reapply(
  request: ResponsesRequest,
  threadId: string,
  messages: { index: number; key: string }[],
): PreparedActivity {
  const blocks = storedBlocks(threadId);
  let result = request;
  for (const message of messages) {
    const block = blocks.get(message.key);
    if (block) result = injectBlock(result as ResponsesRequest & { input: unknown[] }, message.index, block);
  }
  return unchanged(result);
}

export function commitPlateActivity(threadId: string, key: string): void {
  try {
    const store = open();
    store.transaction(() => {
      const row = getRow(threadId, key);
      if (!row || row.committed) return;
      store
        .query("UPDATE blocks SET committed = 1 WHERE thread_id = ? AND message_key = ?")
        .run(threadId, key);
      if (row.through_id < 0) return;
      store
        .query(
          `INSERT INTO cursors (thread_id, event_id) VALUES (?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET event_id = max(event_id, excluded.event_id)`,
        )
        .run(threadId, row.through_id);
    })();
  } catch (error) {
    console.error("plate-activity: commit failed:", (error as Error).name);
  }
}

/** For tests: drop the cached handle so a new PROXY_STATE_DIR takes effect. */
export function closePlateActivityDb(): void {
  db?.close();
  db = undefined;
  dbPath = "";
}
