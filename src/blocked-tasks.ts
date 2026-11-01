/**
 * Counts and pages the encrypted-task BLOCKED path (request.ts, d527bb3).
 *
 * Overnight Oct 31 to Nov 1 every comb on arch ran OpenAI-only: its Claude
 * reviewers got multi-agent v2 tasks whose payload OpenAI had encrypted, and
 * the rounds still reported "nothing blocks". The proxy now tells such a child
 * to reply BLOCKED, but nobody heard about it. So each distinct agent_message
 * that takes that path is counted in a state file, and a NEW_TASK hit pages
 * COMB_BLOCKED_PAGE_THREAD at most once an hour, naming the orchestrator's
 * model and this machine. With that variable unset, hits are counted and never
 * paged: this repo is a public install target.
 *
 * None of it runs on the request path. The hook only checks, without I/O,
 * whether the request carries an encrypted agent_message, and defers the rest.
 * A child's whole history is replayed every turn, so a message is keyed by its
 * task name and encrypted blob and counted once, and a task served from its
 * task file is remembered too: its replay after Comb deletes the file is no hit.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { processAlive, tryLock, unlock } from "./filelock";
import { localMachine, MACHINE_NAME, THREAD_ID, wakeMachines } from "./hygiene-wake";
import { agentMessagePayload, blockedReason } from "./request";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

const HOUR_MS = 60 * 60_000;
/** Seen keys are kept a week (task files live a day), newest first up to the cap. */
const SEEN_TTL_MS = 7 * 24 * HOUR_MS;
const MAX_SEEN = 5000;
/** A page reservation outlives the longest send (20 s over ssh) only by a margin. */
const PAGE_RESERVE_MS = 60_000;
const PAGE_ID = /^comb-blocked-\d+$/;
const LOCK_TRIES = 40;
const LOCK_RETRY_MS = 25;
const FIELD_MAX = 120;

export const blockedTasksPath = () => process.env.COMB_BLOCKED_STATE ?? join(stateDir(), "blocked-tasks.json");

export type BlockedTaskHit = { taskName: string; reason: string };
export type Orchestrator = { model?: string; thread?: string };
export type PageSender = (text: string, id: string) => Promise<boolean>;
export type RecordResult = { count: number; hits: BlockedTaskHit[]; paged?: Promise<boolean> };

type Store = {
  /** Every BLOCKED-path message, follow-ups included. */
  count: number;
  /** NEW_TASK hits alone: the tasks a reviewer never received. */
  newTasks: number;
  firstAt?: string;
  lastAt?: string;
  /** When a page was last sent. Written only after a send succeeded. */
  lastPagedAt?: number;
  /** No page before this time (set after a corrupt state file was replaced). */
  quietUntil?: number;
  /** A page being sent now, by this pid; it holds the hour only while that is live. */
  paging?: { at: number; pid: number };
  /** Message key -> when it was first seen. */
  seen: Record<string, number>;
};
type Seen = BlockedTaskHit & { key: string; blocked: boolean; newTask: boolean };

// ---- The request-path check ----

const isEncryptedAgentMessage = (item: unknown): item is ResponseInputItem =>
  !!item &&
  typeof item === "object" &&
  (item as ResponseInputItem).type === "agent_message" &&
  Array.isArray((item as ResponseInputItem).content) &&
  ((item as ResponseInputItem).content as unknown[]).some(
    (part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "encrypted_content",
  );

/** Whether a request could hold a BLOCKED-path message. Pure: no I/O. */
export function hasEncryptedAgentMessage(request: ResponsesRequest): boolean {
  return Array.isArray(request?.input) && request.input.some(isEncryptedAgentMessage);
}

/**
 * The /v1/responses hook. Returns undefined when there is nothing to record;
 * otherwise the deferred work, which never rejects. Never throws.
 */
export function noteBlockedTasks(
  request: ResponsesRequest,
  record: (request: ResponsesRequest) => Promise<RecordResult> = recordBlockedTasks,
): Promise<void> | undefined {
  try {
    if (!hasEncryptedAgentMessage(request)) return undefined;
  } catch (error) {
    console.error("blocked-tasks: could not inspect the request:", (error as Error).message);
    return undefined;
  }
  const job: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => record(request))
    .then((result) => result.paged)
    .then(
      () => undefined,
      (error) => console.error("blocked-tasks: could not record:", (error as Error)?.message ?? error),
    )
    .finally(() => pending.delete(job));
  pending.add(job);
  return job;
}

