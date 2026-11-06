/**
 * Hygiene gate: state, decisions and HTTP routes. See hygiene.ts for the
 * rules and README "Hygiene gate" for the operator view.
 *
 * One process owns the state: this proxy, or the proxy it follows when
 * HYGIENE_GATE_REMOTE is set (hygiene-remote.ts). The Codex model router asks it
 * about GPT turns through POST /hygiene/gate; Claude turns are gated inline
 * in /v1/responses. Decisions for new human turns are serialized so two
 * chats cannot spend the same photo or bypass.
 */
import { createHash } from "node:crypto";
import { readFixStatus, type FixRef } from "./hygiene-fix";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  passThrough,
  remoteGate,
  remoteGateRequest,
  deliverForOutage,
  preserveDelivered,
  wasDelivered,
  fetchRemoteState,
  rememberVerdicts,
} from "./hygiene-remote";
import {
  itemKey,
  RECURRING_ITEMS,
  BYPASS_MS,
  DELAY_END_MINUTE,
  DELAY_MS,
  EXIF_FUTURE_SLACK_MS,
  EXIF_MAX_AGE_MS,
  MIN_CONFIDENCE,
  MORNING_MINUTE,
  NEAR_DUPLICATE_BITS,
  addDays,
  bypassActive,
  candidateSlots,
  classifyTurn,
  clockLabel,
  attemptedProof,
  delayActive,
  delayNoteText,
  dueToday,
  emptyState,
  hasNote,
  imageMarker,
  isDelayText,
  isWithheld,
  localTime,
  lockedText,
  messageKeys,
  noteText,
  onlyMorningDue,
  outstanding,
  partsOf,
  slotLabel,
  wantedKinds,
  walkStartedAt,
  WALK_MS,
  zonedTime,
  canonicalZone,
  knownZone,
  setZoneHistory,
  zoneAt,
  TIME_ZONE,
  MAX_MOVES_PER_DAY,
  allMoves,
  chargeBrokenMoves,
  movableSlots,
  moveSlots,
  movesToday,
  parseMoveText,
  resolveMoveTime,
  supersedeMoveDebts,
  type MoveCommand,
  type SlotMove,
  type Debt,
  type GateState,
  type ImageRecord,
  type ProofKind,
  type ZoneChange,
} from "./hygiene";
import {
  archivePhoto,
  captureTime,
  gpsFix,
  stripGps,
  claudeClassifier,
  decodeDataUrl,
  dhash,
  hammingDistance,
  parseWeightReading,
  penanceProofKinds,
  sha256,
  type Classifier,
} from "./hygiene-proof";
import { tryLock, unlock } from "./filelock";
import {
  checkSession,
  stampPlanSettings,
  editPlan,
  emptyGym,
  evaluateGym,
  distanceM,
  gymPhotoWanted,
  recordGymPhoto,
  addPause,
  endPause,
  gymSettings,
  reschedulePlan,
  when as vancouverLabel,
  type GymPlan,
  type GymState,
  type PlanEdit,
} from "./gym";
import { refreshIfDeciding, startGymSync, syncGym, upliftingToken, type GymSyncHost } from "./gym-sync";
import { parseStart } from "./gym-client";
import {
  addNotice,
  enqueueWake,
  flushWakes as flushWakeQueue,
  heldNoteText,
  holdMessage,
  photoChecking,
  releaseHeld,
  todayWake,
  wakesIdle,
  whileChecking,
  type NoticeEvent,
  type WakeSender,
} from "./hygiene-wake";
import { relaySender, startPhoneWake, wakeFilePath, type PhoneWakeSender } from "./phone-wake";
import { ensurePhrase, isBareBypass, isBypassAttempt, matchesPhrase, randomWords, retire } from "./bypass-phrase";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

export type GateDeps = {
  fixStatus: typeof readFixStatus;
  now: () => number;
  classify: Classifier;
  dhash: (bytes: Buffer) => Promise<string | null>;
  captureTime: (bytes: Buffer) => Promise<number | null>;
  /** EXIF GPS of a photo, for gym photos. */
  gpsFix: (bytes: Buffer) => Promise<{ lat: number; lon: number } | null>;
  /** A photo without its location tags, for the keepsake; null when that can't be guaranteed. */
  stripGps: typeof stripGps;
  /** Saves an accepted photo and returns its path. */
  archive: typeof archivePhoto;
  /** Base URL the model uses for the ruling endpoint. */
  baseUrl: string;
  /** Starts a turn in a chat whose messages the gate held (hygiene-wake.ts). */
  wake: WakeSender;
  /** Longest a human turn waits for a fresh Uplifting read before deciding (gym-sync.ts). */
  gymRefreshMs: number;
  /** Three fresh BYPASS words for a new lock (bypass-phrase.ts). */
  bypassWords: () => string;
};

const defaults: GateDeps = {
  fixStatus: readFixStatus,
  now: () => Date.now(),
  classify: claudeClassifier,
  dhash,
  captureTime,
  gpsFix,
  stripGps,
  archive: archivePhoto,
  baseUrl: `http://127.0.0.1:${process.env.PORT ?? 3456}`,
  wake: todayWake,
  gymRefreshMs: 5_000,
  bypassWords: () => randomWords(),
};
let deps: GateDeps = { ...defaults };

/** For tests: swap the clock, classifier or hashers. */
export function setGateDeps(overrides: Partial<GateDeps>): void {
  deps = { ...defaults, ...overrides };
  unqueued = [];
}

// ---- Files ----

/** Terminal escape hatch: when this file exists the gate does nothing at all. */
export function killSwitchPath(): string {
  return (
    process.env.HYGIENE_GATE_DISABLED_FILE ??
    join(import.meta.dir, "..", "hygiene-gate", "disabled")
  );
}

export const gateDisabled = () => existsSync(killSwitchPath());

export function statePath(): string {
  return process.env.HYGIENE_GATE_STATE ?? join(stateDir(), "hygiene-gate.json");
}

/** First arm for a fresh state file: the next 05:00. */
function defaultStartsAt(now: number): string {
  const { day, minutes } = localTime(now);
  const morning = zonedTime(minutes < MORNING_MINUTE ? day : addDays(day, 1), MORNING_MINUTE);
  return new Date(morning).toISOString();
}

let cache: { path: string; mtimeMs: number; state: GateState } | null = null;

/** Re-read when the file changes, so a hand edit (e.g. startsAt) applies without a restart. */
export function loadState(): GateState {
  const path = statePath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {}
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
    setZoneHistory(cache.state.zones);
    return repairView(cache.state);
  }
  let state: GateState;
  if (mtimeMs < 0) state = emptyState(defaultStartsAt(deps.now()));
  else {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateState>;
    if (!raw || typeof raw !== "object") throw new Error("state file is not a JSON object");
    state = { ...emptyState(raw.startsAt ?? defaultStartsAt(deps.now())), ...raw } as GateState;
  }
  // Older plans get the proof mode and tag they were made under (gym.ts stampPlanSettings).
  stampPlanSettings(state.gym);
  // 2583b55 marked a credited penance photo `manual`, which un-withholds it from chats.
  // Move such records to `credited` (comb of 2583b55, Nov 4).
  for (const r of state.images) {
    const m = r.manual && /\[credited for the penance at (\S+) by (.+?): (.*)\]$/.exec(r.reason ?? "");
    if (!m) continue;
    r.credited = { by: m[2], reason: m[3], at: m[1] };
    delete r.manual;
  }
  cache = { path, mtimeMs, state };
  setZoneHistory(state.zones);
  return repairView(state);
}

// Read closure on every decision; the retry timer persists it without delaying a newly repaired gate.
function repairView(state: GateState): GateState {
  if (!state.suspensions?.some(s => !s.resolvedAt)) return state;
  const view = structuredClone(state);
  for (const s of view.suspensions ?? []) {
    if (!s.resolvedAt) {
      s.repairStatus = deps.fixStatus(s.fixRef);
      if (s.repairStatus === "closed") s.resolvedAt = new Date(deps.now()).toISOString();
    }
  }
  return view;
}

const RETAIN_MS = 400 * 86_400_000;

function saveState(state: GateState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cutoff = deps.now() - RETAIN_MS;
  state.images = state.images.filter((image) => Date.parse(image.at) >= cutoff);
  state.bypass.history = state.bypass.history.filter((at) => Date.parse(at) >= cutoff);
  if (state.moves) state.moves = state.moves.filter((m) => Date.parse(m.at) >= cutoff);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  cache = { path, mtimeMs: statSync(path).mtimeMs, state };
  setZoneHistory(state.zones);
  sendNotices(state);
}

/**
 * Photo verdicts waiting for their state to be saved. Keyed by the state
 * object, so Bubble hears of a credit only once it is on disk, and a decision
 * that throws before saving leaves nothing behind.
 */
const pendingNotices = new WeakMap<GateState, NoticeEvent[]>();
/**
 * Saved verdicts whose notice could not be queued (the store's lock was busy
 * or the disk failed); tried again before the next notice or flush. Lost on a
 * restart: a credit is never held back for its notice.
 */
let unqueued: Array<{ events: NoticeEvent[]; tail: string }> = [];
const UNQUEUED_MAX = 50;

function queueNotices(now: number): void {
  while (unqueued.length) {
    const { events, tail } = unqueued[0];
    addNotice(statePath(), events, tail, now);
    unqueued.shift();
  }
}

function sendNotices(state: GateState): void {
  const events = pendingNotices.get(state);
  if (!events?.length) return;
  pendingNotices.delete(state);
  const now = deps.now();
  const due = outstanding(state, now);
  const open = bypassActive(state, now) ? ` (bypass open until ${clockLabel(Date.parse(state.bypass.until!))})` : "";
  const tail = due.length ? `still due: ${due.map((r) => r.label).join(", ")}${open}` : "nothing outstanding";
  unqueued.push({ events, tail });
  if (unqueued.length > UNQUEUED_MAX) unqueued = unqueued.slice(-UNQUEUED_MAX);
  try {
    queueNotices(now);
  } catch (error) {
    // The credit is already saved; a lost notice must never fail the gate.
    console.error("hygiene-gate: could not queue a photo notice; retrying on the next flush:", (error as Error).message);
  }
}

