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
  zonedTime,
  type Debt,
  type GateState,
  type ImageRecord,
  type ProofKind,
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
  sha256,
  type Classifier,
} from "./hygiene-proof";
import { tryLock, unlock } from "./filelock";
import {
  checkSession,
  editPlan,
  emptyGym,
  evaluateGym,
  distanceM,
  gymPhotoWanted,
  recordGymPhoto,
  gymSettings,
  when as vancouverLabel,
  type GymState,
  type PlanEdit,
} from "./gym";
import { refreshIfDeciding, startGymSync, syncGym, upliftingToken, type GymSyncHost } from "./gym-sync";
import {
  flushWakes as flushWakeQueue,
  heldNoteText,
  holdMessage,
  photoChecking,
  releaseHeld,
  todayWake,
  wakesIdle,
  whileChecking,
  type WakeSender,
} from "./hygiene-wake";
import { relaySender, startPhoneWake, wakeFilePath, type PhoneWakeSender } from "./phone-wake";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

export type GateDeps = {
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
};

const defaults: GateDeps = {
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
};
let deps: GateDeps = { ...defaults };

/** For tests: swap the clock, classifier or hashers. */
export function setGateDeps(overrides: Partial<GateDeps>): void {
  deps = { ...defaults, ...overrides };
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
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.state;
  let state: GateState;
  if (mtimeMs < 0) state = emptyState(defaultStartsAt(deps.now()));
  else {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateState>;
    if (!raw || typeof raw !== "object") throw new Error("state file is not a JSON object");
    state = { ...emptyState(raw.startsAt ?? defaultStartsAt(deps.now())), ...raw } as GateState;
  }
  cache = { path, mtimeMs, state };
  return state;
}

const RETAIN_MS = 400 * 86_400_000;

