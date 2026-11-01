/**
 * Counts and pages the encrypted-task BLOCKED path (request.ts, d527bb3).
 *
 * Overnight Oct 31 to Nov 1 every comb on arch ran OpenAI-only: its Claude
 * reviewers got multi-agent v2 tasks whose payload OpenAI had encrypted, and
 * the rounds still reported "nothing blocks". The proxy now tells such a child
 * to reply BLOCKED, but nobody hears about it. So each distinct agent_message
 * that takes that path is counted in a state file, and a hit pages the build
 * chat (COMB_BLOCKED_PAGE_THREAD on COMB_BLOCKED_PAGE_MACHINE) at most once an
 * hour, naming the orchestrator's model and this machine.
 *
 * A child's whole history is replayed on every turn, so a hit is keyed by the
 * message (task name and encrypted blob) and counted once however often it is
 * serialized again.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { withLock } from "./filelock";
import { localMachine, MACHINE_NAME, THREAD_ID } from "./hygiene-wake";
import { agentMessagePayload, blockedReason } from "./request";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

const HOUR_MS = 60 * 60_000;
const MAX_SEEN = 500;
const PAGE_ID = /^comb-blocked-\d+$/;
/** The build chat (Today v1 UI build) on forge, which asked for these pages on 2026-11-01. */
const DEFAULT_PAGE_THREAD = "1e9cda68-9b3c-408d-84d8-8fdbdb4531a7";
const DEFAULT_PAGE_MACHINE = "forge";

export const blockedTasksPath = () => process.env.COMB_BLOCKED_STATE ?? join(stateDir(), "blocked-tasks.json");

export type BlockedTaskHit = { taskName: string; reason: string };
export type Orchestrator = { model?: string; thread?: string };
export type PageSender = (text: string, id: string) => Promise<boolean>;

type Store = { count: number; firstAt?: string; lastAt?: string; lastPagedAt?: number; seen: string[] };

function read(path: string): Store {
  if (!existsSync(path)) return { count: 0, seen: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    return {
      count: Number.isInteger(raw.count) ? raw.count! : 0,
      firstAt: raw.firstAt,
      lastAt: raw.lastAt,
      lastPagedAt: typeof raw.lastPagedAt === "number" ? raw.lastPagedAt : undefined,
      seen: Array.isArray(raw.seen) ? raw.seen.filter((key) => typeof key === "string") : [],
    };
  } catch (error) {
    console.error("blocked-tasks: state unreadable; starting empty:", (error as Error).message);
    return { count: 0, seen: [] };
  }
}

function update<T>(path: string, edit: (store: Store) => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(`${path}.lock`, () => {
    const store = read(path);
    const result = edit(store);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  });
}

const hitKey = (item: ResponseInputItem, taskName: string): string => {
  const parts = Array.isArray(item.content) ? item.content : [];
  const blobs = parts.map((part) => (part as { encrypted_content?: unknown }).encrypted_content).filter((blob) => typeof blob === "string");
  return createHash("sha256").update(`${taskName}\0${blobs.join("\0")}`).digest("hex").slice(0, 24);
};

/** Every agent_message in this request that request.ts answers with the BLOCKED instruction. */
export function blockedAgentMessages(request: ResponsesRequest): (BlockedTaskHit & { key: string })[] {
  if (!Array.isArray(request.input)) return [];
  const hits: (BlockedTaskHit & { key: string })[] = [];
  for (const item of request.input) {
    if (item?.type !== "agent_message") continue;
    const payload = agentMessagePayload(item);
    if (payload.kind !== "blocked") continue;
    hits.push({ taskName: payload.taskName || "unnamed task", reason: blockedReason(payload).trim(), key: hitKey(item, payload.taskName) });
  }
  return hits;
}

export type RecordOptions = {
  path?: string;
  now?: () => number;
  send?: PageSender;
  machine?: string;
  orchestrator?: (childThread: string | undefined) => Orchestrator | undefined;
};

/**
 * Counts this request's new BLOCKED-path messages. `paged` is set only when
 * this call sent a page (the first new hit in an hour). A page that fails frees
 * the hour again, so the next hit retries it.
 */
export function recordBlockedTasks(
  request: ResponsesRequest,
  options: RecordOptions = {},
): { count: number; hits: BlockedTaskHit[]; paged?: Promise<boolean> } {
  const found = blockedAgentMessages(request);
  const path = options.path ?? blockedTasksPath();
  if (!found.length) return { count: existsSync(path) ? read(path).count : 0, hits: [] };
  const now = (options.now ?? Date.now)();
  const at = new Date(now).toISOString();
  const { count, hits, firstAt, page } = update(path, (store) => {
    const seen = new Set(store.seen);
    const fresh = found.filter((hit) => !seen.has(hit.key) && (seen.add(hit.key), true));
    if (fresh.length) {
      store.count += fresh.length;
      store.firstAt ??= at;
      store.lastAt = at;
      store.seen = [...store.seen, ...fresh.map((hit) => hit.key)].slice(-MAX_SEEN);
    }
    const page = fresh.length > 0 && (store.lastPagedAt === undefined || now - store.lastPagedAt >= HOUR_MS);
    if (page) store.lastPagedAt = now;
    return { count: store.count, hits: fresh.map(({ taskName, reason }) => ({ taskName, reason })), firstAt: store.firstAt, page };
  });
  if (!page) return { count, hits };
  const orchestrator = (options.orchestrator ?? codexParent)(request.prompt_cache_key);
  const text = pageText({
    machine: options.machine ?? localMachine(),
    child: request.model,
    childThread: request.prompt_cache_key,
    orchestrator,
    hit: hits[0],
    count,
    firstAt: firstAt ?? at,
    path,
  });
  const release = () => {
    try {
      update(path, (store) => {
        if (store.lastPagedAt === now) store.lastPagedAt = undefined;
      });
    } catch (error) {
      console.error("blocked-tasks: could not free the page hour:", (error as Error).message);
    }
  };
  const paged = (options.send ?? todayPage)(text, `comb-blocked-${now}`).then(
    (ok) => (ok || release(), ok),
    (error) => {
      console.error("blocked-tasks: page failed:", (error as Error).message);
      release();
      return false;
    },
  );
  return { count, hits, paged };
}