/** Bubble's one-line view of a photo the gate just recorded; null for photos nobody asked about. */
function noticeEvent(record: ImageRecord, line: string | null, state: GateState, only?: ProofTarget): NoticeEvent | null {
  const time = clockLabel(Date.parse(record.at));
  if (record.verdict === "accepted") {
    const slot = record.slot;
    let what = slot ? slotLabel(slot, state) : (record.kind ?? "photo");
    // "night teeth 23:16", not "night teeth (Nov 5) 23:16"; a late credit for yesterday keeps its day.
    if (slot && slot.split("/")[0] === localTime(Date.parse(record.at)).day) what = what.replace(/ \([^)]*\)$/, "");
    return { kind: "credited", text: `${what}${record.reading ? ` (${record.reading})` : ""} ${time}` };
  }
  // Unneeded, gym-only, an everyday photo sent while BYPASS was open, or one never meant as
  // proof (a screenshot checked because something is due later): nobody needs to hear of it.
  if (record.gymOnly || record.verdict === "unneeded" || !line || !attemptedProof(record)) return null;
  // An outage replay of a photo the gate already credited (the follower lost the reply) is the
  // same photo, not a second try: Bubble was told "credited" and must not hear "rejected".
  if (
    record.verdict === "duplicate" &&
    record.source.thread === "outage" &&
    // The same proofs checkImage's copy check counts.
    state.images.some((r) => r !== record && r.sha256 === record.sha256 && (r.verdict === "accepted" || r.verdict === "unneeded") && !r.gymOnly)
  )
    return null;
  const what = record.kind && record.kind !== "none" ? record.kind : (only?.kind ?? "photo");
  const why =
    record.verdict === "duplicate"
      ? (record.reason ?? "copy of an earlier photo")
      : record.verdict === "stale"
        ? "photo too old"
        : line.includes("too soon")
          ? "too soon to finish the walk"
          : line.includes("isn't due")
            ? "not due right now"
            : line.includes("not clear enough")
              ? "not clear enough"
              : (record.reason || "no proof visible");
  return { kind: "rejected", text: `${what} (${why.slice(0, 100)})` };
}

/** Refresh `seenAt` for an unchanged zone at most this often (it costs a state write). */
const ZONE_SEEN_EVERY_MS = 3_600_000;
const unknownZonesLogged = new Set<string>();

/**
 * Records the phone's zone from Cairn's status read (X-Device-Time-Zone). An
 * unknown zone is logged once and ignored: the last good one stays. A change
 * is logged and can open the gate (a travel day), so held chats are released.
 */
export async function noteDeviceZone(raw: string): Promise<void> {
  const named = raw.trim();
  if (!knownZone(named)) {
    // Logged once per name, and only for the first few names, so a bad client can't grow the set or the log.
    if (unknownZonesLogged.size < 32 && !unknownZonesLogged.has(named.slice(0, 64))) {
      unknownZonesLogged.add(named.slice(0, 64));
      console.error(`hygiene-gate: ignored unknown device time zone ${JSON.stringify(named.slice(0, 64))}; keeping ${zoneAt(deps.now())}`);
    }
    return;
  }
  // A zone showing Vancouver's clock now (America/Cambridge_Bay) is Vancouver: no change, no travel day.
  const zone = canonicalZone(named, deps.now());
  const lastZone = (last: ZoneChange | undefined) => last && canonicalZone(last.zone, Date.parse(last.from));
  const needed = (state: GateState, now: number) => {
    const last = state.zones?.at(-1);
    // The first report starts the record (Vancouver included), so a later change knows when the old zone was last seen.
    if (!last) return true;
    if (lastZone(last) !== zone || last.zone !== zone) return true;
    return now - Date.parse(last.seenAt ?? last.from) >= ZONE_SEEN_EVERY_MS;
  };
  // Most reads change nothing: skip the lock.
  if (!needed(loadState(), deps.now())) return;
  await serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    if (!needed(state, now)) return;
    const nowIso = new Date(now).toISOString();
    const zones = (state.zones ??= []);
    const last = zones.at(-1);
    const previous = lastZone(last);
    if (last && previous === zone) {
      // A stored alias is written back under its Vancouver name.
      last.zone = zone;
      last.seenAt = nowIso;
    } else {
      if (last) console.error(`hygiene-gate: device time zone ${previous ?? last.zone} -> ${zone}${named === zone ? "" : ` (reported ${named})`}`);
      zones.push({ zone, from: nowIso, seenAt: nowIso });
    }
    // Keep a year of history, plus the entry in effect before it.
    const cutoff = now - RETAIN_MS;
    while (zones.length > 1 && Date.parse(zones[1].from) < cutoff) zones.shift();
    saveState(state);
    // A first report of Vancouver only starts the record; nothing about the gate changed.
    if ((previous ?? TIME_ZONE) !== zone) release(state, now, "time zone changed");
  });
}

