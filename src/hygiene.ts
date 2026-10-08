/**
 * Hygiene gate: the pure half. Time windows, requirement bookkeeping, turn
 * classification and every user-visible string live here so they can be
 * tested with an injected clock. Persistence, hashing and the vision call
 * live in hygiene-gate.ts and hygiene-proof.ts.
 *
 * Daily rules (America/Vancouver):
 * - Morning teeth arms at 05:00; the first gated turn after it is locked
 *   until a teeth photo passes.
 * - Night teeth (taken at or after 17:00) and a shower (any time that day)
 *   are due by midnight. If either is missing at 00:00 the gate locks until
 *   it is supplied. That overdue lock is separate from the next morning's
 *   teeth requirement: one photo fills one requirement.
 * - BYPASS opens the gate for an hour and opens a debt, which the model
 *   rules on and may turn into a penance photo requirement.
 */
import { createHash } from "node:crypto";
import type { ResponseContentPart, ResponseInputItem, ResponsesRequest } from "./types";

export const TIME_ZONE = "America/Vancouver";
export const MORNING_MINUTE = 5 * 60;
export const NIGHT_TEETH_MINUTE = 17 * 60;
export const BYPASS_MS = 60 * 60 * 1000;
export const DELAY_MS = 2 * 60 * 60 * 1000;
/** DELAY is accepted from 05:00 until noon. */
export const DELAY_END_MINUTE = 12 * 60;
export const EXIF_MAX_AGE_MS = 30 * 60 * 1000;
/** Phone clocks drift; a capture time slightly in the future is not suspicious. */
export const EXIF_FUTURE_SLACK_MS = 10 * 60 * 1000;
/**
 * dHash bits (of 256) within which a photo counts as a copy of an earlier
 * accepted proof. Measured 2026-10-07 on 30 of Alex's photos: re-encoded or
 * resized copies landed 0-9 bits away (a few heavy edits 11-20); consecutive
 * burst frames, the closest a genuinely new photo gets, landed 10 or more.
 */
export const NEAR_DUPLICATE_BITS = 10;
export const MIN_CONFIDENCE = 0.6;

export type ProofKind = "teeth" | "shower" | "penance";
export type ClassifiedKind = ProofKind | "none";

export type ImageVerdict =
  /** Passed and filled `slot`. */
  | "accepted"
  /** A genuine proof photo, but nothing was due that it could fill. */
  | "unneeded"
  | "duplicate"
  | "stale"
  /** Classified as something not currently needed, or not confident enough. */
  | "rejected";

/** What the gate indexes about an image. Accepted photos are also saved; see `file`. */
export type ImageRecord = {
  sha256: string;
  /** 256-bit difference hash as hex, or null when the image could not be decoded. */
  dhash: string | null;
  at: string;
  /** The message the image arrived in; a replay of that message reuses this record. */
  source: { thread: string; key: string };
  kind: ClassifiedKind | null;
  verdict: ImageVerdict;
  slot?: string;
  reason?: string;
  /**
   * Seeded by hand (verified outside the gate). Blocks reuse of the photo but
   * never rewrites the history it already appeared in.
   */
  manual?: { verifier: string };
  /** Where an accepted photo was saved (original bytes, EXIF intact). */
  file?: string;
  /** The gate was locked (and not bypassed) when this photo was checked. */
  locked?: boolean;
};

export type Debt = {
  id: string;
  at: string;
  /** What the bypass skipped, as labels. */
  skipped: string[];
  status: "open" | "justified" | "penance" | "paid";
  reason?: string;
  ruledAt?: string;
  penance?: { description: string; setAt: string; paidAt?: string };
};

export type HiddenNote = { thread: string; key: string; debtId: string; text: string };

