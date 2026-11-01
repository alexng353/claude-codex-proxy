import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseConfigDir, isUnavailable, listAccounts, type Account } from "./accounts";
import { threadsInFlight } from "./claude";
import {
  listThreadAccounts,
  threadAccountSnapshot,
  stateDir,
  writeThreadAccounts,
  type PinChange,
  type PinSnapshot,
  type PinWrite,
} from "./sessions";
import { sharedThreadsInFlight } from "./in-flight";
import { openUsageDb } from "./usage";

/**
 * Local API over thread -> account pins (thread_accounts in sessions.sqlite).
 * Pins only: account order, weekly caps, credentials and login stay Alex's
 * and are never reachable from here.
 *
 *   GET  /pins[?account=NAME]                             list
 *   POST /pins       {pins:[{threadId,account}], force?}  set one or many
 *   POST /pins       {op:"init",pins:[{threadId,account}]} initialize never-pinned threads
 *   POST /pins/move  {from,to,threadIds?,idleForMs?,force?}  bulk move
 *   POST /pins/clear {threadIds}                          clear
 * Writes take `reason` (backup label) and `dryRun`.
 *
 * Access: a loopback socket peer (a proxy bound beyond localhost still answers
 * pins only to this machine), no Origin header (browsers), Host
 * 127.0.0.1:PORT or localhost:PORT (DNS rebinding), JSON bodies only (no-cors
 * form posts), and for writes a bearer token from this machine's pins.token
 * (or PROXY_API_KEY). A process on another machine reaching this port through
 * a tunnel has no token here.
 */

export class PinError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_THREADS = 2000;
const KEEP_BACKUPS = 50;
const POLICY = /order|cap|credential|token|login|auth|password|secret|key/i;
const BACKUP = /^pins-\d{8}T\d{6}Z-[a-z0-9-]+-[0-9a-f]{8}\.json$/;

export type PinInfo = {
  threadId: string;
  account: string;
  lastUsedAt: string | null;
  lastUsedAccount: string | null;
  todayThreadId: string | null;
  title: string | null;
  archived: boolean | null;
};

// --- Access token -----------------------------------------------------------

export function pinsTokenPath(): string {
  return join(stateDir(), "pins.token");
}