/** For tests: forget the cached state so a new HYGIENE_GATE_STATE takes effect. */
export function resetGateCache(): void {
  cache = null;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Hold the gate's cross-process lock for a whole decision (alex-0230 F7): during a
 * handoff two copies run, and each reads the state, awaits a photo check, then
 * writes. Without this, the slower one would write its stale copy over the other's
 * proofs and rulings. A dead holder's lock is taken over (filelock).
 */
async function withStateLock<T>(work: () => Promise<T>): Promise<T> {
  const path = `${statePath()}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (!tryLock(path).held) await Bun.sleep(25);
  try {
    return await work();
  } finally {
    unlock(path);
  }
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const locked = () => withStateLock(work);
  const run = queue.then(locked, locked);
  queue = run.catch(() => {});
  return run;
}

// ---- Request rewriting (applied to every forwarded request) ----

function cloneItem(item: ResponseInputItem): ResponseInputItem {
  return { ...item, content: partsOf(item).map((part) => ({ ...part })) };
}

/**
 * Puts back everything the gate ever changed in this thread's history, the
 * same way every time: withheld proof photos become their marker, and each
 * hidden note returns to the message it was first attached to.
 */
export function reapply(request: ResponsesRequest, state: GateState): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const withheld = new Map<string, ImageRecord>();
  for (const record of state.images)
    if (isWithheld(record) && !withheld.has(record.sha256)) withheld.set(record.sha256, record);
  const thread = request.prompt_cache_key;
  const notes = thread ? state.notes.filter((n) => n.thread === thread) : [];
  if (!withheld.size && !notes.length) return request;

  let input: ResponseInputItem[] | null = null;
  const edit = (index: number) => {
    input ??= (request.input as ResponseInputItem[]).slice();
    if (input[index] === (request.input as ResponseInputItem[])[index]) input[index] = cloneItem(input[index]);
    return input[index];
  };
  const original = request.input;
  if (withheld.size) {
    original.forEach((item, index) => {
      if (item?.role !== "user") return;
      partsOf(item).forEach((part, partIndex) => {
        if (part.type !== "input_image" || typeof part.image_url !== "string") return;
        const decoded = decodeDataUrl(part.image_url);
        const record = decoded && withheld.get(sha256(decoded.bytes));
        if (!record || wasDelivered(part.image_url)) return;
        const target = edit(index);
        (target.content as ReturnType<typeof partsOf>)[partIndex] = {
          type: "input_text",
          text: imageMarker(record, state),
        };
      });
    });
  }
  if (notes.length) {
    const keys = messageKeys(original);
    for (const [index, key] of keys) {
      const attached = notes.filter((n) => n.key === key);
      if (!attached.length || hasNote(original[index])) continue;
      const target = edit(index);
      target.content = [...partsOf(target), ...attached.map((n) => ({ type: "input_text", text: n.text }))];
    }
  }
  return input ? { ...request, input } : request;
}

// ---- Decisions ----

export type GateDecision =
  | { action: "forward"; request: ResponsesRequest; gateUnavailable?: boolean }
  | { action: "respond"; text: string };

export const CHECKING_TEXT =
  "📸 photo received, checking. This message is held; the chat wakes on its own once the gate unlocks.";

const forward = (request: ResponsesRequest, gateUnavailable = false): GateDecision =>
  ({ action: "forward", request, ...(gateUnavailable ? { gateUnavailable: true } : {}) });

const armed = (state: GateState, now: number) => outstanding(state, now).length > 0 && !bypassActive(state, now);

/** Sends queued wakes now; the server's timer retries any that fail. */
export async function flushWakes(): Promise<void> {
  if (!remoteGate()) await refreshFaults();
  try {
    queueNotices(deps.now());
  } catch (error) {
    console.error("hygiene-gate: could not queue a photo notice; retrying on the next flush:", (error as Error).message);
  }
  await flushWakeQueue(statePath(), deps.wake, deps.now);
}

function kickWakes(): void {
  void flushWakes().catch((error) => console.error("hygiene-gate: wake flush failed:", (error as Error).message));
}

/** Retry wakes that could not be sent (Today down, daemon restarting). */
export function startWakeRetries(intervalMs = 30_000): () => Promise<void> {
  const timer = setInterval(() => {
    if (!gateDisabled() && !remoteGate()) kickWakes();
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await wakesIdle();
  };
}

/**
 * After a decision that leaves the gate open, release what it held: other
 * chats get a wake, `current` gets the list back for a note on its own turn.
 */
function release(state: GateState, now: number, reason: string, current?: string) {
  if (armed(state, now)) return null;
  const released = releaseHeld(statePath(), now, reason, current);
  if (released?.woke) kickWakes();
  return released;
}

/**
 * `gym`: this photo added a gym check-in (save the state; the gate may have
 * opened). `retry`: the hygiene check failed and the same photo should be
 * sent again; nothing about its hygiene verdict was recorded.
 */
type ImageOutcome = { line: string | null; record?: ImageRecord; gym?: boolean; retry?: boolean };

/** Restricts a check to one requirement type (Cairn says which proof it sends). */
export type ProofTarget = { kind: ProofKind; slot: (name: string) => boolean };

async function checkImageRecorded(
  state: GateState,
  url: string,
  source: { thread: string; key: string },
  now: number,
  only?: ProofTarget,
): Promise<ImageOutcome> {
  // A gym photo also goes through the hygiene check: a shower photo at the gym is still a shower photo.
  const gym = only ? null : await gymPhoto(state, url, now);
  const before = state.images.length;
  const outcome = await whileChecking(statePath(), () => checkImage(state, url, source, now, only));
  // Only a record this call added is news; a retried message returns its first verdict silently.
  const added = state.images.length > before ? state.images.at(-1) : undefined;
  // "No hygiene proof visible" on a gym photo is not shown in the chat either.
  const event = added && !(gym && added.verdict === "rejected" && added.kind === "none") ? noticeEvent(added, outcome.line, state, only) : null;
  if (event) pendingNotices.set(state, [...(pendingNotices.get(state) ?? []), event]);
  const result = outcome.record || state.images.length === before ? outcome : { ...outcome, record: state.images.at(-1) };
  if (!gym) return result;
  let record = result.record;
  // Nothing hygiene-related was due (no record, no line, no retry): keep a gymOnly record as
  // the photo's trace. It never proved hygiene, so it is left out of the copy checks; an exact
  // resend is stale for hygiene after 30 minutes anyway. A checker error stays retryable.
  if (!record && !result.line && !result.retry && gym.recorded) {
    record = {
      sha256: gym.hash,
      dhash: gym.dhash,
      at: new Date(now).toISOString(),
      source,
      kind: null,
      verdict: "unneeded",
      reason: "gym photo",
      gymOnly: true,
    };
    state.images.push(record);
  }
  // "No hygiene proof visible" is noise when the photo was meant for the gym.
  const hygieneLine = record?.verdict === "rejected" && record.kind === "none" ? null : result.line;
  return {
    line: hygieneLine ? `${gym.line}\n${hygieneLine}` : gym.line,
    ...(record ? { record } : {}),
    gym: gym.recorded,
    ...(result.retry ? { retry: true } : {}),
  };
}

/**
 * A photo taken at the gym while a plan could use it (Alex, 2026-11-02: a
 * geotagged photo at Gold's plus the Uplifting log counts if Uplifting's
 * location fails). Needs a fresh camera time and GPS inside the gym radius;
 * it is stored as a Start check-in with its dhash, distance only. A replay or
 * a near copy of an earlier gym photo or hygiene proof earns nothing, whatever
 * the hygiene verdict was. Null when the photo isn't a gym photo.
 */
async function gymPhoto(
  state: GateState,
  url: string,
  now: number,
): Promise<{ line: string; recorded: boolean; hash: string; dhash: string | null } | null> {
  if (!state.gym || !gymPhotoWanted(state.gym, now)) return null;
  const decoded = decodeDataUrl(url);
  if (!decoded) return null;
  const taken = await deps.captureTime(decoded.bytes);
  if (taken === null || now - taken > EXIF_MAX_AGE_MS || taken - now > EXIF_FUTURE_SLACK_MS) return null;
  const fix = await deps.gpsFix(decoded.bytes);
  if (!fix) return null;
  const s = gymSettings(state.gym);
  const distance = distanceM(fix, s.gym);
  if (!(distance <= s.gym.radiusM)) return null;
  const hash = sha256(decoded.bytes);
  const dhash = await deps.dhash(decoded.bytes);
  const near = (a: string, b: string) => hammingDistance(a, b) <= NEAR_DUPLICATE_BITS;
  // An earlier hygiene proof (or its near copy) can't be reused as a gym photo either.
  // Gym-only records are left out: gym-to-gym near copies are judged by recordGymPhoto within
  // 12 h, so the same mirror and pose on another day still counts. Real hygiene proofs (even one
  // that was also a gym photo) stay in for all time.
  const proofs = state.images.filter((r) => (r.verdict === "accepted" || r.verdict === "unneeded") && !r.gymOnly);
  // An exact copy of a hygiene proof (a dual-purpose gym photo included) is a replay, a near
  // copy never counts. A gym-only photo's resend is called a replay by recordGymPhoto.
  const exactProof = proofs.some((r) => r.sha256 === hash);
  const reused = proofs.some((r) => r.sha256 !== hash && r.dhash && dhash && near(r.dhash, dhash));
  const at = Math.min(taken, now);
  const outcome = exactProof
    ? "replay"
    : reused
      ? "near"
      : recordGymPhoto(state.gym, { id: hash.slice(0, 16), distanceM: distance, at, now, dhash }, near);
  const line =
    outcome === "recorded"
      ? `💪 gym photo recorded: ${Math.round(distance)} m from ${s.gym.name} at ${clockLabel(at)}. It stands in for Uplifting's location; the session counts once the Uplifting workout it was taken during syncs (at least ${s.minMinutes} min and ${s.minSets} sets).`
      : outcome === "replay"
        ? "💪 this gym photo was already counted."
        : "💪 not counted for the gym: it is a copy of an earlier photo.";
  return { line, recorded: outcome === "recorded", hash, dhash };
}

async function checkImage(
  state: GateState,
  url: string,
  source: { thread: string; key: string },
  now: number,
  only?: ProofTarget,
): Promise<ImageOutcome> {
  const decoded = decodeDataUrl(url);
  if (!decoded) return { line: null };
  const hash = sha256(decoded.bytes);
  // A retry or replay of the same message keeps its first verdict.
  const previous = state.images.find(
    (r) => r.sha256 === hash && r.source.thread === source.thread && r.source.key === source.key,
  );
  if (previous) return { line: null, record: previous };
  const slotsFor = (kind: ProofKind) =>
    candidateSlots(state, kind, now).filter((name) => !only || (kind === only.kind && only.slot(name)));
  const kinds = only ? (slotsFor(only.kind).length ? [only.kind] : []) : wantedKinds(state, now);
  if (!kinds.length) return { line: only ? "❌ nothing of that kind is due right now." : null };
  const record: ImageRecord = {
    sha256: hash,
    dhash: null,
    at: new Date(now).toISOString(),
    source,
    kind: null,
    verdict: "rejected",
    // Read before this photo can fill anything: was it sent to unlock the gate?
    locked: outstanding(state, now).length > 0 && !bypassActive(state, now),
  };
  // Only passed proofs count: a retake right after a rejected photo must not collide with it.
  // A gym-only photo never proved hygiene, so it can't make a later photo a copy.
  const proofs = state.images.filter((r) => (r.verdict === "accepted" || r.verdict === "unneeded") && !r.gymOnly);
  if (proofs.some((r) => r.sha256 === hash)) {
    state.images.push({ ...record, verdict: "duplicate", reason: "exact copy of an earlier photo" });
    return { line: "❌ photo rejected: it is a copy of an earlier proof photo." };
  }
  record.dhash = await deps.dhash(decoded.bytes);
  if (record.dhash) {
    const near = proofs.find(
      (r) => r.dhash && hammingDistance(r.dhash, record.dhash!) <= NEAR_DUPLICATE_BITS,
    );
    if (near) {
      state.images.push({ ...record, verdict: "duplicate", reason: "near-copy of an earlier photo" });
      return { line: "❌ photo rejected: it is a near-copy of an earlier proof photo." };
    }
  }
  const taken = await deps.captureTime(decoded.bytes);
  if (taken !== null && (now - taken > EXIF_MAX_AGE_MS || taken - now > EXIF_FUTURE_SLACK_MS)) {
    const minutes = Math.round((now - taken) / 60_000);
    state.images.push({ ...record, verdict: "stale", reason: `taken ${minutes} min before sending` });
    return { line: `❌ photo rejected: its camera timestamp is ${minutes} minutes old (limit 30).` };
  }
  // Classification and credit must refer to the same eligible (possibly explicitly targeted) debt.
  const penanceSlot = slotsFor("penance")[0];
  const penance = state.debts.find(d => `penance/${d.id}` === penanceSlot);
  let verdict;
  try {
    verdict = await deps.classify(decoded, {
      kinds,
      penance: kinds.includes("penance") ? penance?.penance?.description : undefined,
    });
  } catch (error) {
    // Not recorded: the same photo can be retried once the checker works.
    console.error("hygiene-gate: classifier failed:", (error as Error).message);
    return { line: "⚠️ couldn't check the photo (classifier error). Send it again, or reply the BYPASS line below.", retry: true };
  }
  record.kind = verdict.kind;
  record.reason = verdict.reason;
  // Kept so a later credit can tell "the wrong kind" from "not clear enough".
  if (Number.isFinite(verdict.confidence)) record.confidence = verdict.confidence;
  // A penance that asks for an everyday kind ("brushing your teeth before bed") takes that
  // kind's verdict when the kind itself isn't due, instead of refusing the very photo it asked
  // for as "not due" (Nov 4 01:23).
  if (
    kinds.includes("penance") &&
    verdict.kind !== "penance" &&
    verdict.kind !== "none" &&
    !kinds.includes(verdict.kind as ProofKind) &&
    penanceProofKinds(penance?.penance?.description).includes(verdict.kind as ProofKind)
  ) {
    verdict = { ...verdict, kind: "penance", reason: `${verdict.reason} (counts as the penance)` } as typeof verdict;
    record.kind = verdict.kind;
    record.reason = verdict.reason;
  }
  if (verdict.kind === "none" || !kinds.includes(verdict.kind as ProofKind)) {
    state.images.push(record);
    return {
      line:
        verdict.kind === "none"
          ? `❌ photo not accepted: ${verdict.reason || "no hygiene proof visible"}`
          : `❌ photo looks like ${verdict.kind}, which isn't due right now.`,
    };
  }
  if (verdict.confidence < MIN_CONFIDENCE) {
    state.images.push(record);
    return { line: `❌ photo not clear enough to accept: ${verdict.reason || "low confidence"}` };
  }
  const target = slotsFor(verdict.kind as ProofKind)[0];
  // An everyday outdoor or kitchen photo must not start a walk or count as creatine by accident:
  // only one sent to unlock the gate, during DELAY, for a requirement Alex moved (MOVE/LATER),
  // or through Cairn's proof flow counts.
  const meant =
    (verdict.kind !== "walk" && verdict.kind !== "creatine") ||
    record.locked ||
    source.thread === "cairn" ||
    delayActive(state, now) ||
    (!!target && (state.moves ?? []).some((m) => m.slot === target || (target.endsWith("/morning-walk-start") && m.slot === target.replace(/-start$/, ""))));
  if (!target) {
    state.images.push({ ...record, verdict: "unneeded" });
    return { line: null };
  }
  if (!meant) {
    // Rejected, not unneeded: it stays out of the copy checks, so the same photo counts once
    // BYPASS ends. No line: the turn is forwarded, so nothing would show it.
    state.images.push({ ...record, reason: "not counted: sent while BYPASS was open" });
    return { line: null };
  }
  if (target.endsWith("/morning-walk")) {
    // Receipt time, not EXIF: chat attachments arrive with their camera time stripped.
    const started = walkStartedAt(state, localTime(now).day);
    if (started !== null && now - started < WALK_MS) {
      const from = clockLabel(started + WALK_MS);
      state.images.push({ ...record, reason: `walk second photo before ${from}` });
      return {
        line: `❌ too soon: the walk started at ${clockLabel(started)}; send the second outdoor photo from ${from}.`,
      };
    }
  }
  state.filled[target] = record.at;
  if (target.startsWith("penance/")) {
    const debt = state.debts.find((d) => `penance/${d.id}` === target);
    if (debt?.penance) {
      debt.penance.paidAt = record.at;
      debt.status = "paid";
    }
  }
  let file: string | undefined;
  try {
    // The keepsake never holds a location: every photo is saved with its location tags removed, or not at all.
    const keep = await deps.stripGps(decoded);
    if (!keep) throw new Error("could not remove the photo's location tags");
    file = deps.archive(keep, verdict.kind, now, hash);
  } catch (error) {
    // The proof still counts; only the keepsake copy is missing.
    console.error("hygiene-gate: could not save the photo:", (error as Error).message);
  }
  const reading = verdict.kind === "weight" ? verdict.reading : undefined;
  state.images.push({
    ...record,
    verdict: "accepted",
    slot: target,
    ...(file ? { file } : {}),
    ...(reading ? { reading } : {}),
    ...(verdict.kind === "weight" ? {
      capturedAt: taken !== null && Number.isFinite(taken) ? new Date(taken).toISOString() : null,
      cairnWeightPending: true,
    } : {}),
  });
  if (target.endsWith("/morning-walk-start"))
    return {
      line: `🚶 walk started at ${clockLabel(now)}. Send another outdoor photo from ${clockLabel(now + WALK_MS)} to finish it.`,
    };
  return { line: `✅ ${slotLabel(target, state)} photo accepted${reading ? ` (${reading})` : ""}.` };
}

/** This lock's BYPASS words, issuing fresh ones for a new lock (the caller saves the state). */
function lockPhrase(state: GateState, due: { slot: string }[], now: number): { words: string; changed: boolean } {
  return ensurePhrase(state.bypass, due.map((r) => r.slot), now, deps.bypassWords);
}

/**
 * A BYPASS attempt. Only this lock's exact "BYPASS w1 w2 w3" opens the gate; a
 * bare BYPASS, a typo or an earlier lock's words get the lock text again with
 * the current phrase. Counting, the 1 h window and the debt are unchanged.
 */
function bypassReply(state: GateState, now: number, text: string): string {
  if (bypassActive(state, now))
    return `🚪 bypass already open until ${clockLabel(Date.parse(state.bypass.until!))}.`;
  const due = outstanding(state, now);
  if (!due.length) {
    retire(state.bypass);
    return "✅ gate is already clear; no bypass used.";
  }
  const { words } = lockPhrase(state, due, now);
  if (!matchesPhrase(text, words)) {
    const why = /^bypass$/i.test(text.trim().replace(/[.!?,]+$/, ""))
      ? "🔑 BYPASS needs this lock's three words."
      : "🔑 That isn't this lock's BYPASS phrase.";
    return lockedText(due, [why], words);
  }
  retire(state.bypass);
  const at = new Date(now).toISOString();
  state.bypass.count += 1;
  state.bypass.until = new Date(now + BYPASS_MS).toISOString();
  state.bypass.history.push(at);
  const debt: Debt = {
    id: `${localTime(now).day}-${state.bypass.count}`,
    at,
    skipped: due.map((r) => r.label),
    items: [...new Set(due.map(r => itemKey(r.slot)))],
    status: "open",
  };
  state.debts.push(debt);
  return `🚪 bypass #${state.bypass.count}: gate open until ${clockLabel(now + BYPASS_MS)}. Your next turn will ask why.`;
}

export type ShieldBypassResult =
  | { ok: true; applied: boolean; duplicate: boolean; until: string | null; debt_id: string | null }
  | { ok: false; status: number; error: string };

/** Reports more than this far in the future are refused (phone clocks drift a little). */
const SHIELD_FUTURE_SLACK_MS = 5 * 60_000;
/** Taps older than this are refused: the gate can no longer judge whether it was locked then. */
const SHIELD_MAX_AGE_MS = 24 * 3_600_000;
/** Shield records are kept this long, past the age cap, so a retry still finds its first answer. */
const SHIELD_KEEP_MS = 7 * 86_400_000;

/**
 * A shield tap at `anchor` cost nothing, judged only from facts with times:
 * - a bypass that had already started covered it (the newest bypass started
 *   at or before the tap and its end is after it), or
 * - nothing locks the gate now, nothing locked it at the tap as far as the
 *   current state can tell (this can only add charges: everything that could
 *   make the current state under-report the tap's locks is the next list),
 *   and nothing that could have cleared a lock happened after the tap: no
 *   proof accepted, no penance paid, no gym session seen or check-in
 *   received, no DELAY started.
 * The tap-time check also catches locks that end on their own: midnight
 * rolling a missed morning photo out of view, a gym read going stale, and a
 * gym read failing after the tap. For that last one the tap is judged with
 * the current read error set aside (freshness from syncedAt alone); an error
 * from before the tap can then over-charge, which is the safe direction. The
 * live gate still fails open for the gym on any error.
 */
function shieldTapFree(state: GateState, anchor: number, now: number): boolean {
  const starts = state.bypass.history.map(Date.parse).filter(Number.isFinite);
  const newest = starts.length ? Math.max(...starts) : Number.POSITIVE_INFINITY;
  if (newest <= anchor && bypassActive(state, anchor)) return true;
  if (outstanding(state, now).length || outstanding(atTapView(state), anchor).length) return false;
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) > anchor;
  if (state.images.some((r) => r.verdict === "accepted" && after(r.at))) return false;
  // A penance revised away after the tap cleared a lock too, like one paid (comb, Nov 3).
  if (state.debts.some((d) => after(d.penance?.paidAt) || d.history?.some((h) => after(h.revisedAt)))) return false;
  if (state.gym?.sessions.some((s) => after(s.seenAt))) return false;
  if (state.gym?.checkins.some((c) => after(c.receivedAt))) return false;
  if (state.delay.until && Date.parse(state.delay.until) - DELAY_MS > anchor) return false;
  // A MOVE after the tap may have cleared a lock that held at the tap.
  if (state.moves?.some((m) => after(m.at))) return false;
  return true;
}

