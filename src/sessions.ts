import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Maps Codex conversation prefixes to persisted Claude Code sessions, so a
 * conversation whose Claude process is gone (idle expiry, crash, proxy
 * restart) can continue with `claude --resume`. Resuming replays the exact
 * message history, which keeps Anthropic's prompt cache hitting; re-sending
 * the conversation as one flattened message does not.
 */
export type SessionKey = {
  model: string;
  effort: string;
  instructionsHash: string;
  toolsHash: string;
};

export type StoredSession = SessionKey & {
  sessionId: string;
  seenCount: number;
  prefixHash: string;
  lastText: string;
  lastCallIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stateDir(): string {
  return (
    process.env.PROXY_STATE_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
      "claude-codex-proxy",
    )
  );
}

let db: Database | undefined;
let dbPath = "";

function open(): Database {
  const directory = stateDir();
  const path = join(directory, "sessions.sqlite");
  if (db && dbPath === path) return db;
  db?.close();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  dbPath = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    instructions_hash TEXT NOT NULL,
    tools_hash TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 0,
    prefix_hash TEXT NOT NULL DEFAULT '',
    last_text TEXT NOT NULL DEFAULT '',
    last_call_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS sessions_lookup
    ON sessions (model, effort, instructions_hash, tools_hash, updated_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS thread_accounts (
    thread_id TEXT PRIMARY KEY,
    account TEXT NOT NULL
  )`);
  return db;
}

/** Account ownership outlives transcript pruning and quota resets. */
export function threadAccount(threadId: string): string | undefined {
  const row = open().query("SELECT account FROM thread_accounts WHERE thread_id = ?")
    .get(threadId) as { account: string } | null;
  return row?.account;
}

/** Concurrent first requests must use the assignment already recorded. */
export function claimThreadAccount(threadId: string, account: string): string {
  open().query("INSERT OR IGNORE INTO thread_accounts (thread_id, account) VALUES (?, ?)")
    .run(threadId, account);
  return threadAccount(threadId)!;
}

export function pinThreadAccount(threadId: string, account: string, expected?: string): void {
  if (expected !== undefined) {
    open().query("UPDATE thread_accounts SET account = ? WHERE thread_id = ? AND account = ?")
      .run(account, threadId, expected);
    return;
  }
  open().query(`INSERT INTO thread_accounts (thread_id, account) VALUES (?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET account = excluded.account`).run(threadId, account);
}

/** Record a session as soon as its process starts, so pruning can delete its
 * transcript even if the process never completes a turn. */
export function registerSession(sessionId: string, key: SessionKey): void {
  const now = Date.now();
  open()
    .query(
      `INSERT OR IGNORE INTO sessions
        (session_id, model, effort, instructions_hash, tools_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, key.model, key.effort, key.instructionsHash, key.toolsHash, now, now);
}

export function saveSession(session: StoredSession): void {
  const now = Date.now();
  open()
    .query(
      `INSERT INTO sessions
        (session_id, model, effort, instructions_hash, tools_hash, seen_count,
         prefix_hash, last_text, last_call_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         seen_count = excluded.seen_count,
         prefix_hash = excluded.prefix_hash,
         last_text = excluded.last_text,
         last_call_ids = excluded.last_call_ids,
         updated_at = excluded.updated_at`,
    )
    .run(
      session.sessionId,
      session.model,
      session.effort,
      session.instructionsHash,
      session.toolsHash,
      session.seenCount,
      session.prefixHash,
      session.lastText,
      JSON.stringify(session.lastCallIds),
      now,
      now,
    );
}

type Row = {
  session_id: string;
  seen_count: number;
  prefix_hash: string;
  last_text: string;
  last_call_ids: string;
};

/** Completed sessions with this key whose history is shorter than `inputLength`,
 * most recent first. Callers verify the prefix hash. Unlimited by default:
 * parallel subagents share one key, so a fixed cap hid the session a request
 * actually continues and restarted it from scratch. */
export function findSessions(
  key: SessionKey,
  inputLength: number,
  limit = -1,
): StoredSession[] {
  const rows = open()
    .query(
      `SELECT session_id, seen_count, prefix_hash, last_text, last_call_ids
       FROM sessions
       WHERE model = ? AND effort = ? AND instructions_hash = ? AND tools_hash = ?
         AND seen_count > 0 AND seen_count < ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(
      key.model,
      key.effort,
      key.instructionsHash,
      key.toolsHash,
      inputLength,
      limit,
    ) as Row[];
  return rows.map((row) => ({
    ...key,
    sessionId: row.session_id,
    seenCount: row.seen_count,
    prefixHash: row.prefix_hash,
    lastText: row.last_text,
    lastCallIds: JSON.parse(row.last_call_ids) as string[],
  }));
}

function claudeProjectsDir(): string {
  return join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "projects",
  );
}

/** Keep the completed StructuredOutput result, excluding later failed attempts. */
export function resumeCheckpoint(sessionId: string): string | undefined {
  if (!UUID.test(sessionId)) return undefined;
  try {
    const projects = claudeProjectsDir();
    if (!existsSync(projects)) return undefined;
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, `${sessionId}.jsonl`);
      if (!existsSync(path)) continue;
      const outputs = new Set<string>();
      let checkpoint: string | undefined;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        try {
          const entry = JSON.parse(line);
          const content = entry.message?.content;
          if (!Array.isArray(content) || !UUID.test(entry.uuid ?? "")) continue;
          if (entry.type === "assistant" && !entry.isApiErrorMessage) {
            for (const block of content)
              if (block.type === "tool_use" && block.name === "StructuredOutput") outputs.add(block.id);
          } else if (entry.type === "user") {
            for (const block of content)
              if (block.type === "tool_result" && !block.is_error && outputs.has(block.tool_use_id))
                checkpoint = entry.uuid;
          }
        } catch {}
      }
      return checkpoint;
    }
  } catch {
    // A missing or unreadable cache must not block the normal resume fallback.
    return undefined;
  }
}

/** Delete Claude Code's transcript for a session the proxy created. */
export function deleteTranscript(sessionId: string): void {
  if (!UUID.test(sessionId)) return;
  const projects = claudeProjectsDir();
  if (!existsSync(projects)) return;
  for (const project of readdirSync(projects)) {
    rmSync(join(projects, project, `${sessionId}.jsonl`), { force: true });
    rmSync(join(projects, project, sessionId), { recursive: true, force: true });
  }
}

/**
 * Forget sessions idle longer than `maxAgeMs` and delete their transcripts.
 * Past Claude Code's 1-hour cache TTL a resume would miss the cache anyway.
 */
export function pruneSessions(
  maxAgeMs: number,
  keep: ReadonlySet<string>,
): number {
  const database = open();
  const expired = (
    database
      .query("SELECT session_id FROM sessions WHERE updated_at < ?")
      .all(Date.now() - maxAgeMs) as Array<{ session_id: string }>
  )
    .map((row) => row.session_id)
    .filter((id) => !keep.has(id));
  const remove = database.query("DELETE FROM sessions WHERE session_id = ?");
  for (const id of expired) {
    deleteTranscript(id);
    remove.run(id);
  }
  return expired.length;
}
