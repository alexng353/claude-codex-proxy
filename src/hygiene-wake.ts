/**
 * Held messages and the unlock wake (Alex, 2026-11-01: "hit you with a ping
 * every time the gate unlocks. it should wake you automatically if there's
 * something queued").
 *
 * While the gate is armed, a message Alex types is answered with the lock
 * text and nobody acts on it. The gate records each one here. When the gate
 * unlocks (photo accepted, BYPASS, DELAY), every chat with held messages gets
 * one Today message listing them, which starts a turn there. The chat whose
 * own message unlocked the gate gets the list as a hidden note on that turn
 * instead. Held messages leave this store in the same locked step that turns
 * them into a wake, so a second unlock finds nothing; each wake's send uses a
 * client message id keyed by the unlock, so a retry never posts twice.
 *
 * The store is its own file with its own lock, not the gate state: a message
 * that arrives while a photo is being checked must be recorded without
 * waiting for the gate's lock, which the check holds.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { processAlive, withLock } from "./filelock";
import { clockLabel, localTime, NOTE_TAG } from "./hygiene";

export type HeldMessage = {
  /** Codex thread id (prompt_cache_key). */
  thread: string;
  /** Message key (messageKeys), so a retried request is held once. */
  key: string;
  at: string;
  text: string;
  /** Images or files that were not proof photos. */
  attachments: number;
};

export type Wake = {
  /** Today client message id: keyed by the unlock and the chat. */
  id: string;
  thread: string;
  at: string;
  /** Dropped once sent; the id and times stay as a receipt. */
  text?: string;
  sentAt?: string;
  failedAt?: string;
  attempts?: number;
  nextAttemptAt?: number;
};

type Store = { held: HeldMessage[]; wakes: Wake[] };

export type WakeResult = "sent" | "retry" | "failed";
export type WakeSender = (wake: { id: string; thread: string; text: string }) => Promise<WakeResult>;

/** Held messages older than this are not worth waking a chat for. */
const HELD_MAX_AGE_MS = 24 * 3_600_000;
/** A wake that has not gone out within a day is dropped. */
const WAKE_GIVE_UP_MS = 24 * 3_600_000;
const RECEIPT_KEEP_MS = 7 * 86_400_000;
const MAX_LISTED = 20;
const MAX_TEXT = 1500;

export const storePath = (statePath: string) => join(dirname(statePath), "hygiene-held.json");