/** The state for judging a past tap: the current gym read error (which has no time) set aside. */
function atTapView(state: GateState): GateState {
  if (!state.gym?.syncError) return state;
  const { syncError: _, ...gym } = state.gym;
  return { ...state, gym };
}

/**
 * The "Emergency" button on Cairn's app shield: a BYPASS for `minutes`, sent
 * when the phone is back online. The window is anchored to the tap, never to
 * the report, so a late report can't grant a fresh window, and a repeat of the
 * same source + tap time returns the first answer.
 *
 * Every tap is charged (a debt the model rules on, as BYPASS) unless the gate
 * can show it cost nothing (shieldTapFree). The gate keeps no full history, so
 * it cannot replay its state at the tap; when in doubt it charges, and "the
 * shield was stale" is an answer the model can accept.
 */
export async function shieldBypass(input: { minutes: number; source: string; at: string }): Promise<ShieldBypassResult> {
  const tap = Date.parse(input.at);
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 60)
    return { ok: false, status: 400, error: "minutes must be a whole number, 1-60" };
  if (!/^[a-z0-9._-]{1,40}$/i.test(input.source)) return { ok: false, status: 400, error: "source must be 1-40 letters, digits, . _ -" };
  if (!Number.isFinite(tap)) return { ok: false, status: 400, error: "at must be an ISO time" };
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    if (tap > now + SHIELD_FUTURE_SLACK_MS) return { ok: false, status: 400, error: "at is in the future" };
    const at = new Date(tap).toISOString();
    state.shieldBypasses ??= [];
    const seen = state.shieldBypasses.find((b) => b.source === input.source && b.at === at);
    if (seen) return { ok: true, applied: seen.applied, duplicate: true, until: seen.applied ? seen.until : null, debt_id: seen.debtId };
    if (tap < now - SHIELD_MAX_AGE_MS) return { ok: false, status: 400, error: "at is more than 24 hours old" };

    // A fast phone clock can't stretch the window past what was asked.
    const anchor = Math.min(tap, now);
    const until = anchor + input.minutes * 60_000;
    let debtId: string | null = null;
    let applied = false;
    if (!shieldTapFree(state, anchor, now)) {
      // Numbered from the debts themselves: shield records are trimmed, debts are not.
      const prefix = `${localTime(anchor).day}-shield-`;
      debtId = `${prefix}${state.debts.filter((d) => d.id.startsWith(prefix)).length + 1}`;
      // Locks as best the gate can tell at the tap, else those at the report, else a lock that has since cleared.
      // Inferred from the current state, so it can over-state (the docs say so).
      const tapRequirements = outstanding(atTapView(state), anchor);
      const reportRequirements = outstanding(state, now);
      const atTap = tapRequirements.map(r => r.label);
      const atReport = reportRequirements.map(r => `at report: ${r.label}`);
      // A late report may follow the proof that cleared its lock. Keep that historical key.
      const clearedSlots = state.images.filter(r => r.verdict === "accepted" && r.slot && Date.parse(r.at) > anchor && Date.parse(r.at) <= now).map(r => r.slot!);
      const items = [...new Set([...tapRequirements.map(r => r.slot), ...reportRequirements.map(r => r.slot), ...clearedSlots].map(itemKey))];
      const skipped = atTap.length ? atTap : atReport.length ? atReport : ["a lock cleared after the tap"];
      state.debts.push({ id: debtId, at: new Date(anchor).toISOString(), skipped, ...(items.length ? {items} : {}), itemsComplete: false, status: "open" });
      supersedeMoveDebts(state, items, anchor, debtId, now);
      if (until > now) {
        applied = true;
        state.bypass.count += 1;
        state.bypass.history.push(new Date(anchor).toISOString());
        const current = state.bypass.until ? Date.parse(state.bypass.until) : 0;
        if (until > current) state.bypass.until = new Date(until).toISOString();
        // The gate opened: when it locks again, the lock gets new words.
        retire(state.bypass);
      }
    }
    // The gate's own end, which a longer bypass already open may set: the phone re-locks from it.
    const reported = applied ? state.bypass.until : null;
    state.shieldBypasses = state.shieldBypasses.filter((b) => now - Date.parse(b.recordedAt) <= SHIELD_KEEP_MS);
    state.shieldBypasses.push({ source: input.source, at, until: reported ?? new Date(until).toISOString(), applied, debtId, recordedAt: new Date(now).toISOString() });
    saveState(state);
    if (applied) release(state, now, "BYPASS");
    return { ok: true, applied, duplicate: false, until: reported, debt_id: debtId };
  });
}

function delayReply(state: GateState, now: number): string {
  const { day, minutes } = localTime(now);
  const due = outstanding(state, now);
  const morningOnly = onlyMorningDue(state, due, now);
  const single: Record<string, string> = { weight: "weigh-in photo", creatine: "creatine photo", walk: "walk photos" };
  const photos = due.length > 1 ? "morning photos" : (single[due[0]?.kind ?? ""] ?? "teeth photo");
  if (delayActive(state, now))
    return `⏰ delay already open until ${clockLabel(Date.parse(state.delay.until!))}. Send the morning photo when you can.`;
  if (!due.length) return "✅ gate is already clear; no delay used.";
  if (!morningOnly || minutes < MORNING_MINUTE || minutes >= DELAY_END_MINUTE)
    return `DELAY only postpones the morning photos (05:00 to 12:00). For anything else, send the photo or reply BYPASS ${lockPhrase(state, due, now).words}.`;
  if (state.delay.history.includes(day))
    return `DELAY was already used this morning. Send the ${photos}, or reply BYPASS ${lockPhrase(state, due, now).words}.`;
  state.delay.count += 1;
  state.delay.until = new Date(now + DELAY_MS).toISOString();
  state.delay.day = day;
  state.delay.history.push(day);
  // The gate opens for the delay; when it relocks, that's a new lock with new words.
  retire(state.bypass);
  return `⏰ delay: gate open until ${clockLabel(now + DELAY_MS)}. Send the ${photos} before then.`;
}

export type MoveOutcome =
  | { ok: true; message: string; moved: SlotMove[]; plan?: GymPlan }
  | { ok: false; error: string };