/** Recording and pages still in flight, for the graceful drain (server.ts). */
const pending = new Set<Promise<void>>();

/** Resolves once every recording started so far has finished, its page included. */
export async function drainBlockedTasks(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

// ---- The counter ----

const empty = (): Store => ({ count: 0, newTasks: 0, seen: {} });

function read(path: string, now: number): Store {
  if (!existsSync(path)) return empty();
  const text = readFileSync(path, "utf8");
  try {
    const raw = JSON.parse(text) as Partial<Store>;
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    // Before the age limit, seen was a list of keys: take them as seen now.
    const seen: Record<string, number> = {};
    if (Array.isArray(raw.seen)) for (const key of raw.seen) if (typeof key === "string") seen[key] = now;
    if (raw.seen && typeof raw.seen === "object" && !Array.isArray(raw.seen))
      for (const [key, at] of Object.entries(raw.seen)) if (number(at) !== undefined) seen[key] = at as number;
    const paging = raw.paging as Store["paging"] | undefined;
    return {
      count: Number.isInteger(raw.count) ? raw.count! : 0,
      newTasks: Number.isInteger(raw.newTasks) ? raw.newTasks! : 0,
      firstAt: typeof raw.firstAt === "string" ? raw.firstAt : undefined,
      lastAt: typeof raw.lastAt === "string" ? raw.lastAt : undefined,
      lastPagedAt: number(raw.lastPagedAt),
      quietUntil: number(raw.quietUntil),
      paging: paging && number(paging.at) !== undefined && Number.isInteger(paging.pid) ? { at: paging.at, pid: paging.pid } : undefined,
      seen,
    };
  } catch (error) {
    // Keep the bad file for a look, and stay quiet for an hour: a corrupt file
    // forgets what was seen, and must not turn the replays into a page.
    const aside = `${path}.corrupt-${now}`;
    renameSync(path, aside);
    console.error(`blocked-tasks: state unreadable (${(error as Error).message}); kept as ${aside}`);
    return { ...empty(), quietUntil: now + HOUR_MS };
  }
}

/** Drops keys at or past the age limit, then keeps the newest `max`. */
function prune(seen: Record<string, number>, now: number, ttl: number, max: number): Record<string, number> {
  const kept = Object.entries(seen).filter(([, at]) => now - at < ttl);
  kept.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(kept.slice(0, max));
}

const reservationLive = (paging: Store["paging"], now: number): boolean =>
  !!paging && now - paging.at < PAGE_RESERVE_MS && processAlive(paging.pid);

function write(path: string, store: Store): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Runs `fn` holding `path`, retrying a busy lock off the event loop instead of spinning on it. */
async function withLockSoon<T>(path: string, fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (tryLock(path).held) break;
    if (attempt >= LOCK_TRIES) throw new Error(`lock ${path} is busy`);
    await Bun.sleep(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    unlock(path);
  }
}

const hitKey = (item: ResponseInputItem, taskName: string): string => {
  const parts = Array.isArray(item.content) ? item.content : [];
  const blobs = parts.map((part) => (part as { encrypted_content?: unknown }).encrypted_content).filter((blob) => typeof blob === "string");
  return createHash("sha256").update(`${taskName}\0${blobs.join("\0")}`).digest("hex").slice(0, 24);
};

/** Every encrypted agent_message in the request, with request.ts's decision for it. */
function encryptedMessages(request: ResponsesRequest): Seen[] {
  const out: Seen[] = [];
  for (const item of request.input as unknown[]) {
    if (!isEncryptedAgentMessage(item)) continue;
    const payload = agentMessagePayload(item);
    if (payload.kind === "plain") continue;
    out.push({
      key: hitKey(item, payload.taskName),
      taskName: payload.taskName || "unnamed task",
      blocked: payload.kind === "blocked",
      newTask: payload.kind === "task-file" || payload.newTask,
      reason: payload.kind === "blocked" ? blockedReason(payload).trim() : "",
    });
  }
  return out;
}

export type RecordOptions = {
  path?: string;
  /** Read inside the lock, after any wait for it. */
  now?: () => number;
  /** Defaults to Today when COMB_BLOCKED_PAGE_THREAD is set; otherwise nothing pages. */
  send?: PageSender;
  machine?: string;
  orchestrator?: (childThread: string | undefined) => Orchestrator | undefined;
  seenTtlMs?: number;
  maxSeen?: number;
};

/**
 * Counts this request's new BLOCKED-path messages. `paged` is set only when
 * this call sent a page: the first new NEW_TASK hit in an hour. The hour is
 * held by a reservation while the page is sent and taken only once it is sent,
 * so a page that fails, or a copy that dies mid-send, leaves the hour free.
 */
export async function recordBlockedTasks(request: ResponsesRequest, options: RecordOptions = {}): Promise<RecordResult> {
  const messages = hasEncryptedAgentMessage(request) ? encryptedMessages(request) : [];
  if (!messages.length) return { count: 0, hits: [] };
  const path = options.path ?? blockedTasksPath();
  const clock = options.now ?? Date.now;
  const ttl = options.seenTtlMs ?? SEEN_TTL_MS;
  const max = options.maxSeen ?? MAX_SEEN;
  const send = options.send ?? (pageTarget() ? todayPage : undefined);
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const outcome = await withLockSoon(lock, () => {
    const now = clock();
    const store = read(path, now);
    const inRequest = new Set<string>();
    const fresh = messages.filter((message) => {
      if (inRequest.has(message.key)) return false;
      inRequest.add(message.key);
      const at = store.seen[message.key];
      return at === undefined || now - at >= ttl;
    });
    if (!fresh.length) return { now, store, hits: [] as Seen[], page: false };
    for (const message of fresh) store.seen[message.key] = now;
    store.seen = prune(store.seen, now, ttl, max);
    const hits = fresh.filter((message) => message.blocked);
    const newTasks = hits.filter((hit) => hit.newTask).length;
    if (hits.length) {
      const at = new Date(now).toISOString();
      store.count += hits.length;
      store.newTasks += newTasks;
      store.firstAt ??= at;
      store.lastAt = at;
    }
    const page =
      !!send &&
      newTasks > 0 &&
      (store.lastPagedAt === undefined || now - store.lastPagedAt >= HOUR_MS) &&
      (store.quietUntil === undefined || now >= store.quietUntil) &&
      !reservationLive(store.paging, now);
    if (page) store.paging = { at: now, pid: process.pid };
    write(path, store);
    return { now, store, hits, page };
  });
  const { now, store, hits, page } = outcome;
  const result: RecordResult = { count: store.count, hits: hits.map(({ taskName, reason }) => ({ taskName, reason })) };
  if (!page || !send) return result;
  const hit = hits.find((candidate) => candidate.newTask)!;
  const text = pageText({
    machine: options.machine ?? localMachine(),
    child: request.model,
    childThread: request.prompt_cache_key,
    orchestrator: (options.orchestrator ?? codexParent)(request.prompt_cache_key),
    hit,
    count: store.count,
    newTasks: store.newTasks,
    firstAt: store.firstAt ?? new Date(now).toISOString(),
    path,
  });
  // Settle the reservation: a sent page takes the hour; any other outcome frees it.
  const settle = async (sent: boolean) => {
    try {
      await withLockSoon(lock, () => {
        const current = read(path, now);
        if (sent) current.lastPagedAt = Math.max(current.lastPagedAt ?? 0, now);
        if (current.paging?.at === now && current.paging.pid === process.pid) current.paging = undefined;
        write(path, current);
      });
    } catch (error) {
      // The reservation expires on its own (PAGE_RESERVE_MS), so the hour is never held for long.
      console.error("blocked-tasks: could not settle the page reservation:", (error as Error).message);
    }
    return sent;
  };
  result.paged = send(text, `comb-blocked-${now}`).then(
    (ok) => settle(ok),
    (error) => {
      console.error("blocked-tasks: page failed:", (error as Error)?.message ?? error);
      return settle(false);
    },
  );
  return result;
}

/**
 * One line, at most `max` characters, without control, zero-width or bidi
 * characters (U+202A-E embeddings and overrides, U+2066-9 isolates), which
 * could reorder what the reader sees: page fields come from other agents.
 */
export const pageField = (value: unknown, max = FIELD_MAX): string => {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
};

export function pageText(fields: {
  machine: string;
  child: string;
  childThread?: string;
  orchestrator?: Orchestrator;
  hit: BlockedTaskHit;
  count: number;
  newTasks?: number;
  firstAt: string;
  path: string;
}): string {
  const { orchestrator, hit, count, firstAt, path } = fields;
  const newTasks = fields.newTasks ?? count;
  const machine = pageField(fields.machine, 64);
  const parent = orchestrator?.model
    ? `${pageField(orchestrator.model)}${orchestrator.thread ? ` (thread ${pageField(orchestrator.thread, 40)})` : ""}`
    : "an OpenAI model not found in Codex's state";
  const child = `${pageField(fields.child)}${fields.childThread ? ` (thread ${pageField(fields.childThread, 40)})` : ""}`;
  return [
    `claude-codex-proxy on ${machine}: a Claude subagent got a multi-agent v2 task it could not read and was told to reply BLOCKED.`,
    `Orchestrator: ${parent}. Machine: ${machine}. Child: ${child}. Task: ${pageField(hit.taskName)}. ${pageField(hit.reason, 240)}`,
    "Any comb that orchestrator is running has lost that read; it is degraded, not clean.",
    `${newTasks} unreadable NEW_TASK${newTasks === 1 ? "" : "s"} (${count} BLOCKED message${count === 1 ? "" : "s"} in all) on this proxy since ${pageField(firstAt, 40)}. Further hits within the hour are counted in ${pageField(path, 240)} without another page.`,
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

/** Where pages go: COMB_BLOCKED_PAGE_THREAD on COMB_BLOCKED_PAGE_MACHINE (default this machine). Unset: nowhere. */
export function pageTarget(): { thread: string; machine: string } | undefined {
  const thread = process.env.COMB_BLOCKED_PAGE_THREAD?.trim();
  if (!thread) return undefined;
  return { thread, machine: process.env.COMB_BLOCKED_PAGE_MACHINE?.trim() || localMachine() };
}

/**
 * Today's own `today-daemon send --from claude-codex-proxy` with a client message
 * id, as hygiene-wake.ts wakes chats: locally when the chat lives on this
 * machine, otherwise over ssh, and only to a machine in HYGIENE_GATE_MACHINES
 * (wakeMachines). Null when an argument fails validation; every value that
 * reaches the remote shell matches a strict pattern.
 */
export function blockedTaskPageCommand(
  thread: string,
  machine: string,
  id: string,
  here = localMachine(),
  allowed = wakeMachines(),
): string[] | null {
  if (!THREAD_ID.test(thread) || !MACHINE_NAME.test(machine) || !PAGE_ID.test(id)) return null;
  if (machine === here)
    return [
      process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon"),
      "send", "--socket", `/run/user/${process.getuid!()}/today/daemon.sock`, "--from", "claude-codex-proxy",
      "--client-message-id", id, "--", thread, "-",
    ];
  if (!allowed.has(machine)) return null;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", machine,
    `exec env -u CODEX_THREAD_ID "$HOME/.local/bin/today-daemon" send --socket "/run/user/$(id -u)/today/daemon.sock" --from claude-codex-proxy --client-message-id ${id} -- ${thread} -`,
  ];
}

export const todayPage: PageSender = async (text, id) => {
  // No test may ever message a real chat.
  if (process.env.NODE_ENV === "test" || process.env.COMB_BLOCKED_PAGE === "off") return false;
  const target = pageTarget();
  if (!target) return false;
  const argv = blockedTaskPageCommand(target.thread, target.machine, id);
  if (!argv) {
    console.error(`blocked-tasks: refused to page ${target.thread.slice(0, 8)} on ${target.machine} (bad id, or machine not in HYGIENE_GATE_MACHINES)`);
    return false;
  }
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn(argv, { env, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), argv[0] === "ssh" ? 20_000 : 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return true;
    console.error(`blocked-tasks: page to ${target.thread.slice(0, 8)} on ${target.machine} failed (exit ${code}): ${error.trim().slice(0, 200)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
};