function read(path: string): Store {
  if (!existsSync(path)) return { held: [], wakes: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Store>;
    return { held: Array.isArray(raw.held) ? raw.held : [], wakes: Array.isArray(raw.wakes) ? raw.wakes : [] };
  } catch (error) {
    console.error("hygiene-gate: held-message store unreadable; starting empty:", (error as Error).message);
    return { held: [], wakes: [] };
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

/** Records a message the gate answered with its lock text instead of the model. */
export function holdMessage(statePath: string, message: HeldMessage): void {
  if (!message.thread || !message.key || (!message.text && !message.attachments)) return;
  try {
    update(storePath(statePath), (store) => {
      if (store.held.some((h) => h.thread === message.thread && h.key === message.key)) return;
      store.held.push({ ...message, text: message.text.slice(0, MAX_TEXT) });
    });
  } catch (error) {
    // Losing the wake must never break the gate's reply.
    console.error("hygiene-gate: could not record a held message:", (error as Error).message);
  }
}

const stamp = (at: string) => {
  const ms = Date.parse(at);
  const day = new Date(`${localTime(ms).day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${clockLabel(ms)} ${day}`;
};

function listing(messages: HeldMessage[], escape: (text: string) => string): string[] {
  const shown = messages.slice(-MAX_LISTED);
  const lines = shown.map((m) => {
    const files = m.attachments ? ` [+${m.attachments} attachment${m.attachments === 1 ? "" : "s"}]` : "";
    const text = m.text ? escape(m.text.replace(/\s*\n\s*/g, " / ")) : "(no text)";
    return `- ${stamp(m.at)}: ${text}${files}`;
  });
  if (messages.length > shown.length) lines.unshift(`- (${messages.length - shown.length} earlier messages not listed)`);
  return lines;
}

export function wakeText(messages: HeldMessage[], unlockedAt: number, reason: string): string {
  return [
    `Hygiene gate unlocked at ${clockLabel(unlockedAt)} (${reason}). While it was armed it held these messages from Alex in this chat and answered them only with its lock text, so nobody has acted on them yet:`,
    ...listing(messages, (t) => t),
    "Answer them now, before anything else.",
  ].join("\n");
}

export function heldNoteText(messages: HeldMessage[]): string {
  return [
    `<${NOTE_TAG}>`,
    "Supplied automatically by Alex's hygiene gate; Alex did not type this.",
    "This message unlocked the gate. While it was armed it answered these earlier messages from Alex in this chat with its lock text, so nobody has acted on them yet:",
    ...listing(messages, (t) => t.replace(/</g, "&lt;")),
    "Answer them first, then this message.",
    `</${NOTE_TAG}>`,
  ].join("\n");
}

/**
 * The gate is open: take every held message out of the store. Those from
 * `current` (the chat whose turn is being let through now) come back for a
 * note; every other chat gets a wake. Returns null when nothing was held.
 */
export function releaseHeld(
  statePath: string,
  now: number,
  reason: string,
  current?: string,
): { note: HeldMessage[]; woke: number } | null {
  const path = storePath(statePath);
  // Most turns pass a clear gate with nothing held: skip the lock.
  if (!read(path).held.length) return null;
  try {
    return update(path, (store) => {
      const fresh = store.held.filter((h) => now - Date.parse(h.at) <= HELD_MAX_AGE_MS);
      store.held = [];
      store.wakes = store.wakes.filter((w) => !(w.sentAt || w.failedAt) || now - Date.parse(w.at) <= RECEIPT_KEEP_MS);
      if (!fresh.length) return null;
      const byThread = new Map<string, HeldMessage[]>();
      for (const h of fresh) byThread.set(h.thread, [...(byThread.get(h.thread) ?? []), h]);
      const note = current ? byThread.get(current) ?? [] : [];
      if (current) byThread.delete(current);
      for (const [thread, messages] of byThread) {
        const id = `hygiene-unlock-${now}-${createHash("sha256").update(thread).digest("hex").slice(0, 12)}`;
        if (store.wakes.some((w) => w.id === id)) continue;
        store.wakes.push({ id, thread, at: new Date(now).toISOString(), text: wakeText(messages, now, reason) });
      }
      return { note, woke: byThread.size };
    });
  } catch (error) {
    console.error("hygiene-gate: could not release held messages:", (error as Error).message);
    return null;
  }
}

let chain: Promise<void> = Promise.resolve();

/** Resolves once the sends already started have finished (for draining). */
export const wakesIdle = (): Promise<void> => chain;

/** Sends every due wake once; concurrent calls queue behind each other. */
export function flushWakes(statePath: string, send: WakeSender, now: () => number): Promise<void> {
  const run = chain.then(() => flushOnce(statePath, send, now()));
  chain = run.catch(() => {});
  return run;
}

async function flushOnce(statePath: string, send: WakeSender, now: number): Promise<void> {
  const path = storePath(statePath);
  const due = read(path).wakes.filter((w) => !w.sentAt && !w.failedAt && w.text && (w.nextAttemptAt ?? 0) <= now);
  for (const wake of due) {
    let result: WakeResult;
    try {
      result = await send({ id: wake.id, thread: wake.thread, text: wake.text! });
    } catch (error) {
      console.error("hygiene-gate: wake send threw:", (error as Error).message);
      result = "retry";
    }
    try {
      update(path, (store) => {
        const entry = store.wakes.find((w) => w.id === wake.id);
        if (!entry || entry.sentAt || entry.failedAt) return;
        const at = new Date(now).toISOString();
        if (result === "retry" && now - Date.parse(entry.at) > WAKE_GIVE_UP_MS) result = "failed";
        if (result === "sent") {
          entry.sentAt = at;
          delete entry.text;
        } else if (result === "failed") {
          entry.failedAt = at;
          delete entry.text;
          console.error(`hygiene-gate: gave up waking chat ${entry.thread.slice(0, 8)} (${entry.id})`);
        } else {
          entry.attempts = Math.min((entry.attempts ?? 0) + 1, 7);
          entry.nextAttemptAt = now + Math.min(30_000 * 2 ** (entry.attempts - 1), 30 * 60_000);
        }
      });
    } catch (error) {
      // The same id is retried later; Today drops the duplicate if it went out.
      console.error("hygiene-gate: could not record a wake result:", (error as Error).message);
    }
  }
}

/**
 * Today's own send path: `today-daemon send --from hygiene-gate`, delivered in
 * the script envelope the gate exempts, with a client message id so a resend
 * is a no-op. Exit 3 (id already used differently) and an unknown thread are
 * final; anything else is retried.
 */
export const todayWake: WakeSender = async ({ id, thread, text }) => {
  // No test may ever message a real chat.
  if (process.env.NODE_ENV === "test" || process.env.HYGIENE_GATE_WAKE === "off") return "failed";
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const bin = process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon");
  const child = Bun.spawn(
    [bin, "send", "--socket", `/run/user/${process.getuid!()}/today/daemon.sock`, "--from", "hygiene-gate",
      "--client-message-id", id, thread, "-"],
    { env, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return "sent";
    console.error(`hygiene-gate: wake for ${thread.slice(0, 8)} failed (exit ${code}): ${error.trim().slice(0, 200)}`);
    return code === 3 || /NotFound/.test(error) ? "failed" : "retry";
  } catch (error) {
    console.error("hygiene-gate: wake send failed:", (error as Error).message);
    return "retry";
  } finally {
    clearTimeout(timer);
  }
};

// ---- A photo check in progress ----

const CHECK_MAX_MS = 5 * 60_000;
const checkingPath = (statePath: string) => join(dirname(statePath), "hygiene-checking.json");

/**
 * Marks a photo check for every proxy copy (a handoff runs two), so a message
 * that arrives meanwhile is told the photo is being checked instead of being
 * locked again. The check holds the gate's lock, so there is one at a time.
 */
export async function whileChecking<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const path = checkingPath(statePath);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ pid: process.pid, until: Date.now() + CHECK_MAX_MS }), { mode: 0o600 });
  } catch (error) {
    console.error("hygiene-gate: could not mark a photo check:", (error as Error).message);
  }
  try {
    return await work();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export function photoChecking(statePath: string): boolean {
  try {
    const mark = JSON.parse(readFileSync(checkingPath(statePath), "utf8")) as { pid?: number; until?: number };
    return typeof mark.pid === "number" && typeof mark.until === "number" && mark.until > Date.now() && processAlive(mark.pid);
  } catch {
    return false;
  }
}
