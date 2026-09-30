import { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "./sessions";
import type { ClaudeResult } from "./types";

/**
 * Usage telemetry. `usage.jsonl` is the append-only raw record; `usage.sqlite`
 * is derived from it (synced by byte offset) so it can be deleted and rebuilt.
 *
 * Claude Code reports `usage` per turn but `modelUsage` (including costUSD)
 * cumulatively per process, and a `--resume` fork inherits the parent
 * session's totals. A turn's own cost is therefore the cumulative cost minus
 * the cumulative cost it started from: the same worker's previous turn, or,
 * for a worker's first turn, the row whose cumulative token totals equal this
 * row's totals minus its own usage (the fork's parent, or zero if fresh).
 * `usage` can omit some API calls inside a turn, so the previous turn of the
 * same worker is preferred over token matching whenever it exists.
 */

export type UsageMetadata = {
  requestId: string;
  workerId: string;
  workerTurn: number;
  model: string;
  effort?: string;
  attempt: number;
  launchMode: string;
  resumed: boolean;
  /** Codex's `prompt_cache_key`, which identifies the Codex thread. */
  threadId?: string;
  sessionId?: string;
  resumedFrom?: string;
  /** Proxy account ("default" or an extra account name) that answered. */
  account?: string;
};

type UsageRecord = UsageMetadata & {
  timestamp: string;
  isError: boolean;
  subtype: string;
  usage: ClaudeResult["usage"] | null;
  modelUsage: Record<string, unknown> | null;
  durationMs?: number;
  durationApiMs?: number;
};

type Totals = {
  input: number;
  output: number;
  read: number;
  write: number;
  cost: number;
};

export function recordUsage(result: ClaudeResult, metadata: UsageMetadata): void {
  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    ...metadata,
    isError: result.is_error,
    subtype: result.subtype,
    usage: result.usage ?? null,
    modelUsage: result.modelUsage ?? null,
    durationMs: result.duration_ms,
    durationApiMs: result.duration_api_ms,
  };
  let appended = false;
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    appendFileSync(jsonlPath(), JSON.stringify(record) + "\n", { mode: 0o600 });
    appended = true;
  } catch (error) {
    // Telemetry must not drop a completed model response. Do not log prompt content.
    console.error(
      "Unable to append Claude usage log:",
      (error as NodeJS.ErrnoException).code ?? "unknown error",
    );
  }
  try {
    if (appended) syncUsage();
    else insertRecord(openUsageDb(), record);
  } catch (error) {
    console.error("Unable to update usage database:", (error as Error).message);
  }
}

function jsonlPath(): string {
  return join(stateDir(), "usage.jsonl");
}

let db: Database | undefined;
let dbPath = "";

