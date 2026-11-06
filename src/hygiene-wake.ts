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
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { processAlive, withLock } from "./filelock";
import { clockLabel, localTime, NOTE_TAG } from "./hygiene";
import { scrubText } from "./scrub.mjs";

/** Codex thread ids are UUIDs; anything else is not a chat Today can wake. */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Today machine name (forge, arch): also the ssh host that reaches it. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const WAKE_ID = /^hygiene-(?:unlock|notice)-\d+-[0-9a-f]{12}$/;

/** This proxy's Today machine name. */
export const localMachine = () => process.env.HYGIENE_GATE_MACHINE?.trim() || hostname();

/**
 * Machines a wake may be sent to over ssh (HYGIENE_GATE_MACHINES, comma list,
 * default arch). Any other origin a follower names is treated as this machine,
 * so a follower cannot point the authority's ssh at an arbitrary host.
 */
export const wakeMachines = () =>
  new Set((process.env.HYGIENE_GATE_MACHINES ?? "arch").split(",").map((m) => m.trim()).filter((m) => MACHINE_NAME.test(m)));

/** The machine to wake a chat on: a listed other machine, or undefined for this one. */
const remoteMachine = (machine: string | undefined, here = localMachine()) =>
  machine && machine !== here && MACHINE_NAME.test(machine) && wakeMachines().has(machine) ? machine : undefined;

export type HeldMessage = {
  /** Codex thread id (prompt_cache_key). */
  thread: string;
  /**
   * The machine whose Codex runs the chat, when a follower proxy asked
   * (hygiene-remote.ts). Absent: this machine.
   */
  machine?: string;
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
  machine?: string;
  at: string;
  /** Dropped once sent; the id and times stay as a receipt. */
  text?: string;
  sentAt?: string;
  failedAt?: string;
  attempts?: number;
  nextAttemptAt?: number;
  /**
   * A photo notice (see addNotice); dropped once sent. Its text lives here, never in
   * `text`: a proxy from before notices treats any due wake with `text` as an unlock
   * wake, refuses the notice id and marks it failed (comb, Nov 5: deploy handoff).
   */
  notice?: Notice;
};

export type NoticeEvent = { kind: "credited" | "rejected"; text: string };
/**
 * `text` is set once, under the store's lock, when the flush first takes the notice: from
 * then on nothing may join it, so every retry sends the same bytes under the same id.
 */
type Notice = { closesAt: number; credited: string[]; rejected: string[]; tail: string; text?: string };

type Store = { held: HeldMessage[]; wakes: Wake[] };

