/**
 * The fork trial's numbers, per path (fork or Haiku): attempts, suggestions, accepted
 * suggestions, latency p50/p90, fallback reasons, tokens and an estimate of the
 * weekly quota used. Reads only ids, counts and the `generated_origin` flag, never text.
 *
 *   bun scripts/prediction-trial-report.ts [SINCE]   (ISO time or epoch ms; default: all)
 *
 * Accepted: the chat's next message after the suggested turn completed carries
 * `generated_origin` (Alex sent text that came from Tab). Today's journal logs the same
 * fact per attempt ("prediction <thread> turn <turn>: accepted (by fork)").
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { predictionIndexPath } from "../src/prediction-route";
import { stateDir } from "../src/sessions";

type Tokens = { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };
type Row = {
  at: number;
  threadId?: string;
  turnId?: string;
  model: "fork" | "haiku";
  fallback?: string;
  elapsedMs: number;
  forkMs?: number;
  forkUsage?: Tokens;
  forkAccount?: string;
  haikuUsage?: Tokens;
  suggested: boolean;
  cancelled: boolean;
};

// Anthropic's price ratios, in input-token equivalents; forks write with the 1-hour TTL.
const WEIGHT = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 };
const units = (t: Tokens) =>
  t.inputTokens * WEIGHT.input + t.cacheReadTokens * WEIGHT.read + t.cacheWriteTokens * WEIGHT.write1h + t.outputTokens * WEIGHT.output;

const arg = process.argv[2];
const since = !arg ? 0 : /^\d+$/.test(arg) ? Number(arg) : Date.parse(arg);
const usagePath = join(dirname(predictionIndexPath()), "prediction-usage.jsonl");
const rows = readFileSync(usagePath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row)
  .filter((row) => row.at >= since && row.threadId && row.turnId);

const todayDb = process.env.TODAY_DB_PATH ?? join(dirname(predictionIndexPath()), "daemon.sqlite");
const db = new Database(todayDb, { readonly: true });
/** Whether the chat's next message after `turn` completed came from an accepted suggestion. */
function accepted(thread: string, turn: string): boolean | undefined {
  const done = db
    .query(`SELECT seq FROM events WHERE thread_id = ? AND body GLOB '{"type":"turn_completed",*'
      AND json_extract(body, '$.turn_id') = ? LIMIT 1`)
    .get(thread, turn) as { seq: number } | null;
  if (!done) return undefined;
  const next = db
    .query(`SELECT json_extract(body, '$.generated_origin') AS origin, substr(body, 1, 40) AS head
      FROM events WHERE thread_id = ? AND seq > ? AND (body GLOB '{"type":"user_message",*' OR body GLOB '{"type":"turn_started",*')
      ORDER BY seq LIMIT 1`)
    .get(thread, done.seq) as { origin: number | null; head: string } | null;
  if (!next) return undefined; // Not answered yet.
  return next.head.startsWith('{"type":"user_message"') && next.origin === 1;
}

function pct(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * q;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo));
}

/** Units per 1% of each account's current weekly window, from this proxy's own log. */
function weeklyCalibration(): Map<string, number> {
  const calibration = new Map<string, number>();
  const usageFile = join(stateDir(), "account-usage.json");
  const log = join(stateDir(), "usage.jsonl");
  if (!existsSync(usageFile) || !existsSync(log)) return calibration;
  const windows = new Map<string, { start: number; end: number; utilization: number }>();
  for (const [name, value] of Object.entries(JSON.parse(readFileSync(usageFile, "utf8")) as Record<string, any>)) {
    const week = value?.info?.unifiedWindows?.seven_day;
    if (week?.utilization) windows.set(name, { start: (week.resetsAt - 7 * 86400) * 1000, end: week.resetsAt * 1000, utilization: week.utilization });
  }
  const totals = new Map<string, number>();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const window = windows.get(row.account);
    const at = Date.parse(row.timestamp);
    if (!window || !(at >= window.start && at <= window.end)) continue;
    const usage = row.usage ?? {};
    const created = usage.cache_creation ?? {};
    totals.set(row.account, (totals.get(row.account) ?? 0) +
      (usage.input_tokens ?? 0) * WEIGHT.input + (usage.cache_read_input_tokens ?? 0) * WEIGHT.read +
      (created.ephemeral_5m_input_tokens ?? 0) * WEIGHT.write5m + (created.ephemeral_1h_input_tokens ?? 0) * WEIGHT.write1h +
      (usage.output_tokens ?? 0) * WEIGHT.output);
  }
  for (const [name, total] of totals) calibration.set(name, total / (windows.get(name)!.utilization * 100));
  return calibration;
}

const calibration = weeklyCalibration();
const first = rows[0]?.at;
const last = rows.at(-1)?.at;
console.log(`attempts ${rows.length}${first ? ` from ${new Date(first).toISOString()} to ${new Date(last!).toISOString()}` : ""}`);
for (const path of ["fork", "haiku"] as const) {
  const mine = rows.filter((row) => row.model === path);
  const suggested = mine.filter((row) => row.suggested && !row.cancelled);
  const settled = suggested.map((row) => accepted(row.threadId!, row.turnId!)).filter((x) => x !== undefined);
  const yes = settled.filter(Boolean).length;
  const latency = mine.filter((row) => !row.cancelled).map((row) => row.elapsedMs);
  console.log(`\n${path}: ${mine.length} attempts, ${suggested.length} suggested, accepted ${yes}/${settled.length} answered` +
    (settled.length ? ` (${((100 * yes) / settled.length).toFixed(1)}%)` : ""));
  console.log(`  latency p50 ${pct(latency, 0.5) ?? "-"} ms, p90 ${pct(latency, 0.9) ?? "-"} ms`);
  if (path === "haiku") {
    const reasons = new Map<string, number>();
    for (const row of mine) reasons.set(row.fallback ?? "switch off", (reasons.get(row.fallback ?? "switch off") ?? 0) + 1);
    console.log(`  why Haiku: ${[...reasons].map(([why, n]) => `${why} ${n}`).join(", ")}`);
  }
  const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const byAccount = new Map<string, number>();
  // A fork that fell back to Haiku still spent its tokens: count every fork run.
  for (const row of rows) {
    const usage = path === "fork" ? row.forkUsage : row.haikuUsage;
    if (!usage) continue;
    for (const key of Object.keys(tokens) as Array<keyof Tokens>) tokens[key] += usage[key];
    if (path === "fork" && row.forkAccount) byAccount.set(row.forkAccount, (byAccount.get(row.forkAccount) ?? 0) + units(usage));
  }
  console.log(`  tokens: uncached input ${tokens.inputTokens}, cache read ${tokens.cacheReadTokens}, cache write ${tokens.cacheWriteTokens}, output ${tokens.outputTokens}`);
  for (const [account, spent] of byAccount) {
    const per1 = calibration.get(account);
    console.log(`  ${account}: ${Math.round(spent)} units` + (per1 ? ` = ~${(spent / per1).toFixed(3)}% of its weekly window (estimate from this proxy's log)` : ""));
  }
}
db.close();