export function openUsageDb(): Database {
  const directory = stateDir();
  const path = join(directory, "usage.sqlite");
  if (db && dbPath === path) return db;
  db?.close();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  dbPath = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    worker_turn INTEGER NOT NULL,
    thread_id TEXT,
    session_id TEXT,
    resumed_from TEXT,
    model TEXT NOT NULL,
    effort TEXT,
    launch_mode TEXT,
    resumed INTEGER,
    is_error INTEGER NOT NULL,
    subtype TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    thinking_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cache_write_5m_tokens INTEGER,
    cache_write_1h_tokens INTEGER,
    web_search_requests INTEGER,
    web_fetch_requests INTEGER,
    duration_ms INTEGER,
    duration_api_ms INTEGER,
    cost_usd REAL,
    cum_input_tokens INTEGER,
    cum_output_tokens INTEGER,
    cum_cache_read_tokens INTEGER,
    cum_cache_write_tokens INTEGER,
    cum_cost_usd REAL,
    usage_json TEXT,
    model_usage_json TEXT,
    UNIQUE (worker_id, worker_turn)
  )`);
  const columns = db.query("PRAGMA table_info(turns)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "account"))
    db.exec("ALTER TABLE turns ADD COLUMN account TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS turns_ts ON turns (ts)");
  db.exec("CREATE INDEX IF NOT EXISTS turns_thread ON turns (thread_id, ts)");
  db.exec(`CREATE INDEX IF NOT EXISTS turns_cumulative
    ON turns (cum_output_tokens, cum_cache_read_tokens)`);
  // Views are recreated so an upgrade picks up their current definitions.
  const aggregates = `COUNT(*) AS turns,
      SUM(is_error) AS errors,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(thinking_tokens) AS thinking_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(IFNULL(cache_read_tokens, 0) + IFNULL(cache_write_tokens, 0) + IFNULL(input_tokens, 0)), 0), 4) AS cache_hit_ratio,
      ROUND(SUM(cost_usd), 4) AS cost_usd,
      SUM(cost_usd IS NULL AND model_usage_json IS NOT NULL) AS unpriced_turns,
      SUM(duration_ms) AS duration_ms`;
  db.exec(`DROP VIEW IF EXISTS usage_daily`);
  db.exec(`CREATE VIEW usage_daily AS SELECT
      date(ts / 1000, 'unixepoch', 'localtime') AS day, model, ${aggregates}
    FROM turns GROUP BY day, model`);
  // Turns recorded before accounts existed all came from the default login.
  db.exec(`DROP VIEW IF EXISTS usage_by_account`);
  db.exec(`CREATE VIEW usage_by_account AS SELECT
      date(ts / 1000, 'unixepoch', 'localtime') AS day,
      IFNULL(account, 'default') AS account, ${aggregates}
    FROM turns GROUP BY day, IFNULL(account, 'default')`);
  db.exec(`DROP VIEW IF EXISTS usage_hourly`);
  db.exec(`DROP VIEW IF EXISTS usage_weekly`);
  // Weeks start Monday, local time: step back six days, then forward to Monday.
  db.exec(`CREATE VIEW usage_weekly AS SELECT
      date(ts / 1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1') AS week_start,
      model, ${aggregates}
    FROM turns GROUP BY week_start, model`);
  db.exec(`CREATE VIEW usage_hourly AS SELECT
      strftime('%Y-%m-%d %H:00', ts / 1000, 'unixepoch', 'localtime') AS hour, model, ${aggregates}
    FROM turns GROUP BY hour, model`);
  db.exec(`DROP VIEW IF EXISTS usage_by_thread`);
  db.exec(`CREATE VIEW usage_by_thread AS SELECT
      thread_id,
      datetime(MIN(ts) / 1000, 'unixepoch', 'localtime') AS first_turn,
      datetime(MAX(ts) / 1000, 'unixepoch', 'localtime') AS last_turn,
      COUNT(DISTINCT worker_id) AS workers, ${aggregates}
    FROM turns WHERE thread_id IS NOT NULL GROUP BY thread_id`);
  return db;
}

/** Import JSONL rows appended since the last sync. Safe to call repeatedly. */
export function syncUsage(): number {
  const database = openUsageDb();
  const path = jsonlPath();
  if (!existsSync(path)) return 0;
  const row = database
    .query("SELECT value FROM meta WHERE key = 'jsonl_offset'")
    .get() as { value: string } | null;
  let offset = Number(row?.value ?? 0);
  const fd = openSync(path, "r");
  let imported = 0;
  try {
    const size = fstatSync(fd).size;
    // A truncated or replaced log restarts from zero; UNIQUE keys dedupe.
    if (size < offset) offset = 0;
    if (size === offset) return 0;
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    // Only whole lines; a concurrent append may still be writing the last one.
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return 0;
    const text = buffer.subarray(0, end).toString("utf8");
    database.transaction(() => {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record: UsageRecord;
        try {
          record = JSON.parse(line) as UsageRecord;
        } catch {
          continue;
        }
        if (insertRecord(database, record)) imported++;
      }
      database
        .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('jsonl_offset', ?)")
        .run(String(offset + end + 1));
    })();
  } finally {
    closeSync(fd);
  }
  return imported;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optional(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function cumulativeTotals(
  modelUsage: Record<string, unknown> | null | undefined,
): Totals | undefined {
  if (!modelUsage || Object.keys(modelUsage).length === 0) return undefined;
  const totals: Totals = { input: 0, output: 0, read: 0, write: 0, cost: 0 };
  for (const value of Object.values(modelUsage)) {
    const entry = (value ?? {}) as Record<string, unknown>;
    totals.input += num(entry.inputTokens);
    totals.output += num(entry.outputTokens);
    totals.read += num(entry.cacheReadInputTokens);
    totals.write += num(entry.cacheCreationInputTokens);
    totals.cost += num(entry.costUSD);
  }
  return totals;
}

/** This turn's own cost, or null when the process's starting totals are unknown. */
function turnCost(
  database: Database,
  record: UsageRecord,
  cumulative: Totals | undefined,
): number | null {
  const usage = record.usage;
  if (!cumulative) {
    // Failed turns report empty modelUsage; with no tokens they cost nothing.
    const tokens = usage
      ? num(usage.input_tokens) +
        num(usage.output_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens)
      : NaN;
    return tokens === 0 ? 0 : null;
  }
  const prior = database
    .query(
      `SELECT cum_cost_usd FROM turns
       WHERE worker_id = ? AND worker_turn < ? AND cum_cost_usd IS NOT NULL
       ORDER BY worker_turn DESC LIMIT 1`,
    )
    .get(record.workerId, record.workerTurn) as { cum_cost_usd: number } | null;
  if (prior) return round(cumulative.cost - prior.cum_cost_usd);
  if (!usage) return null;
  const base = {
    input: cumulative.input - num(usage.input_tokens),
    output: cumulative.output - num(usage.output_tokens),
    read: cumulative.read - num(usage.cache_read_input_tokens),
    write: cumulative.write - num(usage.cache_creation_input_tokens),
  };
  if (!base.input && !base.output && !base.read && !base.write)
    return round(cumulative.cost);
  const previous = database
    .query(
      `SELECT cum_cost_usd FROM turns
       WHERE cum_output_tokens = ? AND cum_cache_read_tokens = ?
         AND cum_input_tokens = ? AND cum_cache_write_tokens = ?
         AND model = ? AND (? IS NULL OR session_id = ?)
       ORDER BY ts DESC LIMIT 2`,
    )
    .all(base.output, base.read, base.input, base.write, record.model,
      record.resumedFrom ?? null, record.resumedFrom ?? null) as
    Array<{ cum_cost_usd: number | null }>;
  if (previous.length !== 1 || previous[0].cum_cost_usd == null) return null;
  const cost = cumulative.cost - previous[0].cum_cost_usd;
  return cost >= 0 ? round(cost) : null;
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function insertRecord(database: Database, record: UsageRecord): boolean {
  const usage = (record.usage ?? {}) as Record<string, any>;
  const cumulative = cumulativeTotals(record.modelUsage);
  const ts = Date.parse(record.timestamp);
  const result = database
    .query(
      `INSERT OR IGNORE INTO turns (
        ts, request_id, attempt, worker_id, worker_turn, thread_id, session_id,
        resumed_from, model, effort, launch_mode, resumed, is_error, subtype,
        input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
        cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
        web_search_requests, web_fetch_requests, duration_ms, duration_api_ms,
        cost_usd, cum_input_tokens, cum_output_tokens, cum_cache_read_tokens,
        cum_cache_write_tokens, cum_cost_usd, usage_json, model_usage_json,
        account
      ) VALUES (${Array(34).fill("?").join(", ")})`,
    )
    .run(
      Number.isFinite(ts) ? ts : Date.now(),
      record.requestId ?? "",
      record.attempt ?? 1,
      record.workerId ?? "",
      record.workerTurn ?? 0,
      record.threadId ?? null,
      record.sessionId ?? null,
      record.resumedFrom ?? null,
      record.model ?? "",
      record.effort ?? null,
      record.launchMode ?? null,
      record.resumed === undefined ? null : Number(record.resumed),
      Number(Boolean(record.isError)),
      record.subtype ?? null,
      optional(usage.input_tokens),
      optional(usage.output_tokens),
      optional(usage.output_tokens_details?.thinking_tokens),
      optional(usage.cache_read_input_tokens),
      optional(usage.cache_creation_input_tokens),
      optional(usage.cache_creation?.ephemeral_5m_input_tokens),
      optional(usage.cache_creation?.ephemeral_1h_input_tokens),
      optional(usage.server_tool_use?.web_search_requests),
      optional(usage.server_tool_use?.web_fetch_requests),
      optional(record.durationMs),
      optional(record.durationApiMs),
      turnCost(database, record, cumulative),
      cumulative?.input ?? null,
      cumulative?.output ?? null,
      cumulative?.read ?? null,
      cumulative?.write ?? null,
      cumulative ? round(cumulative.cost) : null,
      record.usage ? JSON.stringify(record.usage) : null,
      record.modelUsage ? JSON.stringify(record.modelUsage) : null,
      record.account ?? null,
    );
  return result.changes > 0;
}