export type GateState = {
  version: 1;
  /** Requirements whose arm moment precedes this instant are never enforced. */
  startsAt: string;
  images: ImageRecord[];
  /** Requirement slot -> ISO time it was filled. */
  filled: Record<string, string>;
  bypass: { count: number; until: string | null; history: string[] };
  /** DELAY: one 2-hour postponement of the morning teeth photo per morning. */
  delay: { count: number; until: string | null; day: string | null; history: string[] };
  debts: Debt[];
  notes: HiddenNote[];
  /**
   * Extra turn triggers to gate, for live verification with `codex exec`
   * (normally exempt). Leave empty in normal use.
   */
  extraGatedTriggers: string[];
};

export function emptyState(startsAt: string): GateState {
  return {
    version: 1,
    startsAt,
    images: [],
    filled: {},
    bypass: { count: 0, until: null, history: [] },
    delay: { count: 0, until: null, day: null, history: [] },
    debts: [],
    notes: [],
    extraGatedTriggers: [],
  };
}

// ---- Time ----

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallClock(ms: number) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Local calendar day ("YYYY-MM-DD") and minutes since local midnight. */
export function localTime(ms: number): { day: string; minutes: number } {
  const w = wallClock(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${w.year}-${pad(w.month)}-${pad(w.day)}`, minutes: w.hour * 60 + w.minute };
}

function wallClockAsUtc(ms: number): number {
  const w = wallClock(ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** The instant a local wall-clock time occurs (DST-safe to the minute). */
export function zonedTime(day: string, minutes: number): number {
  const [year, month, date] = day.split("-").map(Number);
  const target = Date.UTC(year, month - 1, date, 0, minutes);
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - wallClockAsUtc(guess);
  return guess;
}

export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

export function clockLabel(ms: number): string {
  const { minutes } = localTime(ms);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

// ---- Requirements ----

export type Requirement = {
  slot: string;
  kind: ProofKind;
  label: string;
  /** Penance only: what the photo must show. */
  description?: string;
};

const slot = {
  morning: (day: string) => `${day}/morning-teeth`,
  night: (day: string) => `${day}/night-teeth`,
  shower: (day: string) => `${day}/shower`,
  penance: (id: string) => `penance/${id}`,
};

/** The instant a slot starts to lock the gate. */
function armMs(slotName: string): number {
  const [day, name] = slotName.split("/");
  if (name === "morning-teeth") return zonedTime(day, MORNING_MINUTE);
  return zonedTime(addDays(day, 1), 0);
}

const enforced = (state: GateState, slotName: string) =>
  armMs(slotName) >= Date.parse(state.startsAt);

export const bypassActive = (state: GateState, now: number) =>
  state.bypass.until !== null && Date.parse(state.bypass.until) > now;

/** A DELAY window is open and the morning photo it postponed is still missing. */
export function delayActive(state: GateState, now: number): boolean {
  const { day } = localTime(now);
  return (
    state.delay.until !== null &&
    state.delay.day === day &&
    Date.parse(state.delay.until) > now &&
    !state.filled[slot.morning(day)]
  );
}

/** Requirements that lock the gate right now (ignoring any bypass). */
export function outstanding(state: GateState, now: number): Requirement[] {
  const { day, minutes } = localTime(now);
  const yesterday = addDays(day, -1);
  const overdue = ` (overdue from ${dayLabel(yesterday)})`;
  const result: Requirement[] = [];
  const add = (name: string, kind: ProofKind, label: string) => {
    if (enforced(state, name) && !state.filled[name]) result.push({ slot: name, kind, label });
  };
  add(slot.shower(yesterday), "shower", `shower photo${overdue}`);
  add(slot.night(yesterday), "teeth", `night teeth photo${overdue}`);
  if (minutes >= MORNING_MINUTE && !delayActive(state, now))
    add(slot.morning(day), "teeth", "morning teeth photo");
  for (const debt of openPenance(state))
    result.push({
      slot: slot.penance(debt.id),
      kind: "penance",
      label: `penance photo: ${debt.penance!.description}`,
      description: debt.penance!.description,
    });
  return result;
}

/** Requirements due later today that do not lock yet. */
export function dueToday(state: GateState, now: number): Requirement[] {
  const { day, minutes } = localTime(now);
  const result: Requirement[] = [];
  if (!state.filled[slot.shower(day)])
    result.push({ slot: slot.shower(day), kind: "shower", label: "shower photo (before midnight)" });
  if (!state.filled[slot.night(day)])
    result.push({
      slot: slot.night(day),
      kind: "teeth",
      label:
        minutes >= NIGHT_TEETH_MINUTE
          ? "night teeth photo (before midnight)"
          : "night teeth photo (17:00 to midnight)",
    });
  if (minutes < MORNING_MINUTE && !state.filled[slot.morning(day)] && enforced(state, slot.morning(day)))
    result.push({ slot: slot.morning(day), kind: "teeth", label: "morning teeth photo (from 05:00)" });
  return result;
}

export function openPenance(state: GateState): Debt[] {
  return state.debts.filter((d) => d.status === "penance" && d.penance && !d.penance.paidAt);
}

/**
 * Slots a photo of `kind` taken now could fill, best first: overdue
 * requirements, then this morning, then tonight's.
 */
export function candidateSlots(state: GateState, kind: ProofKind, now: number): string[] {
  const { day, minutes } = localTime(now);
  const yesterday = addDays(day, -1);
  const open = (name: string) => !state.filled[name];
  if (kind === "penance") return openPenance(state).map((d) => slot.penance(d.id));
  if (kind === "shower") {
    const result: string[] = [];
    if (open(slot.shower(yesterday)) && enforced(state, slot.shower(yesterday)))
      result.push(slot.shower(yesterday));
    if (open(slot.shower(day))) result.push(slot.shower(day));
    return result;
  }
  const result: string[] = [];
  if (open(slot.night(yesterday)) && enforced(state, slot.night(yesterday)))
    result.push(slot.night(yesterday));
  if (minutes >= MORNING_MINUTE && open(slot.morning(day))) result.push(slot.morning(day));
  if (minutes >= NIGHT_TEETH_MINUTE && open(slot.night(day))) result.push(slot.night(day));
  return result;
}

/** Proof kinds worth asking the classifier about right now. */
export function wantedKinds(state: GateState, now: number): ProofKind[] {
  return (["teeth", "shower", "penance"] as const).filter(
    (kind) => candidateSlots(state, kind, now).length > 0,
  );
}

export function slotLabel(name: string, state?: GateState): string {
  if (name.startsWith("penance/")) {
    const debt = state?.debts.find((d) => `penance/${d.id}` === name);
    return debt?.penance ? `penance (${debt.penance.description})` : "penance";
  }
  const [day, kind] = name.split("/");
  const what = kind === "morning-teeth" ? "morning teeth" : kind === "night-teeth" ? "night teeth" : "shower";
  return `${what} (${dayLabel(day)})`;
}

// ---- Activity for the Today chat ----

/** One gate outcome for the plate-activity block. `key` is stable across reads. */
export type GateEvent = { key: string; at: string; text: string };

/**
 * A failed photo worth telling the Today chat about: one Alex meant as a
 * proof. Every chat image is checked while anything is due later that day,
 * so an Amazon screenshot is "rejected" too; reporting that reads as a failed
 * check. Intent counts when the photo came through Cairn's proof flow, when
 * the classifier saw teeth, a shower or a penance in it, or when the gate was
 * locked so any photo was a try at unlocking it. Otherwise: silence.
 */
export function attemptedProof(r: ImageRecord): boolean {
  return r.source.thread === "cairn" || (!!r.kind && r.kind !== "none") || r.locked === true;
}

/**
 * What the gate decided in (since, until], oldest first: which check, the
 * outcome, and when. Rejections only for attempted proofs (`attemptedProof`).
 * Never image bytes, file paths or the classifier's own description of the
 * photo, which can describe Alex in the shower.
 */
export function gateEvents(state: GateState, since: number, until: number): GateEvent[] {
  const within = (at: number) => at > since && at <= until;
  const out: GateEvent[] = [];
  for (const r of state.images) {
    // Hand-seeded records were verified outside the gate; nothing happened now.
    if (r.manual || !within(Date.parse(r.at))) continue;
    const passed = r.verdict === "accepted" || r.verdict === "unneeded";
    if (!passed && !attemptedProof(r)) continue;
    const what = r.kind && r.kind !== "none" ? `${r.kind} photo` : "photo";
    const text =
      r.verdict === "accepted"
        ? `${r.slot ? slotLabel(r.slot, state) : what} accepted`
        : r.verdict === "unneeded"
          ? `${what} accepted, though nothing was due`
          : r.verdict === "duplicate"
            ? `${what} rejected (copy of an earlier proof)`
            : r.verdict === "stale"
              ? `${what} rejected (camera timestamp too old)`
              : r.kind && r.kind !== "none"
                ? `${what} rejected (not due, or not clear enough)`
                : "photo rejected (no hygiene proof seen)";
    out.push({ key: `image:${r.sha256}:${r.at}`, at: r.at, text });
  }
  for (const at of state.bypass.history) {
    if (!within(Date.parse(at))) continue;
    const skipped = state.debts.find((d) => d.at === at)?.skipped ?? [];
    out.push({
      key: `bypass:${at}`,
      at,
      text: `BYPASS${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`,
    });
  }
  // Only the latest DELAY keeps a time; there is one per morning, so each is read before the next.
  if (state.delay.until) {
    const ends = Date.parse(state.delay.until);
    const at = ends - DELAY_MS;
    if (within(at))
      out.push({
        key: `delay:${state.delay.until}`,
        at: new Date(at).toISOString(),
        text: `DELAY (morning teeth postponed until ${clockLabel(ends)})`,
      });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ---- Turn classification ----

/**
 * Turn triggers Codex Desktop sets for turns no human typed. Read from the
 * request body's `client_metadata["x-codex-turn-metadata"].turn_trigger`
 * (Desktop 26.9xx; values from its app bundle). Anything else, including a
 * trigger never seen before, is treated as possibly human.
 */
const EXEMPT_TRIGGERS = new Set([
  "exec",
  "app_tool_create_thread",
  "app_tool_send_message",
  "code_review",
  "codex_replay",
  "resume_interrupted_task",
  "app_update_resume",
  "ambient_suggestion_task",
  "security_scan",
  "security_remediation",
  "visualization_repair",
  "visualization_sites_handoff",
  "environment_setup_retry",
  "environment_onboarding",
  "local_environment_configuration",
  "conversational_onboarding",
  "aeon_onboarding",
  "onboarding_checklist",
  "plugin_onboarding",
  "plugin_suggestion_connected",
  "plugin_suggestion_declined",
  "thread_handoff",
  "artifact_creation",
  "slides_outline",
  "pull_request_fix_setup",
  "page_agent_task",
  "page_task_mention_resume",
  "send_user_message_async_question",
]);
/** Heartbeats (`automation_heartbeat_*`), cron and one-shot schedules (`automation_cron_*`). */
const EXEMPT_TRIGGER_PREFIXES = ["automation_"];
/** Thread sources whose turns are always agent-driven. */
const EXEMPT_THREAD_SOURCES = new Set(["subagent", "memory_consolidation"]);

/**
 * Message openings Codex or other agents write in the user role. Mirrors
 * plate-activity's list plus wrappers for heartbeats, delegated prompts and
 * skills, as a fallback when turn metadata is missing.
 */
const SYNTHETIC_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<permissions instructions>",
  "<external_codex_apps_open_page>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<user_shell_command>",
  "<developer>",
  "<heartbeat>",
  "<codex_delegation>",
  "<skill>",
  "<hygiene-gate-note",
];

export type TurnMetadata = {
  requestKind?: string;
  threadSource?: string;
  turnTrigger?: string;
  turnId?: string;
};

export function turnMetadata(request: ResponsesRequest): TurnMetadata {
  const raw = (request as { client_metadata?: Record<string, unknown> }).client_metadata?.[
    "x-codex-turn-metadata"
  ];
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {}
  } else if (raw && typeof raw === "object") parsed = raw as Record<string, unknown>;
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
  return {
    requestKind: text("request_kind"),
    threadSource: text("thread_source"),
    turnTrigger: text("turn_trigger"),
    turnId: text("turn_id"),
  };
}

export const partsOf = (item: ResponseInputItem): ResponseContentPart[] =>
  typeof item.content === "string"
    ? [{ type: "input_text", text: item.content }]
    : Array.isArray(item.content)
      ? item.content
      : [];

const isUserMessage = (item: ResponseInputItem) =>
  item?.role === "user" && (item.type === undefined || item.type === "message");
const isContextMessage = (item: ResponseInputItem) =>
  (item?.role === "developer" || item?.role === "system") &&
  (item.type === undefined || item.type === "message");

export function isSyntheticUserMessage(item: ResponseInputItem): boolean {
  const texts = partsOf(item).map((part) =>
    typeof part.text === "string" ? part.text.trimStart() : null,
  );
  return (
    texts.length > 0 &&
    texts.every((text) => text !== null && SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix)))
  );
}

export type TurnImage = { item: number; part: number; url: string };

export type TurnClass =
  | { type: "exempt"; reason: string }
  /** Mid-turn request (tool results etc.): the turn was already let through. */
  | { type: "continuation" }
  | {
      type: "human";
      /** Index of the newest human message: hidden notes attach here. */
      newest: number;
      /** What Alex typed, with Codex's attachment wrappers removed. */
      text: string;
      images: TurnImage[];
    };

/** Text Codex wraps around attachments or ambient UI state, not typed by Alex. */
function typedText(part: string): string {
  const text = part.trim();
  if (text.startsWith("# Files mentioned by the user")) return "";
  if (/^<image\b[^>]*>$/s.test(text) || text === "</image>") return "";
  return text
    .replace(/<(in-app-browser-context|plate-activity|hygiene-gate-note)\b[\s\S]*?<\/\1>/g, "")
    .trim();
}

/**
 * Decides whether this request starts a turn Alex typed.
 *
 * Exempt: compaction, non-turn request kinds, sub-agent threads, and turn
 * triggers from automations, heartbeats, scheduled tasks, agent messages
 * and other app-initiated work. Otherwise the turn is human when the user
 * messages after the last model output include one that is not a Codex
 * wrapper. A request whose input ends in model output or tool results is a
 * continuation of a turn that was already let through.
 */
export function classifyTurn(request: ResponsesRequest, extraGatedTriggers: string[] = []): TurnClass {
  if (!Array.isArray(request.input)) return { type: "exempt", reason: "string input" };
  const input = request.input;
  if (input.at(-1)?.type === "compaction_trigger") return { type: "exempt", reason: "compaction" };
  const meta = turnMetadata(request);
  if (meta.requestKind && meta.requestKind !== "turn")
    return { type: "exempt", reason: `request kind ${meta.requestKind}` };
  if (meta.threadSource && EXEMPT_THREAD_SOURCES.has(meta.threadSource))
    return { type: "exempt", reason: `thread source ${meta.threadSource}` };
  const trigger = meta.turnTrigger;
  if (
    trigger &&
    !extraGatedTriggers.includes(trigger) &&
    (EXEMPT_TRIGGERS.has(trigger) || EXEMPT_TRIGGER_PREFIXES.some((p) => trigger.startsWith(p)))
  )
    return { type: "exempt", reason: `trigger ${trigger}` };

  // The turn's own input: user and context messages after the last thing the
  // model produced.
  const turnUsers: number[] = [];
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (isUserMessage(item)) turnUsers.unshift(index);
    else if (isContextMessage(item)) continue;
    else break;
  }
  const human = turnUsers.filter((index) => !isSyntheticUserMessage(input[index]));
  if (!human.length)
    return turnUsers.length ? { type: "exempt", reason: "no human-written message" } : { type: "continuation" };
  const texts: string[] = [];
  const images: TurnImage[] = [];
  for (const index of human) {
    partsOf(input[index]).forEach((part, partIndex) => {
      if (part.type === "input_image" && typeof part.image_url === "string")
        images.push({ item: index, part: partIndex, url: part.image_url });
      else if (typeof part.text === "string") {
        const typed = typedText(part.text);
        if (typed) texts.push(typed);
      }
    });
  }
  return { type: "human", newest: human.at(-1)!, text: texts.join("\n").trim(), images };
}

// ---- Message keys (byte-stable note placement) ----

export const NOTE_TAG = "hygiene-gate-note";
const isNotePart = (part: ResponseContentPart) =>
  typeof part?.text === "string" && part.text.startsWith(`<${NOTE_TAG}`);

const baseHash = (item: ResponseInputItem) =>
  createHash("sha256")
    .update(JSON.stringify(partsOf(item).filter((part) => !isNotePart(part))))
    .digest("hex");

/**
 * Stable key for every user message: its content (minus our note) plus how
 * many earlier user messages had identical content. Same scheme as
 * plate-activity, so a replayed history yields the same keys.
 */
export function messageKeys(input: ResponseInputItem[]): Map<number, string> {
  const seen = new Map<string, number>();
  const keys = new Map<number, string>();
  input.forEach((item, index) => {
    if (!isUserMessage(item)) return;
    const hash = baseHash(item);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    keys.set(index, `${hash}:${occurrence}`);
  });
  return keys;
}

export const hasNote = (item: ResponseInputItem) => partsOf(item).some(isNotePart);

// ---- Rendering ----

const EMOJI: Record<ProofKind, string> = { teeth: "🪥", shower: "🚿", penance: "⚖️" };

export function lockedText(requirements: Requirement[], results: string[] = []): string {
  return [
    ...results,
    `${EMOJI[requirements[0].kind]} gate armed: ${requirements.map((r) => r.label).join(", ")}`,
    "Send a fresh photo to unlock, or reply BYPASS.",
  ].join("\n");
}

export function imageMarker(record: ImageRecord, state?: GateState): string {
  const what =
    record.verdict === "accepted" && record.slot
      ? `accepted as ${slotLabel(record.slot, state)} proof`
      : record.verdict === "unneeded"
        ? `checked as a ${record.kind} photo (nothing was due)`
        : `rejected as a hygiene proof (${record.verdict})`;
  return `[hygiene-gate: photo ${what}; image withheld]`;
}

/** Photos of Alex in the bathroom never reach the working model. */
export const isWithheld = (record: ImageRecord) =>
  !record.manual &&
  (record.verdict === "duplicate" || (record.kind !== null && record.kind !== "none"));

export function noteText(debt: Debt, baseUrl: string): string {
  const at = Date.parse(debt.at);
  const endpoint = `${baseUrl}/hygiene/debt/${debt.id}/resolve`;
  return [
    `<${NOTE_TAG}>`,
    "Supplied automatically by Alex's hygiene gate; Alex did not type this.",
    `At ${clockLabel(at)} on ${dayLabel(localTime(at).day)} Alex replied BYPASS to skip: ${debt.skipped.join(", ")}.`,
    "Ask him briefly why the bypass was necessary and judge the answer honestly. Keep helping with his request meanwhile.",
    "Once he answers, record your ruling with exactly one call:",
    `- justified: curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '{"verdict":"justified","reason":"<one line>"}'`,
    `- unjustified: curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '{"verdict":"unjustified","reason":"<one line>","penance":"<a short, safe, doable photo task, e.g. photo of you on a walk outside>"}'`,
    "An unjustified ruling locks the gate until Alex sends the penance photo.",
    `</${NOTE_TAG}>`,
  ].join("\n");
}

export const isDelayText = (text: string) => text.trim().toUpperCase() === "DELAY";

/** Rides on each of Alex's messages while a DELAY window is open. */
export function delayNoteText(until: number): string {
  return [
    `<${NOTE_TAG}>`,
    "Supplied automatically by Alex's hygiene gate; Alex did not type this.",
    `Alex used DELAY to postpone his morning teeth photo until ${clockLabel(until)}.`,
    "End your final reply to this message with one short line asking him to send the teeth photo.",
    `</${NOTE_TAG}>`,
  ].join("\n");
}
