import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "./handoff";
import { stateDir } from "./sessions";

/**
 * Turns running in each proxy copy, in a table every copy on this machine
 * shares, so the pin API in one handoff slot sees the other slot's turns.
 *
 * Its own database, not sessions.sqlite: a mark matters only while its
 * process lives, so it skips fsync (`synchronous = OFF`). Marks in
 * sessions.sqlite cost two durable commits per turn, about 100 ms under load,
 * with the event loop blocked. A row is (thread, pid); `start` (the /proc start
 * time) tells a live copy from a dead one whose pid was reused.
 */

let db: Database | undefined;
let dbPath = "";
// Counts, not a set: several overlapping turns can finish while SQLite is busy.
const unmarksOwed = new Map<string, Map<string, number>>();

export function inFlightPath(): string {
  return join(stateDir(), "in-flight.sqlite");
}

function open(): Database {
  const path = inFlightPath();
  // Production keeps one stateDir for the process lifetime; tests can switch it.
  if (db && dbPath === path) return db;
  db?.close();
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  dbPath = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA busy_timeout = 200");
  db.exec(`CREATE TABLE IF NOT EXISTS threads_in_flight (
    thread_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    start TEXT,
    count INTEGER NOT NULL,
    PRIMARY KEY (thread_id, pid)
  )`);
  return db;
}

/** This process's start time, read once: it never changes. */
let ownStart: string | null | undefined;
function selfStart(): string | null {
  if (ownStart === undefined) ownStart = processStartTime(process.pid) ?? null;
  return ownStart;
}

/**
 * Count a turn starting (+1) or ending (-1) on `threadId` in this process.
 * Only this process writes its own rows. Rows of a copy that died mid-turn
 * stay until a reader finds that process gone.
 */
export function markThreadInFlight(threadId: string, delta: 1 | -1): void {
  if (delta < 0) {
    const path = inFlightPath();
    let owed = unmarksOwed.get(path);
    if (!owed) unmarksOwed.set(path, owed = new Map());
    owed.set(threadId, (owed.get(threadId) ?? 0) + 1);
  }
  const database = open();
  flushUnmarks(database);
  if (delta > 0) {
    database.query(`INSERT INTO threads_in_flight (thread_id, pid, start, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(thread_id, pid) DO UPDATE SET count = count + 1, start = excluded.start`)
      .run(threadId, process.pid, selfStart());
  }
}

/** Retain failed decrements until a later mark or idle check can commit them. */
function flushUnmarks(database: Database): void {
  const owed = unmarksOwed.get(dbPath);
  if (!owed) return;
  database.transaction(() => {
    const decrement = database.query("UPDATE threads_in_flight SET count = count - ? WHERE thread_id = ? AND pid = ?");
    const prune = database.query("DELETE FROM threads_in_flight WHERE thread_id = ? AND pid = ? AND count <= 0");
    for (const [threadId, count] of owed) {
      decrement.run(count, threadId, process.pid);
      prune.run(threadId, process.pid);
    }
  })();
  unmarksOwed.delete(dbPath);
}

function processAlive(pid: number, start: string | null): boolean {
  if (start !== null) return processStartTime(pid) === start;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Threads with a turn running in any live proxy copy, each with the pids that
 * run it. Rows a dead copy left are skipped and pruned. Throws when the table
 * is unreadable or pending unmarks cannot commit, so idle checks fail closed.
 */
export function sharedThreadsInFlight(): Map<string, number[]> {
  const database = open();
  flushUnmarks(database);
  const rows = database.query("SELECT thread_id, pid, start FROM threads_in_flight WHERE count > 0 ORDER BY pid")
    .all() as Array<{ thread_id: string; pid: number; start: string | null }>;
  const result = new Map<string, number[]>();
  const verdicts = new Map<string, boolean>();
  const dead: Array<{ pid: number; start: string | null }> = [];
  for (const row of rows) {
    const key = `${row.pid}:${row.start}`;
    let live = verdicts.get(key);
    if (live === undefined) {
      live = row.pid === process.pid || processAlive(row.pid, row.start);
      verdicts.set(key, live);
      if (!live) dead.push({ pid: row.pid, start: row.start });
    }
    if (live) result.set(row.thread_id, [...(result.get(row.thread_id) ?? []), row.pid]);
  }
  try {
    const prune = database.query("DELETE FROM threads_in_flight WHERE pid = ? AND start IS ?");
    for (const row of dead) prune.run(row.pid, row.start);
  } catch (cause) {
    console.error("In-flight: pruning a dead proxy copy's marks failed:", (cause as Error).message);
  }
  return result;
}