export type WakeResult = "sent" | "retry" | "failed";
export type WakeSender = (wake: { id: string; thread: string; machine?: string; text: string }) => Promise<WakeResult>;

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
  if (!THREAD_ID.test(message.thread) || !message.key || (!message.text && !message.attachments)) return;
  const machine = remoteMachine(message.machine);
  try {
    update(storePath(statePath), (store) => {
      if (store.held.some((h) => h.thread === message.thread && h.key === message.key)) return;
      // The router path reaches the gate unscrubbed; the wake must not carry a secret back out.
      const { machine: _, ...rest } = message;
      store.held.push({ ...rest, ...(machine ? { machine } : {}), text: scrubText(message.text).slice(0, MAX_TEXT) });
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

export function wakeText(messages: HeldMessage[], unlockedAt: number, reason: string, dropped = 0): string {
  return [
    `Hygiene gate unlocked at ${clockLabel(unlockedAt)} (${reason}). While it was armed it held these messages from Alex in this chat and answered them only with its lock text, so nobody has acted on them yet:`,
    ...listing(messages, (t) => t),
    ...(dropped ? [`(${dropped} older message${dropped === 1 ? "" : "s"} dropped: held more than 24 hours.)`] : []),
    "Answer them now, before anything else.",
  ].join("\n");
}

export function heldNoteText(messages: HeldMessage[], dropped = 0): string {
  return [
    `<${NOTE_TAG}>`,
    "Supplied automatically by Alex's hygiene gate; Alex did not type this.",
    "This message unlocked the gate. While it was armed it answered these earlier messages from Alex in this chat with its lock text, so nobody has acted on them yet:",
    ...listing(messages, (t) => t.replace(/</g, "&lt;")),
    ...(dropped ? [`(${dropped} older message${dropped === 1 ? "" : "s"} dropped: held more than 24 hours.)`] : []),
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
): { note: HeldMessage[]; noteDropped: number; woke: number } | null {
  const path = storePath(statePath);
  // Most turns pass a clear gate with nothing held: skip the lock.
  if (!read(path).held.length) return null;
  try {
    return update(path, (store) => {
      const isFresh = (h: HeldMessage) => now - Date.parse(h.at) <= HELD_MAX_AGE_MS;
      const chat = (h: { thread: string; machine?: string }) => `${h.machine ?? ""}/${h.thread}`;
      const dropped = new Map<string, number>();
      for (const h of store.held.filter((h) => !isFresh(h))) dropped.set(chat(h), (dropped.get(chat(h)) ?? 0) + 1);
      const fresh = store.held.filter(isFresh);
      store.held = [];
      store.wakes = store.wakes.filter((w) => !(w.sentAt || w.failedAt) || now - Date.parse(w.at) <= RECEIPT_KEEP_MS);
      // A chat whose held messages all aged out gets no wake; say so in the log.
      for (const [key, count] of dropped)
        if (!fresh.some((h) => chat(h) === key))
          console.error(`hygiene-gate: dropped ${count} held message${count === 1 ? "" : "s"} older than 24 h for chat ${key.slice(0, key.indexOf("/") + 9)}; nothing fresh to wake it for`);
      if (!fresh.length) return null;
      const byChat = new Map<string, HeldMessage[]>();
      for (const h of fresh) byChat.set(chat(h), [...(byChat.get(chat(h)) ?? []), h]);
      // Thread ids are UUIDs, so the current turn's thread names one chat on whichever machine.
      const note: HeldMessage[] = [];
      let noteDropped = 0;
      if (current)
        for (const [key, messages] of byChat)
          if (messages[0].thread === current) {
            note.push(...messages);
            noteDropped += dropped.get(key) ?? 0;
            byChat.delete(key);
          }
      for (const [key, messages] of byChat) {
        const { thread, machine } = messages[0];
        const id = `hygiene-unlock-${now}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
        if (store.wakes.some((w) => w.id === id)) continue;
        store.wakes.push({
          id,
          thread,
          ...(machine ? { machine } : {}),
          at: new Date(now).toISOString(),
          text: wakeText(messages, now, reason, dropped.get(key) ?? 0),
        });
      }
      return { note, noteDropped, woke: byChat.size };
    });
  } catch (error) {
    console.error("hygiene-gate: could not release held messages:", (error as Error).message);
    return null;
  }
}

/** Queue a gate-owner notice with the same retry and deduplication contract as unlock wakes. */
export function enqueueWake(statePath: string, wake: Wake): void {
  if (!THREAD_ID.test(wake.thread) || !WAKE_ID.test(wake.id) || !wake.text)
    throw new Error("invalid gate-owner wake");
  update(storePath(statePath), store => {
    if (!store.wakes.some(w => w.id === wake.id)) store.wakes.push(wake);
  });
}

// ---- Photo notices (Alex, 2026-11-05: "we really need to automatically have the gate send you that") ----

/** Bubble, the chat that keeps Alex's day; HYGIENE_GATE_NOTIFY_THREAD=off turns notices off. */
const BUBBLE = "0b7c3073-04a4-404f-87d1-50e7f6359ba1";
export const noticeThread = (): string | null => {
  const thread = (process.env.HYGIENE_GATE_NOTIFY_THREAD ?? BUBBLE).trim();
  return THREAD_ID.test(thread) ? thread : null;
};
/** Photos within this long of the first one go out as one line. */
export const NOTICE_WINDOW_MS = 2 * 60_000;

export function noticeText(notice: Pick<Notice, "credited" | "rejected" | "tail">): string {
  // Newest first, as Alex reads it ("credited: night teeth 23:16, shower 23:12").
  const parts = [
    ...(notice.credited.length ? [`credited: ${[...notice.credited].reverse().join(", ")}`] : []),
    ...(notice.rejected.length ? [`rejected: ${[...notice.rejected].reverse().join(", ")}`] : []),
    notice.tail,
  ];
  return parts.filter(Boolean).join("; ");
}

/**
 * Adds credits or rejects to the open notice for Bubble, or opens one that
 * goes out NOTICE_WINDOW_MS later. The notice is a wake in this store, so it
 * is sent once under a client message id and retried like an unlock wake;
 * a restart finds it on disk. `tail` is the gate after this photo
 * ("nothing outstanding"); the newest one wins.
 */
export function addNotice(statePath: string, events: NoticeEvent[], tail: string, now: number): void {
  const thread = noticeThread();
  if (!thread || !events.length) return;
  update(storePath(statePath), (store) => {
    store.wakes = store.wakes.filter((w) => !(w.sentAt || w.failedAt) || now - Date.parse(w.at) <= RECEIPT_KEEP_MS);
    let wake = store.wakes.find(
      (w) => w.notice && w.notice.text === undefined && w.thread === thread && !w.sentAt && !w.failedAt && now < w.notice.closesAt,
    );
    if (!wake) {
      const closesAt = now + NOTICE_WINDOW_MS;
      const idFor = (n: number) => `hygiene-notice-${now}-${createHash("sha256").update(`${thread}/${now}/${n}`).digest("hex").slice(0, 12)}`;
      let n = 0;
      while (store.wakes.some((w) => w.id === idFor(n))) n++;
      const id = idFor(n);
      wake = { id, thread, at: new Date(now).toISOString(), nextAttemptAt: closesAt, notice: { closesAt, credited: [], rejected: [], tail } };
      store.wakes.push(wake);
    }
    const notice = wake.notice!;
    for (const event of events) notice[event.kind].push(event.text.slice(0, 160));
    notice.tail = tail;
  });
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
  const isDue = (w: Wake) => !w.sentAt && !w.failedAt && (!!w.text || !!w.notice) && (w.nextAttemptAt ?? 0) <= now;
  const due = read(path).wakes.filter(isDue).map((w) => w.id);
  for (const id of due) {
    // Read again just before sending: an earlier send may have taken seconds.
    let entry = read(path).wakes.find((w) => w.id === id);
    if (!entry || !isDue(entry)) continue;
    if (entry.notice && entry.notice.text === undefined) {
      // Seal a notice under the lock, so an event that arrives late opens a new notice
      // instead of changing this one's text after it went out. Only a notice pays for this
      // write: an unlock wake goes out even when the store can't be written.
      try {
        entry = update(path, (store) => {
          const fresh = store.wakes.find((w) => w.id === id);
          if (!fresh || !isDue(fresh) || !fresh.notice) return undefined;
          fresh.notice.text ??= noticeText(fresh.notice).slice(0, MAX_TEXT);
          return structuredClone(fresh);
        });
      } catch (error) {
        console.error("hygiene-gate: could not seal a photo notice; retrying later:", (error as Error).message);
        continue;
      }
      if (!entry) continue;
    }
    const text = entry.notice ? entry.notice.text : entry.text;
    const wake = text ? { id: entry.id, thread: entry.thread, ...(entry.machine ? { machine: entry.machine } : {}), text } : undefined;
    if (!wake) continue;
    const sending = wake;
    let result: WakeResult;
    try {
      result = await send(sending);
    } catch (error) {
      console.error("hygiene-gate: wake send threw:", (error as Error).message);
      result = "retry";
    }
    try {
      update(path, (store) => {
        const entry = store.wakes.find((w) => w.id === sending.id);
        if (!entry || entry.sentAt || entry.failedAt) return;
        const at = new Date(now).toISOString();
        if (result === "retry" && now - Date.parse(entry.at) > WAKE_GIVE_UP_MS) result = "failed";
        if (result === "sent") {
          entry.sentAt = at;
          delete entry.text;
          delete entry.notice;
        } else if (result === "failed") {
          entry.failedAt = at;
          delete entry.text;
          delete entry.notice;
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
 * The command that wakes one chat: Today's own `today-daemon send --from
 * hygiene-gate` (delivered in the script envelope the gate exempts) with a
 * client message id, so a resend is a no-op. A chat on another machine (a
 * follower's) is unknown to this daemon, so the same command runs on that
 * machine's daemon over ssh. Null when an argument fails validation; every
 * value that reaches the remote shell is checked against a strict pattern.
 */
export function wakeCommand(wake: { id: string; thread: string; machine?: string }, here = localMachine()): string[] | null {
  if (!THREAD_ID.test(wake.thread) || !WAKE_ID.test(wake.id)) return null;
  if (wake.machine && !MACHINE_NAME.test(wake.machine)) return null;
  const machine = remoteMachine(wake.machine, here);
  if (!machine)
    return [
      process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon"),
      "send", "--socket", `/run/user/${process.getuid!()}/today/daemon.sock`, "--from", "hygiene-gate",
      "--client-message-id", wake.id, "--", wake.thread, "-",
    ];
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", machine,
    `exec env -u CODEX_THREAD_ID "$HOME/.local/bin/today-daemon" send --socket "/run/user/$(id -u)/today/daemon.sock" --from hygiene-gate --client-message-id ${wake.id} -- ${wake.thread} -`,
  ];
}

/** Exit 3 (id already used differently) and an unknown thread are final; anything else is retried. */
export const todayWake: WakeSender = async (wake) => {
  // No test may ever message a real chat.
  if (process.env.NODE_ENV === "test" || process.env.HYGIENE_GATE_WAKE === "off") return "failed";
  const { thread, text } = wake;
  const argv = wakeCommand(wake);
  if (!argv) {
    console.error(`hygiene-gate: refused to wake an invalid chat or machine (${wake.id})`);
    return "failed";
  }
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn(argv, { env, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), wake.machine ? 20_000 : 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return "sent";
    console.error(`hygiene-gate: wake for ${thread.slice(0, 8)}${wake.machine ? ` on ${wake.machine}` : ""} failed (exit ${code}): ${error.trim().slice(0, 200)}`);
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