function pageText(fields: {
  machine: string;
  child: string;
  childThread?: string;
  orchestrator?: Orchestrator;
  hit: BlockedTaskHit;
  count: number;
  firstAt: string;
  path: string;
}): string {
  const { machine, child, childThread, orchestrator, hit, count, firstAt, path } = fields;
  const parent = orchestrator?.model
    ? `${orchestrator.model}${orchestrator.thread ? ` (thread ${orchestrator.thread})` : ""}`
    : "an OpenAI model not found in Codex's state";
  return [
    `claude-codex-proxy on ${machine}: a Claude subagent got a multi-agent v2 task it could not read and was told to reply BLOCKED.`,
    `Orchestrator: ${parent}. Machine: ${machine}. Child: ${child}${childThread ? ` (thread ${childThread})` : ""}. Task: ${hit.taskName}. ${hit.reason}`,
    `Any comb that orchestrator is running has lost that read; it is degraded, not clean.`,
    `${count} such task${count === 1 ? "" : "s"} on this proxy since ${firstAt}. Further hits within the hour are counted in ${path} without another page.`,
  ].join("\n");
}

// ---- The orchestrator, from Codex's own state ----

const codexHomes = (): string[] =>
  (process.env.COMB_BLOCKED_CODEX_HOMES?.split(":") ?? [
    process.env.CODEX_HOME ?? "",
    join(homedir(), ".local/state/today/codex-home"),
    join(homedir(), ".codex"),
  ]).filter(Boolean);

/** The parent thread and model of a Codex subagent thread (prompt_cache_key), from thread_spawn_edges. */
export function codexParent(childThread: string | undefined, homes = codexHomes()): Orchestrator | undefined {
  if (!childThread || !THREAD_ID.test(childThread)) return undefined;
  for (const home of [...new Set(homes)]) {
    let files: string[];
    try {
      files = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort().reverse();
    } catch {
      continue;
    }
    for (const file of files) {
      let db: Database | undefined;
      try {
        db = new Database(join(home, file), { readonly: true });
        const row = db
          .query(
            `SELECT e.parent_thread_id AS thread, p.model AS model
             FROM thread_spawn_edges e LEFT JOIN threads p ON p.id = e.parent_thread_id
             WHERE e.child_thread_id = ?`,
          )
          .get(childThread) as { thread?: string; model?: string | null } | null;
        if (row?.thread) return { thread: row.thread, model: row.model ?? undefined };
      } catch {
        // Another Codex version's schema, or a locked file: try the next one.
      } finally {
        db?.close();
      }
    }
  }
  return undefined;
}

// ---- The page ----

/**
 * Today's own `today-daemon send --from claude-codex-proxy` with a client message
 * id, as hygiene-wake.ts wakes chats: locally when the build chat lives on this
 * machine, otherwise over ssh on its machine. Null when an argument fails
 * validation; every value that reaches the remote shell matches a strict pattern.
 */
export function blockedTaskPageCommand(thread: string, machine: string, id: string, here = localMachine()): string[] | null {
  if (!THREAD_ID.test(thread) || !MACHINE_NAME.test(machine) || !PAGE_ID.test(id)) return null;
  if (machine === here)
    return [
      process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon"),
      "send", "--socket", `/run/user/${process.getuid!()}/today/daemon.sock`, "--from", "claude-codex-proxy",
      "--client-message-id", id, "--", thread, "-",
    ];
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", machine,
    `exec env -u CODEX_THREAD_ID "$HOME/.local/bin/today-daemon" send --socket "/run/user/$(id -u)/today/daemon.sock" --from claude-codex-proxy --client-message-id ${id} -- ${thread} -`,
  ];
}

export const todayPage: PageSender = async (text, id) => {
  // No test may ever message a real chat.
  if (process.env.NODE_ENV === "test" || process.env.COMB_BLOCKED_PAGE === "off") return false;
  const thread = process.env.COMB_BLOCKED_PAGE_THREAD?.trim() || DEFAULT_PAGE_THREAD;
  const machine = process.env.COMB_BLOCKED_PAGE_MACHINE?.trim() || DEFAULT_PAGE_MACHINE;
  const argv = blockedTaskPageCommand(thread, machine, id);
  if (!argv) {
    console.error(`blocked-tasks: refused to page an invalid chat or machine (${thread} on ${machine})`);
    return false;
  }
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn(argv, { env, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), argv[0] === "ssh" ? 20_000 : 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return true;
    console.error(`blocked-tasks: page to ${thread.slice(0, 8)} on ${machine} failed (exit ${code}): ${error.trim().slice(0, 200)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
};
