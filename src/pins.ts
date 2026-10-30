import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAccounts } from "./accounts";
import {
  backupSessions,
  listThreadAccounts,
  writeThreadAccounts,
  type PinChange,
  type PinWrite,
} from "./sessions";
import { openUsageDb } from "./usage";

/**
 * Local API over thread -> account pins (thread_accounts in sessions.sqlite).
 * Pins only: account order, weekly caps, credentials and login stay Alex's
 * and are never reachable from here.
 *
 *   GET  /pins[?account=NAME]                      list
 *   POST /pins       {pins:[{threadId,account}]}   set one or many
 *   POST /pins/move  {from,to,threadIds?,idleForMs?}  bulk move
 *   POST /pins/clear {threadIds}                   clear
 * Writes take `reason` (backup file label) and `dryRun`. A write backs up
 * sessions.sqlite first, applies in one transaction, and returns the changes.
 */

export class PinError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_THREADS = 2000;
const POLICY = /order|cap|credential|token|login|auth|password|secret|key/i;

export type PinInfo = {
  threadId: string;
  account: string;
  lastUsedAt: string | null;
  lastUsedAccount: string | null;
  todayThreadId: string | null;
  title: string | null;
  archived: boolean | null;
};

function todayDbPath(): string {
  return process.env.TODAY_DB_PATH ?? join(homedir(), ".local/state/today/daemon.sqlite");
}

type TodayRow = { engine: string; thread_id: string; title: string; archived: number };

/** Today's engine-thread -> chat map, read-only; empty when Today is absent. */
function todayThreads(): Map<string, TodayRow> {
  const path = todayDbPath();
  const map = new Map<string, TodayRow>();
  if (!existsSync(path)) return map;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(
      `SELECT b.engine_thread_id AS engine, t.thread_id, t.title, t.archived
         FROM engine_bindings b JOIN threads t ON t.thread_id = b.thread_id
       UNION ALL
       SELECT engine_thread_id, thread_id, title, archived FROM threads
         WHERE engine_thread_id IS NOT NULL`,
    ).all() as TodayRow[];
    // The thread's own current engine id wins over an older binding.
    for (const row of rows) map.set(row.engine, row);
  } catch (cause) {
    console.error("Pins: Today database unreadable:", (cause as Error).message);
  } finally {
    db?.close();
  }
  return map;
}

function lastTurns(): Map<string, { ts: number; account: string | null }> {
  const map = new Map<string, { ts: number; account: string | null }>();
  try {
    const rows = openUsageDb().query(
      `SELECT thread_id, MAX(ts) AS ts, account FROM turns
         WHERE thread_id IS NOT NULL GROUP BY thread_id`,
    ).all() as Array<{ thread_id: string; ts: number; account: string | null }>;
    for (const row of rows) map.set(row.thread_id, { ts: row.ts, account: row.account });
  } catch (cause) {
    console.error("Pins: usage database unreadable:", (cause as Error).message);
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

type Write = { dryRun: boolean; reason: string; plan: (current: ReadonlyMap<string, string>) => PinWrite[] };

export type PinResult = { dryRun: boolean; backup: string | null; changed: number; changes: PinChange[] };

function apply(write: Write): PinResult {
  if (write.dryRun) {
    const current = new Map(listThreadAccounts().map((pin) => [pin.threadId, pin.account]));
    const changes = write.plan(current)
      .map((edit) => ({ threadId: edit.threadId, from: current.get(edit.threadId) ?? null, to: edit.account }))
      .filter((change) => change.from !== change.to);
    return { dryRun: true, backup: null, changed: changes.length, changes };
  }
  const backup = backupSessions(write.reason);
  const changes = writeThreadAccounts(write.plan);
  console.error(`Pins: ${changes.length} change(s) (${write.reason}), backup ${backup}`);
  return { dryRun: false, backup, changed: changes.length, changes };
}

const dryRun = (value: unknown) => {
  if (value !== undefined && typeof value !== "boolean") throw new PinError("dryRun must be a boolean");
  return value === true;
};

export function setPins(input: unknown): PinResult {
  const fields = body(input, ["pins", "reason", "dryRun"]);
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
  return apply({ dryRun: dryRun(fields.dryRun), reason: label(fields.reason), plan: () => edits });
}

export function movePins(input: unknown): PinResult {
  const fields = body(input, ["from", "to", "threadIds", "idleForMs", "reason", "dryRun"]);
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
  const turns = idleSince === undefined ? undefined : lastTurns();
  return apply({
    dryRun: dryRun(fields.dryRun),
    reason: label(fields.reason ?? `move-${from}-${to}`),
    plan: (current) =>
      [...current]
        .filter(([threadId, pinned]) =>
          pinned === from &&
          (!only || only.has(threadId)) &&
          (idleSince === undefined || (turns!.get(threadId)?.ts ?? 0) < idleSince))
        .map(([threadId]) => ({ threadId, account: to })),
  });
}

export function clearPins(input: unknown): PinResult {
  const fields = body(input, ["threadIds", "reason", "dryRun"]);
  const ids = threadIds(fields.threadIds, "threadIds");
  return apply({
    dryRun: dryRun(fields.dryRun),
    reason: label(fields.reason ?? "clear"),
    plan: () => ids.map((threadId) => ({ threadId, account: null })),
  });
}

/** Routes under /pins, or undefined for any other path. Caller has already
 * refused forwarded (non-local) requests and checked the API key. */
export async function handlePinsRoute(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname !== "/pins" && !url.pathname.startsWith("/pins/")) return undefined;
  const fail = (message: string, status: number) =>
    Response.json({ error: { message, type: "invalid_request_error" } }, { status });
  try {
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
