import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which Codex threads run as perpetual chats.
 *
 * `~/.config/claude-codex-proxy/perpetual.json` (override: PERPETUAL_CONFIG):
 *
 *   { "titlePrefix": "Today", "threads": ["<thread id>", ...] }
 *
 * A thread qualifies when its Codex title starts with `titlePrefix` and, if
 * `threads` is present, its id is listed. Without the file nothing changes.
 * The file is re-read when it changes, so scope changes need no restart.
 */
export type PerpetualConfig = {
  titlePrefix: string;
  /** Optional allowlist of thread ids, for staged rollout. */
  threads?: string[];
  /** View sawtooth bounds in bytes (gist: 64,000 and 128,000). */
  viewMin: number;
  viewMax: number;
  /** The summarizer's model, on the same Claude Code route and accounts. */
  summaryModel: string;
  summaryEffort?: string;
};

const DEFAULTS: PerpetualConfig = {
  titlePrefix: "Today",
  viewMin: 64_000,
  viewMax: 128_000,
  summaryModel: "haiku",
};

export const configPath = () =>
  process.env.PERPETUAL_CONFIG ?? join(homedir(), ".config", "claude-codex-proxy", "perpetual.json");

let cached: { path: string; mtimeMs: number; config: PerpetualConfig | undefined } | undefined;

export function loadConfig(): PerpetualConfig | undefined {
  const path = configPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  if (cached?.path === path && cached.mtimeMs === mtimeMs) return cached.config;
  let config: PerpetualConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PerpetualConfig>;
    config = {
      ...DEFAULTS,
      ...raw,
      threads: Array.isArray(raw.threads) ? raw.threads.filter((id) => typeof id === "string") : undefined,
    };
  } catch (error) {
    console.error("perpetual: unreadable config:", (error as Error).name);
    config = undefined;
  }
  cached = { path, mtimeMs, config };
  return config;
}

/** Codex's thread store: the newest `state_<n>.sqlite` under CODEX_HOME. */
function codexStateDb(): string | undefined {
  if (process.env.PERPETUAL_CODEX_STATE_DB) return process.env.PERPETUAL_CODEX_STATE_DB;
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return undefined;
  }
  const newest = names
    .map((name) => /^state_(\d+)\.sqlite$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return newest ? join(home, newest[0]) : undefined;
}

const TITLE_TTL_MS = 30_000;
const titles = new Map<string, { title: string | undefined; at: number }>();

/** A thread's title as the Codex app shows it, or undefined when unknown. */
export type TitleLookup = (threadId: string) => string | undefined;

export const codexTitle: TitleLookup = (threadId) => {
  const hit = titles.get(threadId);
  if (hit && Date.now() - hit.at < TITLE_TTL_MS) return hit.title;
  let title: string | undefined;
  const path = codexStateDb();
  if (path && existsSync(path)) {
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      const row = db.query("SELECT name FROM threads WHERE id = ?").get(threadId) as { name: string | null } | null;
      title = row?.name ?? undefined;
    } catch (error) {
      console.error("perpetual: Codex thread store unreadable:", (error as Error).name);
    } finally {
      db?.close();
    }
  }
  titles.set(threadId, { title, at: Date.now() });
  return title;
};

export function inScope(config: PerpetualConfig, threadId: string, title: TitleLookup): boolean {
  if (config.threads && !config.threads.includes(threadId)) return false;
  return title(threadId)?.startsWith(config.titlePrefix) ?? false;
}
