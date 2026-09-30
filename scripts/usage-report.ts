#!/usr/bin/env bun
/**
 * Summarize Claude usage recorded by the proxy.
 *
 *   bun run usage [--days 14] [--threads 10] [--json]
 *
 * Syncs usage.sqlite from usage.jsonl first, so it works whether or not the
 * proxy is running. For ad-hoc queries, open usage.sqlite with sqlite3 and use
 * the turns table or the usage_daily, usage_hourly, and usage_by_thread views.
 */
import { openUsageDb, syncUsage } from "../src/usage";

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const days = flag("days", 14);
const threadLimit = flag("threads", 10);
const asJson = process.argv.includes("--json");

syncUsage();
const db = openUsageDb();
const since = `datetime('now', '-${days} days')`;
const window = `ts >= CAST(strftime('%s', ${since}) AS INTEGER) * 1000`;
const sums = `COUNT(*) AS turns,
  SUM(is_error) AS errors,
  SUM(input_tokens) AS input,
  SUM(output_tokens) AS output,
  SUM(thinking_tokens) AS thinking,
  SUM(cache_read_tokens) AS cache_read,
  SUM(cache_write_tokens) AS cache_write,
  ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(IFNULL(cache_read_tokens, 0) + IFNULL(cache_write_tokens, 0) + IFNULL(input_tokens, 0)), 0), 3) AS hit_ratio,
  ROUND(SUM(cost_usd), 2) AS cost_usd,
  SUM(cost_usd IS NULL AND model_usage_json IS NOT NULL) AS unpriced`;

const report = {
  window: `last ${days} days`,
  allTime: db.query(`SELECT ${sums} FROM turns`).get(),
  total: db.query(`SELECT ${sums} FROM turns WHERE ${window}`).get(),
  daily: db
    .query(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, ${sums}
       FROM turns WHERE ${window} GROUP BY day ORDER BY day`,
    )
    .all(),
  byModel: db
    .query(
      `SELECT model, effort, ${sums} FROM turns WHERE ${window}
       GROUP BY model, effort ORDER BY SUM(cost_usd) DESC`,
    )
    .all(),
  perTurn: perTurnStats(),
  topThreads: db
    .query(
      `SELECT thread_id, datetime(MAX(ts) / 1000, 'unixepoch', 'localtime') AS last_turn,
         COUNT(DISTINCT worker_id) AS workers, ${sums}
       FROM turns WHERE ${window} AND thread_id IS NOT NULL
       GROUP BY thread_id ORDER BY SUM(cost_usd) DESC LIMIT ${threadLimit}`,
    )
    .all(),
  untrackedThreadTurns: db
    .query(`SELECT COUNT(*) AS turns FROM turns WHERE ${window} AND thread_id IS NULL`)
    .get(),
};

function perTurnStats() {
  const rows = db
    .query(
      `SELECT cost_usd AS cost,
         IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_write_tokens, 0) AS context,
         output_tokens AS output, duration_ms AS duration
       FROM turns WHERE ${window} AND usage_json IS NOT NULL`,
    )
    .all() as Record<string, number | null>[];
  const stats: Record<string, Record<string, number>> = {};
  for (const key of ["cost", "context", "output", "duration"]) {
    const values = rows
      .map((row) => row[key])
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    if (values.length === 0) continue;
    const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const digits = key === "cost" ? 4 : 0;
    const fix = (value: number) => Number(value.toFixed(digits));
    stats[key] = { n: values.length, mean: fix(mean), p50: fix(at(0.5)), p95: fix(at(0.95)), max: fix(values.at(-1)!) };
  }
  return stats;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const section = (title: string, rows: unknown) => {
    console.log(`\n${title}`);
    console.table(rows);
  };
  section("All time", [report.allTime]);
  section(`Total, ${report.window}`, [report.total]);
  section("Daily (local time)", report.daily);
  section("By model and effort", report.byModel);
  section("Per turn", report.perTurn);
  section(`Top ${threadLimit} Codex threads by cost`, report.topThreads);
  console.log(
    `\nTurns without a Codex thread id in this window: ${(report.untrackedThreadTurns as { turns: number }).turns}` +
      " (recorded before thread tracking, or the client sent no prompt_cache_key).",
  );
  console.log(
    "cost_usd is Claude Code's API-list-price equivalent, not a subscription charge; " +
      "unpriced turns have no known starting total.",
  );
}