function saveState(state: GateState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cutoff = deps.now() - RETAIN_MS;
  state.images = state.images.filter((image) => Date.parse(image.at) >= cutoff);
  state.bypass.history = state.bypass.history.filter((at) => Date.parse(at) >= cutoff);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  cache = { path, mtimeMs: statSync(path).mtimeMs, state };
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
export function flushWakes(): Promise<void> {
  return flushWakeQueue(statePath(), deps.wake, deps.now);
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
  const result = outcome.record || state.images.length === before ? outcome : { ...outcome, record: state.images.at(-1) };
  if (!gym) return result;
  let record = result.record;
  // Nothing hygiene-related was due (no record, no line, no retry): keep a record so the
  // photo can't later be passed off as a hygiene proof. A checker error stays retryable.
  if (!record && !result.line && !result.retry && gym.recorded) {
    record = {
      sha256: gym.hash,
      dhash: gym.dhash,
      at: new Date(now).toISOString(),
      source,
      kind: null,
      verdict: "unneeded",
      reason: "gym photo",
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
  // Gym photos' own records are left out: gym-to-gym near copies are judged by recordGymPhoto
  // within 12 h, so the same mirror and pose on another day still counts.
  const gymPhotos = new Set(state.gym.checkins.filter((c) => c.clientId.startsWith("photo:")).map((c) => c.clientId.slice(6)));
  const proofs = state.images.filter(
    (r) => (r.verdict === "accepted" || r.verdict === "unneeded") && !gymPhotos.has(r.sha256.slice(0, 16)),
  );
  // An exact copy of a hygiene proof is a replay, a near copy never counts (a photo already
  // recorded for the gym is not in `proofs`; recordGymPhoto calls its resend a replay).
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
  const proofs = state.images.filter((r) => r.verdict === "accepted" || r.verdict === "unneeded");
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
  const penance = state.debts.find((d) => d.status === "penance" && d.penance && !d.penance.paidAt);
  let verdict;
  try {
    verdict = await deps.classify(decoded, {
      kinds,
      penance: kinds.includes("penance") ? penance?.penance?.description : undefined,
    });
  } catch (error) {
    // Not recorded: the same photo can be retried once the checker works.
    console.error("hygiene-gate: classifier failed:", (error as Error).message);
    return { line: "⚠️ couldn't check the photo (classifier error). Send it again, or reply BYPASS.", retry: true };
  }
  record.kind = verdict.kind;
  record.reason = verdict.reason;
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
  if (!target) {
    state.images.push({ ...record, verdict: "unneeded" });
    return { line: null };
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
  return { line: `✅ ${slotLabel(target, state)} photo accepted${reading ? ` (${reading})` : ""}.` };
}

function bypassReply(state: GateState, now: number): string {
  if (bypassActive(state, now))
    return `🚪 bypass already open until ${clockLabel(Date.parse(state.bypass.until!))}.`;
  const due = outstanding(state, now);
  if (!due.length) return "✅ gate is already clear; no bypass used.";
  const at = new Date(now).toISOString();
  state.bypass.count += 1;
  state.bypass.until = new Date(now + BYPASS_MS).toISOString();
  state.bypass.history.push(at);
  const debt: Debt = {
    id: `${localTime(now).day}-${state.bypass.count}`,
    at,
    skipped: due.map((r) => r.label),
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
  if (state.debts.some((d) => after(d.penance?.paidAt))) return false;
  if (state.gym?.sessions.some((s) => after(s.seenAt))) return false;
  if (state.gym?.checkins.some((c) => after(c.receivedAt))) return false;
  if (state.delay.until && Date.parse(state.delay.until) - DELAY_MS > anchor) return false;
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
      const atTap = outstanding(atTapView(state), anchor).map((r) => r.label);
      const atReport = outstanding(state, now).map((r) => `at report: ${r.label}`);
      const skipped = atTap.length ? atTap : atReport.length ? atReport : ["a lock cleared after the tap"];
      state.debts.push({ id: debtId, at: new Date(anchor).toISOString(), skipped, status: "open" });
      if (until > now) {
        applied = true;
        state.bypass.count += 1;
        state.bypass.history.push(new Date(anchor).toISOString());
        const current = state.bypass.until ? Date.parse(state.bypass.until) : 0;
        if (until > current) state.bypass.until = new Date(until).toISOString();
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
  const photos = due.length > 1 ? "morning photos" : due[0]?.kind === "weight" ? "weigh-in photo" : "teeth photo";
  if (delayActive(state, now))
    return `⏰ delay already open until ${clockLabel(Date.parse(state.delay.until!))}. Send the morning photo when you can.`;
  if (!due.length) return "✅ gate is already clear; no delay used.";
  if (!morningOnly || minutes < MORNING_MINUTE || minutes >= DELAY_END_MINUTE)
    return "DELAY only postpones the morning photos (05:00 to 12:00). For anything else, send the photo or reply BYPASS.";
  if (state.delay.history.includes(day))
    return `DELAY was already used this morning. Send the ${photos}, or reply BYPASS.`;
  state.delay.count += 1;
  state.delay.until = new Date(now + DELAY_MS).toISOString();
  state.delay.day = day;
  state.delay.history.push(day);
  return `⏰ delay: gate open until ${clockLabel(now + DELAY_MS)}. Send the ${photos} before then.`;
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
  if (turn.images.length || turn.text === "BYPASS" || isDelayText(turn.text)) return null;
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

  if (turn.text === "BYPASS" && !turn.images.length) {
    const text = bypassReply(state, now);
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
    if (dirty) saveState(state);
    holdMessage(statePath(), {
      thread,
      machine: origin.machine,
      key: keys.get(turn.newest) ?? "",
      at: new Date(now).toISOString(),
      text: turn.text,
      attachments,
    });
    return { action: "respond", text: lockedText(due, lines) };
  }

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

  const plan = async (edit: PlanEdit) => {
    const result = await mutateGym((gym, now) => {
      const r = editPlan(gym, edit, now);
      return { changed: r.ok, result: r };
    }, "gym plan changed");
    return Response.json(result, { status: result.ok ? 200 : 400 });
  };
  if (path === "/plans") {
    const start = text(body.start, 40);
    if (!start) return Response.json({ error: "start (ISO time) is required" }, { status: 400 });
    // Models often send null for an omitted optional: treat it as "use the default".
    const grace = typeof body.grace_min === "number" ? body.grace_min : body.grace_min == null ? undefined : NaN;
    return plan({ action: "add", start, graceMin: grace, note, by });
  }
  const edit = /^\/plans\/([A-Za-z0-9-]+)\/(move|cancel)$/.exec(path);
  if (edit) {
    if (edit[2] === "cancel") return plan({ action: "cancel", id: edit[1], note, by });
    const start = text(body.start, 40);
    if (!start) return Response.json({ error: "start (ISO time) is required" }, { status: 400 });
    return plan({ action: "move", id: edit[1], start, note, by });
  }
  if (path === "/settings") {
    const grace = typeof body.grace_min === "number" ? body.grace_min : NaN;
    if (!Number.isInteger(grace) || grace < 0 || grace > 360)
      return Response.json({ error: "grace_min must be a whole number of minutes, 0-360" }, { status: 400 });
    const settings = await mutateGym((gym) => {
      gym.settings = { ...(gym.settings ?? {}), graceMin: grace };
      return { changed: true, result: gymSettings(gym) };
    }, "gym settings");
    return Response.json({ ok: true, settings, note: "applies to plans added from now on" });
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
    const startMs = Date.parse(String(body.start));
    const endMs = Date.parse(String(body.end));
    if (!by || !reason) return Response.json({ error: "by and reason are required" }, { status: 400 });
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
      return Response.json({ error: "start and end must be ISO times, end after start" }, { status: 400 });
    if (endMs > deps.now()) return Response.json({ error: "a credited session must already have ended" }, { status: 400 });
    const session = await mutateGym((gym, now) => {
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
      return { changed: true, result: s };
    }, "gym session credited");
    return Response.json({ ok: true, session });
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
    startsAt: state.startsAt,
    outstanding: due.map(({ slot, kind, label }) => ({ slot, kind, label })),
    dueToday: dueToday(state, now).map(({ slot, kind, label }) => ({ slot, kind, label })),
    bypass: { count: state.bypass.count, activeUntil: bypass ? state.bypass.until : null },
    delay: {
      active: delayActive(state, now),
      expires_at: delayActive(state, now) ? state.delay.until : null,
      count: state.delay.count,
    },
    openDebts: state.debts
      .filter((d) => d.status === "open" || d.status === "penance")
      .map(({ id, at, skipped, status, penance }) => ({ id, at, skipped, status, penance })),
    lastProofs: state.images
      .filter((r) => r.verdict === "accepted")
      .slice(-5)
      .map(({ at, kind, slot, reading }) => ({ at, kind, slot, ...(reading ? { reading } : {}) })),
    killSwitch: killSwitchPath(),
  };
}

export async function resolveDebt(
  id: string,
  body: { verdict?: unknown; reason?: unknown; penance?: unknown },
): Promise<{ status: number; body: unknown }> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const debt = state.debts.find((d) => d.id === id);
    if (!debt) return { status: 404, body: { error: "no such debt" } };
    if (debt.status !== "open") return { status: 409, body: { error: `debt already ${debt.status}` } };
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
    const now = new Date(deps.now()).toISOString();
    if (body.verdict === "justified") {
      Object.assign(debt, { status: "justified", reason, ruledAt: now });
    } else if (body.verdict === "unjustified") {
      const penance = typeof body.penance === "string" ? body.penance.trim() : "";
      if (!penance || penance.length > 200)
        return { status: 400, body: { error: "unjustified needs a penance description (1-200 chars)" } };
      Object.assign(debt, { status: "penance", reason, ruledAt: now, penance: { description: penance, setAt: now } });
    } else return { status: 400, body: { error: 'verdict must be "justified" or "unjustified"' } };
    saveState(state);
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
  const ruling = /^\/hygiene\/debt\/([A-Za-z0-9-]+)\/resolve$/.exec(url.pathname);
  if (ruling && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    const result = await resolveDebt(ruling[1], body);
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