/**
 * MOVE/LATER (hygiene.ts): reschedules photo requirements, or today's gym plan,
 * to later today. Never a BYPASS: the bypass count and debts are untouched.
 * Mutates `state` only on success (the caller saves it).
 */
function applyMove(state: GateState, now: number, cmd: MoveCommand, by: string): MoveOutcome {
  const time = resolveMoveTime(cmd.time, now, cmd.otherDay);
  if ("error" in time) return { ok: false, error: time.error };
  if (cmd.gym) {
    const today = localTime(now).day;
    const todays = evaluateGym(state.gym, now)
      .filter((r) => localTime(Date.parse(r.plan.start)).day === today && r.status !== "cancelled")
      .sort((a, b) => Date.parse(a.plan.start) - Date.parse(b.plan.start));
    // The first plan a move can take: upcoming and not past its start-by time (one waiting for
    // Uplifting's read after its deadline is a likely miss and never moves).
    const open = todays.find((r) => r.status === "upcoming" && now < r.deadline);
    if (!open) {
      const missed = todays.find((r) => r.status === "missed" || (r.status === "upcoming" && now >= r.deadline));
      const going = todays.find((r) => r.status === "in-progress");
      return {
        ok: false,
        error: going
          ? "today's gym session is under way (open Start); finish it in Uplifting"
          : missed
            ? `today's gym plan (${clockLabel(Date.parse(missed.plan.start))}) is past its start-by time; a move never erases a miss. Log a session in Uplifting, or reply BYPASS`
            : "there is no gym plan left today to move",
      };
    }
    if (time.at <= Date.parse(open.plan.start))
      return { ok: false, error: `today's gym plan is already at ${clockLabel(Date.parse(open.plan.start))}; MOVE only pushes it later` };
    const r = reschedulePlan(state.gym!, open.plan.id, new Date(time.at).toISOString(), now, by);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, message: `🏋️ gym ${r.message}. No bypass, no debt.`, moved: [], plan: r.plan };
  }
  const locking = outstanding(state, now).map((r) => r.slot);
  const movable = movableSlots(state, now);
  let names: string[];
  if (cmd.items === null) {
    names = locking.filter((s) => movable.includes(s));
    if (!names.length)
      return {
        ok: false,
        error: locking.length
          ? "only photo requirements can move; a penance or a missed gym session can't"
          : "nothing locks now, so there is nothing to move. To move a photo before it is due, name it: MOVE teeth 08:00",
      };
  } else {
    const named = movable.filter((s) => cmd.items!.includes(itemKey(s)));
    const lockingNamed = named.filter((s) => locking.includes(s));
    names = lockingNamed.length ? lockingNamed : named;
    if (!names.length) return { ok: false, error: "nothing by that name is due today that can move (tonight's photos are due by midnight already)" };
  }
  const r = moveSlots(state, names, time.at, now, by);
  if (!r.ok) return { ok: false, error: r.error };
  const left = Math.min(...names.map((n) => MAX_MOVES_PER_DAY - movesToday(state, n, now).length));
  return {
    ok: true,
    message: `⏩ moved ${names.map((n) => slotLabel(n, state)).join(", ")} to ${clockLabel(time.at)}. No bypass, no debt (${left ? `${left} more move${left === 1 ? "" : "s"}` : "no more moves"} today); if it isn't done by midnight it counts as a skip.`,
    moved: r.moved,
  };
}

function moveReply(state: GateState, now: number, cmd: MoveCommand, by: string): string {
  const outcome = applyMove(state, now, cmd, by);
  const line = outcome.ok ? outcome.message : `⏩ can't move: ${outcome.error}.`.replace(/\.\.$/, ".");
  const due = outstanding(state, now);
  if (!due.length) {
    retire(state.bypass);
    return line;
  }
  if (bypassActive(state, now)) return line;
  return lockedText(due, [line], lockPhrase(state, due, now).words);
}

/** Cairn's Move button (POST /hygiene/api/v1/move): the same move as the chat reply. */
export async function moveRequest(cmd: MoveCommand, by: string): Promise<MoveOutcome> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    const charged = chargeBrokenMoves(state, now).length > 0;
    const outcome = applyMove(state, now, cmd, by);
    if (!outcome.ok) {
      if (charged) saveState(state);
      return outcome;
    }
    if (!outstanding(state, now).length) retire(state.bypass);
    saveState(state);
    release(state, now, "MOVE");
    return outcome;
  });
}

/**
 * Charges moves whose day ended unkept (chargeBrokenMoves) from a status read,
 * so the phone shows the debt without waiting for a chat turn. Most reads
 * change nothing and skip the lock.
 */
export async function chargeMoves(): Promise<void> {
  // The kill switch stops the gate charging anything, like every other gate action.
  if (gateDisabled()) return;
  if (!chargeBrokenMoves(structuredClone(loadState()), deps.now()).length) return;
  await serialized(async () => {
    const state = structuredClone(loadState());
    if (chargeBrokenMoves(state, deps.now()).length) saveState(state);
  });
}

/**
 * The gate's answer for one Responses request. Never throws: a bug here must
 * not take down inference, so failures forward the request untouched.
 */
/** Who asked: a follower proxy names its machine so a held chat is woken there. */
export type GateOrigin = { machine?: string };

export async function gateRequest(request: ResponsesRequest, origin: GateOrigin = {}): Promise<GateDecision> {
  if (gateDisabled()) return forward(request);
  const remote = remoteGate();
  if (remote) {
    try {
      return await followRemote(remote, request);
    } catch (error) {
      // Unknown photos must not block delivery.
      console.error("hygiene-gate: follower failed open:", (error as Error).message);
      return forward(deliverForOutage(request, deps.now()), true);
    }
  }
  try {
    const state = loadState();
    const turn = classifyTurn(request, state.extraGatedTriggers);
    if (turn.type !== "human") return forward(reapply(request, state));
    // Read Uplifting first if a gym deadline has passed, bounded to 5 s in all.
    // Skipped while a photo is checked: the instant "checking" reply comes first.
    if (!photoChecking(statePath())) await refreshIfDeciding(gymHost, state.gym, 60_000, deps.gymRefreshMs);
    const checking = checkingReply(request, turn, loadState(), origin);
    if (checking) return checking;
    return await serialized(() => decideHumanTurn(request, turn, origin));
  } catch (error) {
    console.error("hygiene-gate: failed open:", (error as Error).message);
    return forward(deliverForOutage(request, deps.now()), true);
  }
}

/** This proxy follows another machine's gate (hygiene-remote.ts). */
async function followRemote(remote: string, request: ResponsesRequest): Promise<GateDecision> {
  const decision = await remoteGateRequest(remote, request);
  if (decision) {
    if (decision.action === "forward") {
      // The authority itself may have failed to read its gate state.
      if (decision.gateUnavailable)
        return forward(deliverForOutage(request, deps.now()), true);
      return forward(preserveDelivered(request, decision.request));
    }
    const state = await fetchRemoteState(remote, 2000);
    if (state) rememberVerdicts(state);
    return decision;
  }
  return forward(deliverForOutage(request, deps.now()), true);
}

/**
 * A photo is being checked and the gate is armed: answer at once instead of
 * queueing behind the check and locking again (Alex, 2026-11-01). The message
 * is held, so it is picked up when the photo unlocks the gate. A turn with its
 * own photo, BYPASS or DELAY still waits for the gate's lock.
 */
function checkingReply(
  request: ResponsesRequest,
  turn: Extract<ReturnType<typeof classifyTurn>, { type: "human" }>,
  state: GateState,
  origin: GateOrigin,
): GateDecision | null {
  if (turn.images.length || isBypassAttempt(turn.text) || isDelayText(turn.text) || parseMoveText(turn.text)) return null;
  const now = deps.now();
  if (!armed(state, now) || !photoChecking(statePath())) return null;
  const key = messageKeys(request.input as ResponseInputItem[]).get(turn.newest) ?? "";
  holdMessage(statePath(), {
    thread: request.prompt_cache_key ?? "",
    machine: origin.machine,
    key,
    at: new Date(now).toISOString(),
    text: turn.text,
    attachments: 0,
  });
  // The check may have finished, and released what was held, between the test
  // above and the hold. Behind the gate's lock, after any check in progress,
  // release again if the gate is open by then.
  void serialized(async () => {
    release(loadState(), deps.now(), "photo accepted");
  }).catch((error) => console.error("hygiene-gate: held-message recheck failed:", (error as Error).message));
  return { action: "respond", text: CHECKING_TEXT };
}

async function decideHumanTurn(
  request: ResponsesRequest,
  turn: Extract<ReturnType<typeof classifyTurn>, { type: "human" }>,
  origin: GateOrigin,
): Promise<GateDecision> {
  const state = structuredClone(loadState());
  const now = deps.now();
  const input = request.input as ResponseInputItem[];
  const thread = request.prompt_cache_key ?? "";
  const keys = messageKeys(input);
  let dirty = false;
  let gymOpened = false;
  // A move whose day ended unkept is charged first, so this turn carries its note.
  if (chargeBrokenMoves(state, now).length) dirty = true;

  // A bare BYPASS or a full phrase is answered in every state, as a bare BYPASS was
  // before; looser shapes only while the gate is armed, so a clear or open gate never
  // swallows ordinary text.
  const locked = outstanding(state, now).length > 0 && !bypassActive(state, now);
  if (!turn.images.length && (isBareBypass(turn.text) || (locked && isBypassAttempt(turn.text)))) {
    const text = bypassReply(state, now, turn.text);
    saveState(state);
    release(state, now, "BYPASS");
    return { action: "respond", text };
  }
  if (isDelayText(turn.text) && !turn.images.length) {
    const text = delayReply(state, now);
    saveState(state);
    release(state, now, "DELAY");
    return { action: "respond", text };
  }
  const move = turn.images.length ? null : parseMoveText(turn.text);
  // An unnamed LATER is a gate reply only while the gate shows a lock, so a clear or bypassed
  // gate never swallows "later 5pm" meant for the chat. A named item (MOVE teeth 08:00) always is.
  if (move && (move.items !== null || move.gym || locked)) {
    const text = moveReply(state, now, move, `chat:${thread || "unknown"}`);
    saveState(state);
    release(state, now, "MOVE");
    return { action: "respond", text };
  }

  const lines: string[] = [];
  let attachments = 0;
  for (const image of turn.images) {
    const before = state.images.length;
    const outcome = await checkImageRecorded(state, image.url, { thread, key: keys.get(image.item) ?? "" }, now);
    if (outcome.line) lines.push(outcome.line);
    if (!outcome.record || !isWithheld(outcome.record)) attachments++;
    if (state.images.length !== before || outcome.gym) dirty = true;
    if (outcome.gym) gymOpened = true;
  }

  const due = outstanding(state, now);
  if (due.length && !bypassActive(state, now)) {
    const { words, changed } = lockPhrase(state, due, now);
    if (dirty || changed) saveState(state);
    holdMessage(statePath(), {
      thread,
      machine: origin.machine,
      key: keys.get(turn.newest) ?? "",
      at: new Date(now).toISOString(),
      text: turn.text,
      attachments,
    });
    return { action: "respond", text: lockedText(due, lines, words) };
  }
  // The gate is open: this lock's phrase is spent, and the next lock gets new words.
  if (!due.length && retire(state.bypass)) dirty = true;

  // Let the turn through, once per thread telling the model about open debts.
  const newestKey = keys.get(turn.newest);
  // The gate can also open without a photo here (an overdue slot ages out).
  const reason = lines.some((line) => line.startsWith("✅")) ? "photo accepted" : gymOpened ? "gym photo" : "gate clear";
  const released = release(state, now, reason, thread || undefined);
  if (released?.note.length && newestKey && thread) {
    state.notes.push({
      thread,
      key: newestKey,
      debtId: `held:${now}`,
      text: heldNoteText(released.note, released.noteDropped),
    });
    dirty = true;
  }
  if (newestKey && thread) {
    const noted = (id: string) => state.notes.some((n) => n.thread === thread && n.key === newestKey && n.debtId === id);
    if (delayActive(state, now) && !noted(`delay:${state.delay.day}`)) {
      state.notes.push({
        thread,
        key: newestKey,
        debtId: `delay:${state.delay.day}`,
        text: delayNoteText(Date.parse(state.delay.until!)),
      });
      dirty = true;
    }
    for (const debt of state.debts.filter((d) => d.status === "open")) {
      if (state.notes.some((n) => n.thread === thread && n.debtId === debt.id)) continue;
      if (Date.parse(debt.at) >= now) continue;
      state.notes.push({ thread, key: newestKey, debtId: debt.id, text: noteText(debt, deps.baseUrl) });
      dirty = true;
    }
  }
  if (dirty) saveState(state);
  return forward(reapply(request, state));
}