/** This machine's pin-write token, created 0600 on first use. Two slots may race: link() publishes one. */
export function pinsToken(): string {
  const path = pinsTokenPath();
  if (!existsSync(path)) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${path} does not hold a pins token`);
  return token;
}

const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** 127.0.0.0/8, ::1, or IPv4-mapped loopback. */
export function isLoopback(address: string): boolean {
  const v4 = address.toLowerCase().replace(/^::ffff:/, "");
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Undefined when the request may proceed; otherwise the refusal. */
function refuse(request: Request, url: URL, peer: string | undefined): Response | undefined {
  return refuseLocal(request, url, peer, "Pins");
}

/** The pins access rules, shared by other local APIs (/agent-names); `label` prefixes refusals. */
export function refuseLocal(request: Request, url: URL, peer: string | undefined, label: string): Response | undefined {
  const fail = (message: string, status: number) =>
    Response.json({ error: { message, type: "invalid_request_error" } }, { status });
  // Fails closed: a caller that cannot name the socket peer gets nothing.
  if (peer === undefined || !isLoopback(peer))
    return fail(`${label}: only loopback peers are answered (peer ${peer ?? "unknown"})`, 403);
  if (request.headers.has("origin"))
    return fail(`${label}: browser requests (with an Origin header) are refused`, 403);
  const port = process.env.PORT ?? "3456";
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = request.headers.get("host");
  if (!hosts.includes(url.host) || (host !== null && !hosts.includes(host)))
    return fail(`${label}: Host must be ${hosts.join(" or ")}`, 403);
  const write = request.method !== "GET";
  if (write) {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return fail(`${label}: content-type must be application/json`, 415);
  }
  const apiKey = process.env.PROXY_API_KEY;
  if (!write && !apiKey) return undefined;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (bearer && (same(bearer, pinsToken()) || (apiKey !== undefined && same(bearer, apiKey)))) return undefined;
  return fail(`${label}: ${write ? "writes need" : "PROXY_API_KEY is set, so reads need"} a bearer token from ${pinsTokenPath()}`, 401);
}

// --- Reading ----------------------------------------------------------------

function todayDbPath(): string {
  return process.env.TODAY_DB_PATH ?? join(homedir(), ".local/state/today/daemon.sqlite");
}

type TodayRow = { engine: string; thread_id: string; title: string; archived: number };

/** Today's engine-thread -> chat map, read-only; empty when Today is absent or unreadable. */
function todayThreads(): Map<string, TodayRow> {
  const path = todayDbPath();
  const map = new Map<string, TodayRow>();
  if (!existsSync(path)) return map;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    // Later rows win in the map: bindings oldest first, then each thread's own
    // current engine id, which beats any binding.
    const rows = db.query(
      `SELECT engine, thread_id, title, archived FROM (
         SELECT b.engine_thread_id AS engine, t.thread_id, t.title, t.archived, 0 AS precedence, b.bound_at_ms AS at
           FROM engine_bindings b JOIN threads t ON t.thread_id = b.thread_id
         UNION ALL
         SELECT engine_thread_id, thread_id, title, archived, 1, updated_at_ms FROM threads
           WHERE engine_thread_id IS NOT NULL)
       ORDER BY precedence, at`,
    ).all() as TodayRow[];
    for (const row of rows) map.set(row.engine, row);
  } catch (cause) {
    console.error("Pins: Today database unreadable:", (cause as Error).message);
  } finally {
    db?.close();
  }
  return map;
}

type LastTurn = { ts: number; account: string | null };

/** Each thread's newest turn. `strict` turns an unreadable history into a 503 instead of "never used". */
function lastTurns(strict = false): Map<string, LastTurn> {
  const map = new Map<string, LastTurn>();
  try {
    const rows = openUsageDb().query(
      `SELECT thread_id, MAX(ts) AS ts, account FROM turns
         WHERE thread_id IS NOT NULL GROUP BY thread_id`,
    ).all() as Array<{ thread_id: string; ts: number; account: string | null }>;
    for (const row of rows) map.set(row.thread_id, { ts: row.ts, account: row.account });
  } catch (cause) {
    console.error("Pins: usage database unreadable:", (cause as Error).message);
    if (strict)
      throw new PinError("Usage history is unreadable, so idleness cannot be checked; nothing changed", 503);
  }
  return map;
}

export function accountNames(): string[] {
  return listAccounts().map((account) => account.name);
}

export function listPins(account?: string) {
  const today = todayThreads();
  const turns = lastTurns();
  const all = listThreadAccounts();
  const counts: Record<string, number> = {};
  for (const pin of all) counts[pin.account] = (counts[pin.account] ?? 0) + 1;
  const pins: PinInfo[] = all
    .filter((pin) => account === undefined || pin.account === account)
    .map((pin) => {
      const turn = turns.get(pin.threadId);
      const chat = today.get(pin.threadId);
      return {
        threadId: pin.threadId,
        account: pin.account,
        lastUsedAt: turn ? new Date(turn.ts).toISOString() : null,
        lastUsedAccount: turn ? turn.account ?? "default" : null,
        todayThreadId: chat?.thread_id ?? null,
        title: chat?.title ?? null,
        archived: chat ? chat.archived !== 0 : null,
      };
    })
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  return { accounts: accountNames(), counts, pins };
}

// --- Validation -------------------------------------------------------------

function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PinError("Body must be a JSON object");
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (POLICY.test(key))
      throw new PinError(
        `Refused "${key}": this API changes pins only. Account order, weekly caps, credentials and login are Alex's.`,
        403,
      );
    throw new PinError(`Unknown field "${key}"`);
  }
  return value as Record<string, unknown>;
}

function account(value: unknown, field: string, names: string[]): string {
  if (typeof value !== "string" || !names.includes(value))
    throw new PinError(`${field}: unknown account ${JSON.stringify(value)} (configured: ${names.join(", ")})`);
  return value;
}

function threadIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_THREADS)
    throw new PinError(`${field} must be a list of 1 to ${MAX_THREADS} thread ids`);
  for (const id of value)
    if (typeof id !== "string" || !/^[\w.:-]{1,200}$/.test(id))
      throw new PinError(`${field}: invalid thread id ${JSON.stringify(id)}`);
  return [...new Set(value as string[])];
}

function label(value: unknown): string {
  if (value === undefined) return "pins";
  if (typeof value !== "string") throw new PinError("reason must be a string");
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return clean || "pins";
}

function flag(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== "boolean") throw new PinError(`${name} must be a boolean`);
  return value === true;
}

/** Claude Code's project folder for the proxy's working directory (claude.ts runs it there). */
function projectSlug(): string {
  return (process.env.CLAUDE_CWD || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * True when the account resumes from the shared transcript folder (claude-account-move
 * step 1), whichever link does it: the slug folder itself (older accounts) or the whole
 * `projects` folder (linkSharedEntries' layout). A missing folder is not shared.
 */
function sharesTranscripts(target: Account): boolean {
  if (target.isDefault) return true;
  const slug = projectSlug();
  try {
    return realpathSync(join(target.dir, "projects", slug)) ===
      realpathSync(join(baseConfigDir(), "projects", slug));
  } catch {
    return false;
  }
}

/**
 * Refuse changes a resume cannot survive: a source or target account that does
 * not share transcripts (always), or an unavailable target (unless forced: the
 * next turn would move the thread off it again). Runs inside the write
 * transaction against the rows it changes.
 */
function checkChanges(changes: PinChange[], force: boolean, warnings: string[]): void {
  const accounts = new Map(listAccounts().map((entry) => [entry.name, entry]));
  const touched = new Set<string>();
  for (const change of changes) {
    if (change.from) touched.add(change.from);
    if (change.to) touched.add(change.to);
  }
  for (const name of touched) {
    const entry = accounts.get(name);
    if (!entry) continue; // A removed account: nothing left to share.
    if (!sharesTranscripts(entry))
      throw new PinError(
        `Account "${name}" does not share transcripts (accounts/${name}/projects/${projectSlug()} is not a link to ` +
          `the shared folder), so a moved chat would fail with "No conversation found with session ID". ` +
          "Run step 1 of the claude-account-move skill first.",
        409,
      );
  }
  for (const name of new Set(changes.map((change) => change.to))) {
    const entry = name === null ? undefined : accounts.get(name);
    if (!entry || !isUnavailable(entry)) continue;
    const warning = `"${entry.name}" is unavailable now (rate-limited, over its weekly cap, or logged out): ` +
      "the next turn of a thread pinned to it runs on another account and moves the pin there.";
    if (!force) throw new PinError(`${warning} Pass force: true to pin it anyway.`, 409);
    warnings.push(warning);
  }
}

// --- Writing ----------------------------------------------------------------

function backupDir(): string {
  return join(stateDir(), "pin-backups");
}

/**
 * Save the pre-edit pins as JSON (a few KB, so the write stays fast): written
 * 0600 under a temp name, fsynced, read back and compared, then renamed into
 * place. A failure removes the temp file and aborts the write.
 */
function saveBackup(reason: string, snapshot: PinSnapshot): string {
  const directory = backupDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `pins-${stamp}-${reason}-${randomBytes(4).toString("hex")}.json`;
  const path = join(directory, name);
  const tmp = join(directory, `.${name}.tmp`);
  const text = `${JSON.stringify({ savedAt: new Date().toISOString(), database: join(stateDir(), "sessions.sqlite"), ...snapshot })}\n`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    const copy = JSON.parse(readFileSync(tmp, "utf8")) as PinSnapshot;
    if (JSON.stringify([copy.threadAccounts, copy.generations]) !==
        JSON.stringify([snapshot.threadAccounts, snapshot.generations]))
      throw new Error(`Pin backup ${name} did not read back intact`);
    renameSync(tmp, path);
    // Make the rename itself durable before the pins change.
    const dirFd = openSync(directory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
  try {
    // Only published (verified) backups match BACKUP; temp files are never pruned here.
    const published = readdirSync(directory).filter((file) => BACKUP.test(file)).sort();
    for (const file of published.slice(0, Math.max(0, published.length - KEEP_BACKUPS)))
      rmSync(join(directory, file), { force: true });
  } catch (cause) {
    console.error("Pins: pruning old backups failed:", (cause as Error).message);
  }
  return path;
}

type Write = {
  dryRun: boolean;
  force: boolean;
  reason: string;
  warnings: string[];
  plan: (current: ReadonlyMap<string, string>, history: ReadonlySet<string>) => PinWrite[];
};

export type PinResult = {
  dryRun: boolean;
  backup: string | null;
  changed: number;
  changes: PinChange[];
  warnings: string[];
  pins?: PinWrite[];
};

function diff(current: ReadonlyMap<string, string>, writes: PinWrite[]): PinChange[] {
  return writes
    .map((edit) => ({ threadId: edit.threadId, from: current.get(edit.threadId) ?? null, to: edit.account }))
    .filter((change) => change.from !== change.to);
}

function apply(write: Write): PinResult {
  const { warnings } = write;
  if (write.dryRun) {
    const snapshot = threadAccountSnapshot();
    const current = new Map(snapshot.threadAccounts.map((pin) => [pin.threadId, pin.account]));
    const history = new Set(snapshot.generations.map((row) => row.threadId));
    const changes = diff(current, write.plan(current, history));
    checkChanges(changes, write.force, warnings);
    return { dryRun: true, backup: null, changed: changes.length, changes, warnings };
  }
  const result = writeThreadAccounts(
    (current, history) => {
      const writes = write.plan(current, history);
      checkChanges(diff(current, writes), write.force, warnings);
      return writes;
    },
    (snapshot) => saveBackup(write.reason, snapshot),
  );
  if (result.changes.length)
    console.error(`Pins: ${result.changes.length} change(s) (${write.reason}), backup ${result.backup}`);
  return { dryRun: false, backup: result.backup, changed: result.changes.length, changes: result.changes, warnings };
}

/** A warning for each id with no turns and no Today chat: likely a Today id or a typo. */
function unknownIds(ids: Iterable<string>): string[] {
  const turns = lastTurns();
  const today = todayThreads();
  return [...ids]
    .filter((id) => !turns.has(id) && !today.has(id))
    .map((id) => `${id}: no turns and no Today chat; is this the Codex (engine) thread id?`);
}

export function setPins(input: unknown): PinResult {
  const fields = body(input, ["op", "pins", "reason", "dryRun", "force"]);
  if (fields.op !== undefined && fields.op !== "init" && fields.op !== "set")
    throw new PinError("op must be init or set");
  const initialize = fields.op === "init";
  const names = accountNames();
  if (!Array.isArray(fields.pins) || fields.pins.length === 0 || fields.pins.length > MAX_THREADS)
    throw new PinError(`pins must be a list of 1 to ${MAX_THREADS} {threadId, account}`);
  const edits = fields.pins.map((pin, index) => {
    const entry = body(pin, ["threadId", "account"]);
    const [threadId] = threadIds([entry.threadId], `pins[${index}].threadId`);
    return { threadId, account: account(entry.account, `pins[${index}].account`, names) };
  });
  if (new Set(edits.map((edit) => edit.threadId)).size !== edits.length)
    throw new PinError("pins lists a thread more than once");
  const warnings = unknownIds(edits.map((edit) => edit.threadId));
  let pins: PinWrite[] = [];
  const result = apply({
    dryRun: flag(fields.dryRun, "dryRun"),
    force: flag(fields.force, "force"),
    reason: label(fields.reason),
    warnings,
    // writeThreadAccounts calls this under its BEGIN IMMEDIATE transaction.
    plan: (current, history) => {
      if (!initialize) return edits;
      pins = edits.map(edit => ({
        ...edit,
        account: current.get(edit.threadId) ?? (history.has(edit.threadId) ? null : edit.account),
      }));
      return edits.filter(edit => !current.has(edit.threadId) && !history.has(edit.threadId));
    },
  });
  return initialize ? { ...result, pins } : result;
}

export function movePins(input: unknown): PinResult {
  const fields = body(input, ["from", "to", "threadIds", "idleForMs", "reason", "dryRun", "force"]);
  const names = accountNames();
  // A pin can name an account that was since removed; moving off it is allowed.
  if (typeof fields.from !== "string" || !fields.from) throw new PinError("from must be an account name");
  const from = fields.from;
  const to = account(fields.to, "to", names);
  if (from === to) throw new PinError("from and to are the same account");
  const only = fields.threadIds === undefined ? undefined : new Set(threadIds(fields.threadIds, "threadIds"));
  let idleSince: number | undefined;
  if (fields.idleForMs !== undefined) {
    if (typeof fields.idleForMs !== "number" || !(fields.idleForMs >= 0))
      throw new PinError("idleForMs must be a non-negative number");
    idleSince = Date.now() - fields.idleForMs;
  }
  const dryRun = flag(fields.dryRun, "dryRun");
  const force = flag(fields.force, "force");
  const reason = label(fields.reason ?? `move-${from}-${to}`);
  // Fails closed: unreadable usage must not make every thread look idle.
  const turns = idleSince === undefined ? undefined : lastTurns(true);
  // This copy's own turns, plus every live copy's from the shared table (the
  // other handoff slot). Fails closed like the usage history.
  const running = idleSince === undefined ? undefined : threadsInFlight();
  let elsewhere: Map<string, number[]> | undefined;
  if (idleSince !== undefined) {
    try {
      elsewhere = sharedThreadsInFlight();
    } catch (cause) {
      console.error("Pins: in-flight table unreadable:", (cause as Error).message);
      throw new PinError("Running turns are unreadable, so idleness cannot be checked; nothing changed", 503);
    }
  }
  const warnings = only ? unknownIds(only) : [];
  return apply({
    dryRun,
    force,
    reason,
    warnings,
    plan: (current) =>
      [...current]
        .filter(([threadId, pinned]) => {
          if (pinned !== from || (only && !only.has(threadId))) return false;
          if (idleSince === undefined) return true;
          if (running!.has(threadId)) {
            warnings.push(`${threadId}: skipped, a turn is running in this proxy copy`);
            return false;
          }
          const pids = elsewhere!.get(threadId)?.filter((pid) => pid !== process.pid);
          if (pids?.length) {
            warnings.push(`${threadId}: skipped, a turn is running in another proxy copy (pid ${pids.join(", ")})`);
            return false;
          }
          return (turns!.get(threadId)?.ts ?? 0) < idleSince;
        })
        .map(([threadId]) => ({ threadId, account: to })),
  });
}

export function clearPins(input: unknown): PinResult {
  const fields = body(input, ["threadIds", "reason", "dryRun"]);
  const ids = threadIds(fields.threadIds, "threadIds");
  return apply({
    dryRun: flag(fields.dryRun, "dryRun"),
    force: false,
    reason: label(fields.reason ?? "clear"),
    warnings: [],
    plan: () => ids.map((threadId) => ({ threadId, account: null })),
  });
}

/** Routes under /pins, or undefined for any other path. The caller has already
 * refused forwarded (non-local) requests; this checks the socket peer, origin,
 * host and token. */
export async function handlePinsRoute(request: Request, url: URL, peer?: string): Promise<Response | undefined> {
  if (url.pathname !== "/pins" && !url.pathname.startsWith("/pins/")) return undefined;
  const fail = (message: string, status: number) =>
    Response.json({ error: { message, type: "invalid_request_error" } }, { status });
  try {
    const refused = refuse(request, url, peer);
    if (refused) return refused;
    if (url.pathname === "/pins" && request.method === "GET") {
      const filter = url.searchParams.get("account") ?? undefined;
      return Response.json(listPins(filter));
    }
    const route = { "/pins": setPins, "/pins/move": movePins, "/pins/clear": clearPins }[url.pathname];
    if (!route || request.method !== "POST") return fail("Not found", 404);
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return fail("Body must be JSON", 400);
    }
    return Response.json(route(input));
  } catch (cause) {
    if (cause instanceof PinError) return fail(cause.message, cause.status);
    return fail(`Pins: ${(cause as Error).message}`, 500);
  }
}