// ---- Status and ruling ----

// ---- Gym (gym.ts) ----

/**
 * Edits the gym part of the state behind the gate's lock. Saves when `edit`
 * reports a change, then releases held chats if the gate is open.
 */
async function mutateGym<T>(edit: (gym: GymState, now: number) => { changed: boolean; result: T }, reason: string): Promise<T> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    state.gym ??= emptyGym();
    const { changed, result } = edit(state.gym, now);
    if (changed) {
      saveState(state);
      release(state, now, reason);
    }
    return result;
  });
}

export const gymHost: GymSyncHost = {
  now: () => deps.now(),
  hasGym: () => {
    try {
      return !gateDisabled() && !remoteGate() && !!loadState().gym?.plans.length;
    } catch {
      return false;
    }
  },
  neededSince: () => {
    try {
      const gym = loadState().gym;
      const early = gymSettings(gym).earlyMin * 60_000;
      const open = evaluateGym(gym, deps.now()).filter((r) => r.status === "missed" || r.status === "upcoming" || r.status === "in-progress");
      return open.length ? Math.min(...open.map((r) => Date.parse(r.plan.start) - early)) : null;
    } catch {
      return null;
    }
  },
  apply: (edit) => mutateGym((gym, now) => ({ changed: edit(gym, now), result: undefined }), "gym session"),
};

/** Polls Uplifting while there are plans (authority only; followers ask the authority). */
export function startGymPolling(intervalMs?: number): () => Promise<void> {
  if (remoteGate()) return async () => {};
  return startGymSync(gymHost, intervalMs);
}

/**
 * What the phone's shield depends on: whether the gate is armed, and when a
 * bypass ends (the phone schedules its own re-lock from it). A change here
 * wakes Cairn (phone-wake.ts).
 */
export function shieldSignature(): string {
  const status = gateStatus();
  return `${status.state}|${status.bypass.activeUntil ?? ""}`;
}

/** Wakes Cairn when the shield signature changes (authority only; never under tests). */
export function startPhoneWakes(send: PhoneWakeSender = relaySender(), intervalMs?: number): () => Promise<void> {
  if (remoteGate() || process.env.NODE_ENV === "test") return async () => {};
  return startPhoneWake(
    () => wakeFilePath(statePath()),
    () => (remoteGate() ? null : shieldSignature()),
    () => deps.now(),
    send,
    intervalMs,
  );
}

/** Plans with their status, recent sessions and whether each counted. */
export function gymReport() {
  const now = deps.now();
  const gym = loadState().gym;
  const settings = gymSettings(gym);
  return {
    now: new Date(now).toISOString(),
    settings,
    token: !!upliftingToken(),
    syncedAt: gym?.syncedAt ?? null,
    syncError: gym?.syncError ?? null,
    plans: evaluateGym(gym, now).map((r) => ({
      id: r.plan.id,
      start: r.plan.start,
      startLabel: vancouverLabel(r.plan.start),
      graceMin: r.plan.graceMin,
      deadline: new Date(r.deadline).toISOString(),
      deadlineLabel: vancouverLabel(new Date(r.deadline).toISOString()),
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.plan.note ? { note: r.plan.note } : {}),
      log: r.plan.log,
    })),
    sessions: (gym?.sessions ?? []).slice(-20).map((s) => {
      const check = checkSession(gym!, s);
      return { ...s, counts: check.qualifies, ...(check.reason ? { reason: check.reason } : {}) };
    }),
    checkins: (gym?.checkins ?? []).slice(-20),
    pauses: gym?.pauses ?? [],
  };
}

type JsonBody = Record<string, unknown>;
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

async function gymRoute(request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.slice("/hygiene/gym".length);
  if (path === "" && request.method === "GET") return Response.json(gymReport());
  if (request.method !== "POST") return null;
  let body: JsonBody = {};
  try {
    const raw = await request.text();
    body = raw ? (JSON.parse(raw) as JsonBody) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return Response.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const by = text(body.by, 80);
  const note = text(body.note);

  // Wall times are read inside the locked mutation, after the state (and so the phone's zone
  // history) is reloaded: another proxy slot may have recorded a zone change since this one
  // last read the file. Parsing is checked up front only for the 400.
  const startError =
    'start is required: "YYYY-MM-DD HH:MM" in the phone zone, optionally followed by a zone name such as America/Vancouver, or ISO with an offset';
  const plan = async (make: () => PlanEdit | null) => {
    const result = await mutateGym((gym, now) => {
      const edit = make();
      const r = edit ? editPlan(gym, edit, now) : ({ ok: false, error: startError } as const);
      return { changed: r.ok, result: r };
    }, "gym plan changed");
    return Response.json(result, { status: result.ok ? 200 : 400 });
  };
  if (path === "/plans") {
    const raw = text(body.start, 90) ?? "";
    if (!parseStart(raw)) return Response.json({ error: startError }, { status: 400 });
    // Models often send null for an omitted optional: treat it as "use the default".
    const grace = typeof body.grace_min === "number" ? body.grace_min : body.grace_min == null ? undefined : NaN;
    return plan(() => {
      const start = parseStart(raw);
      return start ? { action: "add", start, graceMin: grace, note, by } : null;
    });
  }
  const edit = /^\/plans\/([A-Za-z0-9-]+)\/(move|cancel)$/.exec(path);
  if (edit) {
    if (edit[2] === "cancel") return plan(() => ({ action: "cancel", id: edit[1], note, by }));
    const raw = text(body.start, 90) ?? "";
    if (!parseStart(raw)) return Response.json({ error: startError }, { status: 400 });
    return plan(() => {
      const start = parseStart(raw);
      return start ? { action: "move", id: edit[1], start, note, by } : null;
    });
  }
  if (path === "/settings") {
    const grace = body.grace_min === undefined ? undefined : typeof body.grace_min === "number" ? body.grace_min : NaN;
    if (grace !== undefined && (!Number.isInteger(grace) || grace < 0 || grace > 360))
      return Response.json({ error: "grace_min must be a whole number of minutes, 0-360" }, { status: 400 });
    const proof = body.proof;
    if (proof !== undefined && proof !== "checkins" && proof !== "workout-tag")
      return Response.json({ error: 'proof must be "checkins" or "workout-tag"' }, { status: 400 });
    const tag = body.tag_pattern === undefined ? undefined : text(body.tag_pattern, 40);
    if (body.tag_pattern !== undefined && !tag) return Response.json({ error: "tag_pattern must be non-empty text" }, { status: 400 });
    if (grace === undefined && proof === undefined && tag === undefined)
      return Response.json({ error: "give grace_min, proof or tag_pattern" }, { status: 400 });
    const settings = await mutateGym((gym) => {
      gym.settings = {
        ...(gym.settings ?? {}),
        ...(grace !== undefined ? { graceMin: grace } : {}),
        ...(proof !== undefined ? { proof } : {}),
        ...(tag !== undefined ? { tagPattern: tag } : {}),
      };
      return { changed: true, result: gymSettings(gym) };
    }, "gym settings");
    return Response.json({ ok: true, settings, note: "applies to plans added from now on; existing plans keep the settings they were added with" });
  }
  if (path === "/pauses") {
    const rawFrom = text(body.from, 90) ?? "";
    const rawTo = text(body.to, 90) ?? "";
    const reason = text(body.reason) ?? "";
    if (!parseStart(rawFrom) || !parseStart(rawTo)) return Response.json({ error: "from and to (ISO times) are required" }, { status: 400 });
    const result = await mutateGym((gym, now) => {
      const r = addPause(gym, { from: parseStart(rawFrom) ?? "", to: parseStart(rawTo) ?? "", reason, by }, now);
      return { changed: r.ok, result: r };
    }, "gym pause");
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }
  const ending = /^\/pauses\/([A-Za-z0-9-]+)\/end$/.exec(path);
  if (ending) {
    const result = await mutateGym((gym, now) => {
      const r = endPause(gym, ending[1], now, by);
      return { changed: r.ok, result: r };
    }, "gym pause ended");
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }
  if (path === "/sync") {
    await syncGym(gymHost);
    return Response.json(gymReport());
  }
  // Hand credit for a session verified outside the gate (e.g. the first night,
  // before Uplifting reported locations). Kept off the MCP tool so a chat isn't
  // offered it; like every /hygiene route it is a trusted local route, not a
  // security boundary (the state file is editable too).
  if (path === "/sessions/credit") {
    const reason = text(body.reason, 300);
    const rawStart = String(body.start ?? "");
    const rawEnd = String(body.end ?? "");
    if (!by || !reason) return Response.json({ error: "by and reason are required" }, { status: 400 });
    const result = await mutateGym<{ error: string } | { session: Record<string, unknown> }>((gym, now) => {
      // Parsed under the lock, in the zone the reloaded state records (see plan above).
      const startMs = Date.parse(parseStart(rawStart) ?? "");
      const endMs = Date.parse(parseStart(rawEnd) ?? "");
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
        return { changed: false, result: { error: "start and end must be ISO times, end after start" } };
      if (endMs > now) return { changed: false, result: { error: "a credited session must already have ended" } };
      const id = text(body.workout_id, 80) ?? `manual:${gym.sessions.filter((s) => s.manual).length + 1}`;
      if (gym.sessions.some((s) => s.id === id)) gym.sessions = gym.sessions.filter((s) => s.id !== id);
      const s = {
        id,
        clientId: null,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        sets: Number.isFinite(Number(body.sets)) ? Number(body.sets) : 0,
        seenAt: new Date(now).toISOString(),
        manual: { by, reason },
      };
      gym.sessions.push(s);
      return { changed: true, result: { session: s } };
    }, "gym session credited");
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json({ ok: true, session: result.session });
  }
  return null;
}

export function gateStatus() {
  const now = deps.now();
  const disabled = gateDisabled();
  const state = loadState();
  const due = outstanding(state, now);
  const bypass = bypassActive(state, now);
  return {
    enabled: !disabled,
    armed: !disabled && due.length > 0 && !bypass,
    state: disabled ? "disabled" : due.length === 0 ? "clear" : bypass ? "bypassed" : "armed",
    now: new Date(now).toISOString(),
    zone: zoneAt(now),
    startsAt: state.startsAt,
    outstanding: due.map(({ slot, kind, label }) => ({ slot, kind, label })),
    dueToday: dueToday(state, now).map(({ slot, kind, label }) => ({ slot, kind, label })),
    bypass: { count: state.bypass.count, activeUntil: bypass ? state.bypass.until : null },
    delay: {
      active: delayActive(state, now),
      expires_at: delayActive(state, now) ? state.delay.until : null,
      count: state.delay.count,
    },
    // MOVE/LATER made today (local day), photos and gym plans (slot gym/<id>), oldest first;
    // each item moves at most MAX_MOVES_PER_DAY times a day.
    moves: allMoves(state).filter((m) => localTime(Date.parse(m.at)).day === localTime(now).day),
    maxMovesPerDay: MAX_MOVES_PER_DAY,
    suspensions: (state.suspensions ?? []).filter(s => !s.resolvedAt),
    cancellations: state.cancellations ?? {},
    openDebts: state.debts
      .filter((d) => d.status === "open" || d.status === "penance")
      .map(({ id, at, skipped, status, penance, source }) => ({ id, at, skipped, status, penance, source: source ?? "bypass" })),
    lastProofs: state.images
      .filter((r) => r.verdict === "accepted")
      .slice(-5)
      .map(({ at, kind, slot, reading }) => ({ at, kind, slot, ...(reading ? { reading } : {}) })),
    killSwitch: killSwitchPath(),
  };
}

/** A refused photo can be credited for the penance up to this long after it was sent. */
const PENANCE_CREDIT_MAX_AGE_MS = 24 * 3_600_000;

/**
 * Pays the open penance with a photo the gate already checked and refused, when that
 * refusal was the gate's own bug (Nov 4 01:23: a teeth photo for a teeth penance was
 * refused as "teeth isn't due"). Only the gate's stored verdict decides: the photo must
 * have been classified as the penance or as a kind the penance asks for, sent after the
 * penance was set, within 24 h, and never counted before. Rejected photos' bytes are not
 * kept, so this credits the record, not a re-run of the classifier. Logged on the record.
 */
export async function creditPenancePhoto(
  sha: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const by = typeof body.by === "string" ? body.by.trim().slice(0, 80) : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (!by || !reason) return { status: 400, body: { error: "by and reason are required" } };
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    const debt = state.debts.find((d) => d.status === "penance" && d.penance && !d.penance.paidAt);
    if (!debt?.penance) return { status: 409, body: { error: "no unpaid penance" } };
    if (state.images.some((r) => r.sha256 === sha && r.verdict === "accepted"))
      return { status: 409, body: { error: "that photo already counted for something" } };
    const record = [...state.images].reverse().find((r) => r.sha256 === sha && r.verdict === "rejected");
    if (!record) return { status: 404, body: { error: "no refused photo with that hash" } };
    const sent = Date.parse(record.at);
    if (!Number.isFinite(sent)) return { status: 409, body: { error: "that photo's record has no usable timestamp" } };
    if (now - sent > PENANCE_CREDIT_MAX_AGE_MS)
      return { status: 409, body: { error: "the photo is more than 24 hours old" } };
    if (sent < Date.parse(debt.penance.setAt))
      return { status: 409, body: { error: "the photo was sent before the penance was set" } };
    const fits =
      record.kind === "penance" || penanceProofKinds(debt.penance.description).includes(record.kind as ProofKind);
    if (!fits)
      return {
        status: 409,
        body: { error: `the photo was classified as ${record.kind ?? "nothing"}, which this penance does not ask for` },
      };
    // A photo refused as "not clear enough" was judged on its merits, not by the matcher bug.
    // Records from before confidences were stored can't show that, so they can't be credited.
    if (!((record.confidence ?? 0) >= MIN_CONFIDENCE))
      return { status: 409, body: { error: "the gate refused that photo as not clear enough (or kept no confidence), not as the wrong kind" } };
    const slot = `penance/${debt.id}`;
    const atNow = new Date(now).toISOString();
    record.verdict = "accepted";
    record.slot = slot;
    // Not `manual`: that would un-withhold the photo from any chat it was sent in.
    record.credited = { by, reason, at: atNow };
    // Paid now, not at the photo's time, so a shield tap made while the penance locked the gate
    // is still charged (shieldTapFree reads both).
    state.filled[slot] = atNow;
    debt.penance.paidAt = atNow;
    debt.status = "paid";
    // A photo first told to Bubble as rejected must be told as credited too.
    const credited = noticeEvent(record, null, state);
    if (credited) pendingNotices.set(state, [...(pendingNotices.get(state) ?? []), { ...credited, text: `${credited.text}, credited by ${by.slice(0, 40)}` }]);
    saveState(state);
    console.error(`hygiene-gate: penance ${debt.id} credited from photo ${sha.slice(0, 12)} by ${by}: ${reason.slice(0, 120)}`);
    release(state, now, "photo accepted");
    return { status: 200, body: { ok: true, debt: debt.id, slot, gate: gateStatus() } };
  });
}

export async function resolveDebt(
  id: string,
  body: {
    verdict?: unknown;
    reason?: unknown;
    penance?: unknown;
    reasonClass?: unknown;
    fixRef?: unknown;
    item?: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const debt = state.debts.find((d) => d.id === id);
    if (!debt) return { status: 404, body: { error: "no such debt" } };
    if (debt.status !== "open") return { status: 409, body: { error: `debt already ${debt.status}` } };
    if (body.reasonClass !== undefined && body.reasonClass !== "gate_fault" && body.reasonClass !== "other")
      return { status: 422, body: { error: "reasonClass must be gate_fault or other" } };
    let fixRef: FixRef | undefined;
    let item: string | undefined;
    if (body.verdict === "justified" && body.reasonClass === "gate_fault") {
      const ref = body.fixRef as { kind?: unknown; id?: unknown; eta?: unknown; task?: unknown } | null;
      if (
        !ref ||
        typeof ref !== "object" ||
        (ref.kind !== "q" && ref.kind !== "chat") ||
        typeof ref.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(ref.id)
      )
        return { status: 422, body: { error: "gate_fault requires fixRef: {kind:q,id} or {kind:chat,id,eta}" } };
      if (
        ref.kind === "chat" &&
        (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref.id) ||
          typeof ref.eta !== "string" ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(ref.eta) ||
          !(Date.parse(ref.eta) > deps.now()))
      )
        return { status: 422, body: { error: "chat fixRef requires a chat UUID and future ISO eta with offset" } };
      if (
        ref.kind === "chat" &&
        ref.task !== undefined &&
        (typeof ref.task !== "number" || !Number.isSafeInteger(ref.task) || ref.task < 1)
      )
        return { status: 422, body: { error: "chat fixRef.task must be a positive task-ledger record number" } };
      fixRef =
        ref.kind === "q"
          ? { kind: "q", id: ref.id }
          : {
              kind: "chat",
              id: ref.id,
              eta: ref.eta as string,
              ...(typeof ref.task === "number" ? { task: ref.task } : {}),
            };
      const repairStatus = deps.fixStatus(fixRef);
      if (repairStatus === "ambiguous")
        return {
          status: 422,
          body: { error: "chat fixRef has multiple open task-ledger records; supply fixRef.task to select the repair" },
        };
      if (repairStatus !== "open")
        return {
          status: 422,
          body: {
            error:
              "fixRef must identify an existing open q item or chat task-ledger record; missing, closed or unavailable records cannot track a repair",
          },
        };
      item = typeof body.item === "string" ? body.item : debt.items?.length === 1 ? debt.items[0] : undefined;
      if (
        !item ||
        !(RECURRING_ITEMS.some((key) => key === item) ||
          (item.startsWith("gym/") && state.gym?.plans.some(p => `gym/${p.id}` === item)) ||
          (item.startsWith("penance/") && state.debts.some(d => `penance/${d.id}` === item && (d.penance || d.history?.some(h => h.penance))))) ||
        (debt.itemsComplete !== false && debt.items?.length && !debt.items.includes(item))
      )
        return { status: 422, body: { error: "gate_fault requires item: a stable key from this debt's items" } };
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
    const now = new Date(deps.now()).toISOString();
    if (body.verdict === "justified") {
      Object.assign(debt, {
        status: "justified",
        reason,
        ruledAt: now,
        reasonClass: body.reasonClass,
        ...(fixRef ? { fixRef, item } : {}),
      });
    } else if (body.verdict === "unjustified") {
      const penance = typeof body.penance === "string" ? body.penance.trim() : "";
      if (!penance || penance.length > 200)
        return { status: 400, body: { error: "unjustified needs a penance description (1-200 chars)" } };
      Object.assign(debt, {
        status: "penance",
        reason,
        reasonClass: body.reasonClass,
        ruledAt: now,
        penance: { description: penance, setAt: now },
      });
    } else return { status: 400, body: { error: 'verdict must be "justified" or "unjustified"' } };
    if (
      fixRef &&
      item &&
      state.debts.some(
        (d) =>
          d.id !== id &&
          d.status === "justified" &&
          d.reasonClass === "gate_fault" &&
          d.item === item &&
          Date.parse(d.ruledAt ?? "") >= deps.now() - 86_400_000 &&
          Date.parse(d.ruledAt ?? "") <= deps.now(),
      ) &&
      !state.suspensions?.some((s) => s.item === item && !s.resolvedAt)
    ) {
      (state.suspensions ??= []).push({ item, at: now, debtId: id, fixRef });
    }
    saveState(state);
    release(state, deps.now(), "gate fault ruling");
    queueFaults(state);
    kickWakes();
    return { status: 200, body: { ok: true, debt } };
  });
}

/** Persist closed repairs and retry the durable, idempotently keyed owner notification. */
export async function refreshFaults(): Promise<void> {
  const view = loadState();
  const changed = JSON.stringify(view.suspensions) !== JSON.stringify(cache?.state.suspensions);
  if (!changed && !view.suspensions?.some((s) => !s.notificationQueuedAt || (s.repairStatus === "awaiting_receipt" && !s.receiptNoticeQueuedAt))) return;
  await serialized(async () => {
    const state = structuredClone(loadState());
    if (JSON.stringify(state.suspensions) !== JSON.stringify(cache?.state.suspensions)) saveState(state);
    queueFaults(state);
  });
}

const GATE_OWNER_THREAD = "1da90fc5-6b97-4945-9127-7e46e50c6a23";

function queueFaults(state: GateState): void {
  for (const s of state.suspensions ?? []) {
    for (const marker of ["notificationQueuedAt", "receiptNoticeQueuedAt"] as const) {
      const needsReceipt = marker === "receiptNoticeQueuedAt";
      if (s[marker] || (needsReceipt && s.repairStatus !== "awaiting_receipt")) continue;
      const key = `${s.item}/${s.debtId}/${s.at}${needsReceipt ? "/receipt" : ""}`;
      const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
      // Reuse the wake sender's validated id format; the fault-specific hash prevents unlock collisions.
      try {
        enqueueWake(statePath(), {
          id: `hygiene-unlock-${Date.parse(s.at)}-${hash}`,
          thread: GATE_OWNER_THREAD,
          at: new Date(deps.now()).toISOString(),
          text: needsReceipt
            ? `Gate repair ${JSON.stringify(s.fixRef)} is done but has no completion receipt. ${s.item} remains suspended (awaiting_receipt). Add the task-ledger receipt so the gate can close this repair.`
            : `Gate fault repeated within 24 h: ${s.item} was suspended at ${s.at}, pending repair ${JSON.stringify(s.fixRef)}. Debt: ${s.debtId}. Check current gate status before acting.`,
        });
        s[marker] = new Date(deps.now()).toISOString();
        saveState(state);
      } catch (error) {
        // The ruling already committed. Its missing queue marker lets the timer retry safely.
        delete s[marker];
        console.error("hygiene-gate: could not queue gate-fault notice:", (error as Error).message);
      }
    }
  }
}

/** A ruling can be revised toward leniency for this long after it was made. */
export const REVISE_WINDOW_MS = 12 * 3_600_000;

/**
 * Revise a ruling toward leniency only: an unpaid penance becomes justified, within 12 h of
 * the ruling, with a reason. The old verdict is kept in `history`, and the gate opens if the
 * penance was what held it. Nov 3: a ruling was withdrawn after new facts (sunrise 08:03, a
 * cough) but resolve refuses a ruled debt, so Alex stayed locked under it.
 */
export async function reviseDebt(
  id: string,
  body: { verdict?: unknown; reason?: unknown },
): Promise<{ status: number; body: unknown }> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const debt = state.debts.find((d) => d.id === id);
    if (!debt) return { status: 404, body: { error: "no such debt" } };
    if (body.verdict !== "justified")
      return { status: 400, body: { error: 'a revision can only be toward leniency: verdict must be "justified"' } };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason || reason.length > 300) return { status: 400, body: { error: "a revision needs a reason (1-300 chars)" } };
    if (debt.status !== "penance") return { status: 409, body: { error: `only a penance can be revised; debt is ${debt.status}` } };
    if (debt.penance?.paidAt) return { status: 409, body: { error: "the penance is already paid" } };
    const now = deps.now();
    const ruled = Date.parse(debt.ruledAt ?? "");
    if (!Number.isFinite(ruled) || now - ruled > REVISE_WINDOW_MS)
      return { status: 409, body: { error: "a ruling can only be revised within 12 h of it" } };
    const revisedAt = new Date(now).toISOString();
    (debt.history ??= []).push({
      status: debt.status,
      reasonClass: debt.reasonClass,
      reason: debt.reason,
      ruledAt: debt.ruledAt,
      penance: debt.penance,
      revisedAt,
    });
    debt.status = "justified";
    // A leniency revision is not a tracked fault ruling; do not inherit its prior classification.
    debt.reasonClass = "other";
    debt.reason = reason;
    debt.ruledAt = revisedAt;
    delete debt.penance;
    saveState(state);
    console.error(`hygiene-gate: debt ${id} revised to justified: ${reason.slice(0, 120)}`);
    release(state, now, "ruling revised");
    return { status: 200, body: { ok: true, debt } };
  });
}

/** /hygiene/* routes. Returns null for paths that are not ours. */
export async function handleHygieneRoute(request: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/hygiene/")) return null;
  const remote = remoteGate();
  if (remote) return passThrough(remote, request, url);
  if (url.pathname === "/hygiene/gym" || url.pathname.startsWith("/hygiene/gym/")) {
    const gym = await gymRoute(request, url);
    if (gym) return gym;
  }
  if (url.pathname === "/hygiene/status" && request.method === "GET") return Response.json(gateStatus());
  // The whole state, for proxies that follow this gate (hygiene-remote.ts). Local callers only.
  if (url.pathname === "/hygiene/state" && request.method === "GET") return Response.json(loadState());
  // Local-only like /state; retries use a stable source so a lost ACK cannot spend a proof twice.
  if (url.pathname === "/hygiene/recheck" && request.method === "POST") {
    let body: { url?: unknown; at?: unknown };
    try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
    if (typeof body?.url !== "string" || typeof body.at !== "number" || !Number.isFinite(body.at) || body.at < 0 || body.at > deps.now() + EXIF_FUTURE_SLACK_MS)
      return Response.json({ error: "invalid queued photo" }, { status: 400 });
    const photoUrl = body.url;
    const sentAt = body.at;
    return serialized(async () => {
      const state = structuredClone(loadState());
      const decoded = decodeDataUrl(photoUrl);
      // URL photos are not classified by the existing gate either.
      if (!decoded) return Response.json({ checked: true });
      const hash = sha256(decoded.bytes);
      // A follower timestamp is not evidence of freshness or entitlement to a past slot.
      const now = deps.now();
      const outcome = await checkImageRecorded(state, photoUrl, { thread: "outage", key: hash }, now);
      if (outcome.record && outcome.record.receivedAt === undefined && Math.abs(now - sentAt) <= 5 * 60_000)
        outcome.record.receivedAt = new Date(sentAt).toISOString();
      if (JSON.stringify(state) !== JSON.stringify(loadState())) saveState(state);
      if (outcome.record?.verdict === "accepted") release(state, now, "photo accepted");
      else if (outcome.gym) release(state, now, "gym photo");
      return Response.json({ checked: !outcome.retry });
    });
  }
  const cancellation = /^\/hygiene\/items\/([a-z-]+)\/cancel$/.exec(url.pathname);
  if (cancellation && request.method === "POST") {
    const item = cancellation[1];
    if (!RECURRING_ITEMS.some(key => key === item)) return Response.json({error:"unknown recurring item"},{status:404});
    let body: Record<string, unknown> | null;
    try { body = await request.json(); } catch { return Response.json({error:"body must be JSON"},{status:400}); }
    const reason = text(body?.reason,300);
    if (!reason) return Response.json({error:"reason is required"},{status:422});
    return serialized(async () => {
      const state = structuredClone(loadState());
      (state.cancellations ??= {})[item] ??= {at:new Date(deps.now()).toISOString(),reason};
      saveState(state);
      release(state,deps.now(),"item cancelled");
      return Response.json({ok:true,item,...state.cancellations[item]});
    });
  }
  const ruling = /^\/hygiene\/debt\/([A-Za-z0-9-]+)\/resolve$/.exec(url.pathname);
  // Pays the open penance with a photo the gate already saw and wrongly refused. Local route,
  // like /hygiene/debt; logged on the photo's record.
  const credit = /^\/hygiene\/images\/([0-9a-f]{64})\/credit-penance$/.exec(url.pathname);
  if (credit && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    const result = await creditPenancePhoto(credit[1], body);
    return Response.json(result.body, { status: result.status });
  }
  if (ruling && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({error:"body must be a JSON object"},{status:400});
    const result = await resolveDebt(ruling[1], body);
    return Response.json(result.body, { status: result.status });
  }
  const revision = /^\/hygiene\/debt\/([A-Za-z0-9-]+)\/revise$/.exec(url.pathname);
  if (revision && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "body must be a JSON object" }, { status: 400 });
    const result = await reviseDebt(revision[1], body);
    return Response.json(result.body, { status: result.status });
  }
  return null;
}

// ---- Direct submissions (Cairn) ----

export type SubmitResult = {
  result: "pass" | "fail";
  /** One line for the UI, same wording the chat lock uses. */
  message: string;
  verdict: ImageRecord["verdict"] | "not_due" | "error";
  slot: string | null;
  sha256: string;
  /** Accepted weigh-ins only: the scale reading as the classifier saw it. */
  reading?: string | null;
  /** Accepted weigh-ins only: the reading in pounds, null when it can't be parsed. */
  weight_lb?: number | null;
};

/**
 * Runs the chat checks (reuse, EXIF age, classifier) on a photo sent outside
 * a chat. Resending the same bytes returns the first verdict.
 */
export async function submitProof(image: { mediaType: string; bytes: Buffer }, target: ProofTarget): Promise<SubmitResult> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    const hash = sha256(image.bytes);
    const url = `data:${image.mediaType};base64,${image.bytes.toString("base64")}`;
    const outcome = await checkImageRecorded(state, url, { thread: "cairn", key: hash }, now, target);
    if (JSON.stringify(state) !== JSON.stringify(loadState())) saveState(state);
    const record = outcome.record;
    const pass = record?.verdict === "accepted";
    if (pass) release(state, now, "photo accepted");
    const weighIn = pass && record?.kind === "weight";
    return {
      result: pass ? "pass" : "fail",
      message: outcome.line ?? (record ? imageMarker(record, state) : "❌ photo could not be read."),
      verdict: record?.verdict ?? (outcome.line?.startsWith("⚠") ? "error" : "not_due"),
      slot: record?.slot ?? null,
      sha256: hash,
      ...(weighIn ? { reading: record.reading ?? null, weight_lb: parseWeightReading(record.reading) } : {}),
    };
  });
}

/** Accepted proofs grouped by local day, newest day first. */
export function proofDays(from: string, to: string) {
  const days = new Map<
    string,
    Array<{ sha256: string; kind: string; slot: string; at: string; manual: boolean; reading?: string }>
  >();
  for (const r of loadState().images) {
    if (r.verdict !== "accepted" || !r.slot || !r.file) continue;
    const day = localTime(Date.parse(r.at)).day;
    if (day < from || day > to) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push({
      sha256: r.sha256,
      kind: r.kind ?? "",
      slot: r.slot,
      at: r.at,
      manual: !!r.manual,
      ...(r.reading ? { reading: r.reading } : {}),
    });
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, photos]) => ({ day, photos }));
}

export function proofFile(hash: string): string | null {
  const record = loadState().images.find((r) => r.sha256 === hash && r.verdict === "accepted" && r.file);
  return record?.file ?? null;
}
