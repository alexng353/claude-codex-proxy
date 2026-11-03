/**
 * Gym sessions on the hygiene gate: the pure half. Alex plans sessions (an
 * agent adds, moves or cancels them for him); Uplifting, his own lifting app,
 * reports where his phone was when he tapped Start and Finish and the finished
 * workout. A plan with no Start at the gym by its start plus a grace locks the
 * gate, like an overdue shower. A qualifying session clears it. Clock and
 * Vancouver days come from hygiene.ts (src/zone.ts, never Intl).
 *
 * Decided by Alex 2026-11-02 04:04-04:05: send the location, plans come from
 * him, lock on the schedule, enforce from today.
 */
import { clockLabel, inTransit, localTime, zoneNote } from "./hygiene";

export type GymPlanEvent = {
  at: string;
  action: "add" | "move" | "cancel";
  /** Start before a move. */
  from?: string;
  /** Start after an add or move. */
  to?: string;
  /** Who asked, e.g. the calling chat or "cli". */
  by?: string;
  note?: string;
};

export type GymPlan = {
  id: string;
  /** Planned start, ISO. */
  start: string;
  graceMin: number;
  status: "planned" | "cancelled";
  createdAt: string;
  note?: string;
  log: GymPlanEvent[];
  /** Frozen outcome of a long-settled plan, so pruning its session can't reopen it. */
  settled?: { status: "kept" | "made-up"; sessionId: string; at: string };
};

/** A finished Uplifting workout as the gate first saw it; later edits never change it. */
export type GymSession = {
  /** Uplifting workout id, or `manual:<n>` for a hand-credited session. */
  id: string;
  /** The phone's own workout id, which check-ins carry. */
  clientId: string | null;
  start: string;
  end: string;
  sets: number;
  seenAt: string;
  /** Credited by hand (verified outside the gate), e.g. the first night. */
  manual?: { by: string; reason: string };
  /** The gym Uplifting tagged the workout with (a gym name, never coordinates). */
  gymTag?: string;
};

/** Where the phone was when Alex tapped Start or Finish. Distance only; no coordinates kept. */
export type GymCheckin = {
  clientId: string;
  kind: "start" | "finish";
  at: string;
  /** Metres from the gym, or null when the phone had no fix. */
  distanceM: number | null;
  accuracyM: number | null;
  receivedAt: string;
  /** Gym photos only: the photo's difference hash (not a location), so a near copy earns nothing. */
  dhash?: string;
};

/**
 * A stretch with no gym gate (Alex, 2026-11-02: Jakarta Nov 14 to Dec 3, no
 * Gold's there). Plans can't start inside it and nothing gym-related locks
 * while it runs. `from`/`to` are instants; `to` is exclusive.
 */
export type GymPause = {
  id: string;
  from: string;
  to: string;
  reason: string;
  at: string;
  by?: string;
  /** Ended early: `to` was moved to this time. */
  endedAt?: string;
};

export type GymSettings = {
  graceMin: number;
  minMinutes: number;
  minSets: number;
  /** A Start with no Finish after this long is a miss. */
  maxOpenMin: number;
  /** A session may start this long before the plan and still keep it. */
  earlyMin: number;
  /** A fix less precise than this (iOS reports kilometres with Precise Location off) counts as no location. */
  maxAccuracyM: number;
  /**
   * How a session proves it was at the gym. "checkins": Uplifting's Start and
   * Finish locations (or a gym photo). "workout-tag": while Alex's phone runs
   * an Uplifting build that sends no check-ins (2026-11-02), a workout tagged
   * with a gym matching `tagPattern` counts, and a plan is missed only once
   * start + grace + maxOpenMin has passed with no such workout, so a missing
   * Start can't lock him mid-workout.
   */
  proof: "checkins" | "workout-tag";
  /** Case-insensitive text a workout's gym tag must contain in workout-tag mode. */
  tagPattern: string;
  gym: { name: string; lat: number; lon: number; radiusM: number };
};

export type GymState = {
  settings?: Partial<GymSettings>;
  plans: GymPlan[];
  sessions: GymSession[];
  checkins: GymCheckin[];
  pauses?: GymPause[];
  /** Last successful Uplifting read, and the last error since. */
  syncedAt?: string;
  syncError?: string;
  /** Start of the newest read applied, success or failure; an older read finishing late only merges. */
  readAt?: string;
};

/**
 * Gold's Gym West Broadway, 709 W Broadway. Midpoint of Gold's own listing
 * (49.2634192, -123.1208006) and the OpenStreetMap node (49.2634992,
 * -123.1202840), 38 m apart, both checked 2026-11-02. 150 m covers both and
 * indoor GPS error without reaching across the next blocks.
 */
export const DEFAULT_GYM_SETTINGS: GymSettings = {
  graceMin: 30,
  minMinutes: 45,
  minSets: 6,
  maxOpenMin: 4 * 60,
  earlyMin: 3 * 60,
  maxAccuracyM: 500,
  proof: "checkins",
  tagPattern: "gold",
  gym: { name: "Gold's Gym West Broadway", lat: 49.26346, lon: -123.12054, radiusM: 150 },
};

export const emptyGym = (): GymState => ({ plans: [], sessions: [], checkins: [] });

export function gymSettings(gym: GymState | undefined): GymSettings {
  const s = gym?.settings ?? {};
  return { ...DEFAULT_GYM_SETTINGS, ...s, gym: { ...DEFAULT_GYM_SETTINGS.gym, ...(s.gym ?? {}) } };
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const MIN = 60_000;
const ms = (iso: string) => Date.parse(iso);

export type PlanStatus =
  /** Before its deadline with nothing recorded yet. */
  | "upcoming"
  /** Started at the gym in time; the Finish has not arrived. */
  | "in-progress"
  | "kept"
  | "missed"
  /** Missed, then cleared by a later qualifying session. */
  | "made-up"
  | "cancelled"
  /** Starts inside a travel pause: never a miss. */
  | "paused";

export type PlanResult = {
  plan: GymPlan;
  status: PlanStatus;
  deadline: number;
  /** Why a missed plan was missed. */
  reason?: string;
  /** When a missed plan failed: its deadline, or the end of an unfinished Start's hours. */
  failedAt?: number;
  /** The session that kept or made up the plan. */
  sessionId?: string;
};

export type SessionCheck = { session: GymSession; qualifies: boolean; reason?: string };

/**
 * Gym photos (Alex, 2026-11-02: a geotagged photo at Gold's plus the Uplifting
 * log counts if Uplifting's location fails). A photo sent to the gate with a
 * fresh camera time and GPS inside the gym radius is stored as a Start
 * check-in with this client id prefix: distance only, never coordinates.
 */
export const PHOTO_PREFIX = "photo:";
const isPhoto = (c: GymCheckin) => c.clientId.startsWith(PHOTO_PREFIX);
/** A gym photo taken up to this long before a session starts can stand in for it. */
const PHOTO_SLACK_MS = 15 * MIN;
/** Near copies are looked for among gym photos taken within this of each other. */
const NEAR_WINDOW_MS = 12 * 60 * MIN;

/** Which session each gym photo belongs to: at most one each way. */
export type PhotoMatch = { bySession: Map<string, GymCheckin>; byPhoto: Map<string, GymSession> };

/**
 * The one rule for tying gym photos to sessions, used by both checkSession
 * and evaluateGym. Only a session that needs a photo can take one: it lacks
 * an Uplifting location, otherwise qualifies (time, sets, no far location)
 * and is no longer than maxOpenMin. Photos go oldest first; each takes one
 * such session not taken yet, preferring one that contains it, else one
 * starting within PHOTO_SLACK_MS after it (earliest start, then id). A
 * session that ended before the photo never gets it.
 */
export function matchPhotos(gym: GymState): PhotoMatch {
  const s = gymSettings(gym);
  const bySession = new Map<string, GymCheckin>();
  const byPhoto = new Map<string, GymSession>();
  const photos = gym.checkins.filter((c) => isPhoto(c) && atGym(gym, c)).sort((a, b) => ms(a.at) - ms(b.at));
  const sessions = gym.sessions
    .filter((x) => {
      if (x.manual || ms(x.end) - ms(x.start) > s.maxOpenMin * MIN) return false;
      const base = baseCheck(gym, x);
      return base.ok && base.needsPhoto !== null;
    })
    .sort((a, b) => ms(a.start) - ms(b.start) || a.id.localeCompare(b.id));
  for (const photo of photos) {
    const at = ms(photo.at);
    const free = sessions.filter((x) => !bySession.has(x.id));
    const pick =
      free.find((x) => ms(x.start) <= at && at <= ms(x.end)) ??
      free.find((x) => at < ms(x.start) && ms(x.start) - at <= PHOTO_SLACK_MS);
    if (!pick) continue;
    bySession.set(pick.id, photo);
    byPhoto.set(photo.clientId, pick);
  }
  return { bySession, byPhoto };
}

/** Finished sessions a gym photo was taken during (or just before), earliest first. */
function sessionsAround(gym: GymState, photo: GymCheckin): GymSession[] {
  const at = ms(photo.at);
  return [...gym.sessions]
    .sort((a, b) => ms(a.start) - ms(b.start) || a.id.localeCompare(b.id))
    .filter((x) => ms(x.start) - PHOTO_SLACK_MS <= at && at <= ms(x.end));
}

/** Everything about a session except the photo: fails with a reason, or passes, maybe needing a photo for a missing location. */
function baseCheck(
  gym: GymState,
  session: GymSession,
): { ok: false; reason: string } | { ok: true; needsPhoto: "start" | "finish" | null; approxM?: number } {
  const s = gymSettings(gym);
  const minutes = (ms(session.end) - ms(session.start)) / MIN;
  if (!(minutes >= s.minMinutes)) return { ok: false, reason: `${Math.round(minutes)} min, under ${s.minMinutes}` };
  if (session.sets < s.minSets) return { ok: false, reason: `${session.sets} sets, under ${s.minSets}` };
  const kinds = ["start", "finish"] as const;
  const fixes = kinds.map((kind) => (session.clientId ? checkinFor(gym, session.clientId, kind) : undefined));
  // Uplifting's own evidence of being away always wins, whichever end it is: the whole
  // uncertainty circle of the fix lies outside the gym.
  for (const [i, fix] of fixes.entries())
    if (fix && readFix(gym, fix) === "away")
      return { ok: false, reason: `${Math.round(fix.distanceM!)} m from the gym at ${kinds[i]}` };
  // No fix, or one too approximate to tell (Precise Location off): a gym photo has to stand in.
  const missing = kinds.findIndex((_, i) => !fixes[i] || readFix(gym, fixes[i]!) === "unknown");
  if (missing < 0) return { ok: true, needsPhoto: null };
  const approx = fixes[missing]?.distanceM != null ? fixes[missing]!.accuracyM : null;
  return { ok: true, needsPhoto: kinds[missing], ...(approx != null ? { approxM: approx } : {}) };
}

/** Whether a finished session counts, and why not when it doesn't. */
export function checkSession(gym: GymState, session: GymSession, photos: PhotoMatch = matchPhotos(gym)): SessionCheck {
  if (session.manual) return { session, qualifies: true };
  const base = baseCheck(gym, session);
  if (!base.ok) return { session, qualifies: false, reason: base.reason };
  // No location from Uplifting (an old build, GPS off): this session's gym photo stands in.
  const s = gymSettings(gym);
  // Workout-tag mode: the old Uplifting build sends no check-ins; its gym tag stands in.
  if (base.needsPhoto && s.proof === "workout-tag" && tagMatches(s, session.gymTag)) return { session, qualifies: true };
  if (base.needsPhoto && !photos.bySession.has(session.id))
    return {
      session,
      qualifies: false,
      reason:
        base.approxM != null
          ? `location too approximate at ${base.needsPhoto} (within ${Math.round(base.approxM)} m; turn on Precise Location for Uplifting, or send a gym photo)`
          : s.proof === "workout-tag"
            ? `not tagged at the gym in Uplifting (tag: ${session.gymTag ?? "none"})`
            : `no location at ${base.needsPhoto}`,
    };
  return { session, qualifies: true };
}

export const tagMatches = (s: GymSettings, tag: string | undefined) =>
  !!tag && !!s.tagPattern && tag.toLowerCase().includes(s.tagPattern.toLowerCase());

function checkinFor(gym: GymState, clientId: string, kind: "start" | "finish"): GymCheckin | undefined {
  return gym.checkins.find((c) => c.clientId === clientId && c.kind === kind);
}

/**
 * What a fix says: at the gym (inside the radius and precise enough), away
 * (its whole uncertainty circle outside the radius), or unknown (no fix, or
 * too approximate to tell; iOS with Precise Location off reports a fix blurred
 * by kilometres). A fix with no reported accuracy is taken as exact.
 */
export function readFix(gym: GymState, c: GymCheckin): "at" | "away" | "unknown" {
  if (c.distanceM === null) return "unknown";
  const s = gymSettings(gym);
  const accuracy = c.accuracyM ?? 0;
  if (c.distanceM <= s.gym.radiusM && accuracy <= s.maxAccuracyM) return "at";
  if (c.distanceM - accuracy > s.gym.radiusM) return "away";
  return "unknown";
}

const atGym = (gym: GymState, c: GymCheckin) => readFix(gym, c) === "at";

/** When the plan last took its current start (its add or latest move). */
function plannedAt(plan: GymPlan): number {
  const edit = [...plan.log].reverse().find((e) => e.action === "add" || e.action === "move");
  return edit ? ms(edit.at) : ms(plan.createdAt);
}

/**
 * Every plan's status at `now`, oldest first. A session keeps at most one
 * plan. A plan is kept by a qualifying session that starts between `earlyMin`
 * before it and its deadline; a Start at the gym in that window holds it open
 * until the Finish arrives (or `maxOpenMin` passes), even if the plan was made
 * mid-workout. Missed plans are then made up (those still locking first, newest first; then lapsed ones, oldest first) by unused
 * qualifying sessions that started after the plan's window opened. Either way
 * a session counts only if it ended after the plan was made or last moved, so
 * a plan added after a workout can't be cleared by it. Keeping comes before
 * making up: a plan made mid-workout keeps that session, and an older miss
 * waits for the next one (exactly one of them stays missed either way). A
 * cancel recorded after the planned start changes nothing: the plan stands,
 * so skipping it is a miss.
 *
 * A miss needs evidence: a read of Uplifting from after the moment the plan
 * failed (its deadline, or the end of an unfinished Start's 4 hours). Without
 * one the plan waits. `gymOutstanding` also refuses to lock on a stale read.
 */
export function evaluateGym(gym: GymState | undefined, now: number): PlanResult[] {
  if (!gym) return [];
  const s = gymSettings(gym);
  const photos = matchPhotos(gym);
  const checks = gym.sessions.map((session) => checkSession(gym, session, photos));
  const used = new Set<string>();
  const finishedClients = new Map(gym.sessions.filter((x) => x.clientId).map((x) => [x.clientId!, x]));
  const plans = [...gym.plans].sort((a, b) => ms(a.start) - ms(b.start));
  const results: PlanResult[] = [];
  // The finished session a Start belongs to: by client id; for a gym photo, the session it backs,
  // else any finished session it was taken during (a second photo of one workout is not an open Start).
  // A photo inside a finished session is finished with it, except inside a warm-up (too short or
  // too few sets): then the real workout may still be running, so the photo can still hold the plan.
  const warmUp = (x: GymSession) => (ms(x.end) - ms(x.start)) / MIN < s.minMinutes || x.sets < s.minSets;
  const sessionFor = (c: GymCheckin) => {
    if (finishedClients.has(c.clientId)) return finishedClients.get(c.clientId);
    if (!isPhoto(c)) return undefined;
    // The first real (non-warm-up) workout around it, so an earlier warm-up can't hide it.
    return photos.byPhoto.get(c.clientId) ?? sessionsAround(gym, c).find((x) => !warmUp(x));
  };

  for (const plan of plans) {
    const start = ms(plan.start);
    const deadline = start + plan.graceMin * MIN;
    if (plan.settled) {
      used.add(plan.settled.sessionId);
      results.push({ plan, status: plan.settled.status, deadline, sessionId: plan.settled.sessionId });
      continue;
    }
    if (plan.status === "cancelled" && !cancelledLate(plan)) {
      results.push({ plan, status: "cancelled", deadline });
      continue;
    }
    if (pauseAt(gym, start)) {
      results.push({ plan, status: "paused", deadline });
      continue;
    }
    const opens = start - s.earlyMin * MIN;
    const inWindow = (iso: string) => ms(iso) >= opens && ms(iso) <= deadline;
    const madeAt = plannedAt(plan);
    const keeper = checks.find(
      (c) => c.qualifies && !used.has(c.session.id) && inWindow(c.session.start) && ms(c.session.end) >= madeAt,
    );
    if (keeper) {
      used.add(keeper.session.id);
      results.push({ plan, status: "kept", deadline, sessionId: keeper.session.id });
      continue;
    }
    const started = gym.checkins
      .filter((c) => c.kind === "start" && atGym(gym, c) && inWindow(c.at) && ms(c.at) <= now)
      .sort((a, b) => ms(a.at) - ms(b.at));
    const unfinished = started.filter((c) => !sessionFor(c));
    const open = unfinished.find((c) => now < ms(c.at) + s.maxOpenMin * MIN);
    if (open) {
      results.push({ plan, status: "in-progress", deadline });
      continue;
    }
    // Evidence of a miss: a read from after the moment the plan failed.
    // Workout-tag mode has no Start to see, so the workout gets maxOpenMin to finish and sync.
    const failedAt = Math.max(
      s.proof === "workout-tag" ? deadline + s.maxOpenMin * MIN : deadline,
      ...unfinished.map((c) => ms(c.at) + s.maxOpenMin * MIN),
    );
    if (now < failedAt || !(gym.syncedAt && ms(gym.syncedAt) >= failedAt)) {
      results.push({ plan, status: "upcoming", deadline });
      continue;
    }
    // For the reason only: a photo inside just a warm-up names that warm-up.
    const failed = started.map((c) => sessionFor(c) ?? (isPhoto(c) ? sessionsAround(gym, c)[0] : undefined)).find(Boolean);
    const failedCheck = failed && checks.find((c) => c.session.id === failed.id);
    // Also for the reason: a workout in the window that didn't count (too approximate, away, untagged).
    const inWindowFail = checks.find((c) => !c.qualifies && !c.session.manual && inWindow(c.session.start));
    const reason = failed
      ? failedCheck?.qualifies
        ? ms(failed.end) < madeAt
          ? `session ended ${clockLabel(ms(failed.end))}, before this plan was made`
          : "that session already counted for another plan"
        : `session didn't count: ${failedCheck?.reason ?? "did not qualify"}`
      : started.length
        ? "started, never finished"
        : inWindowFail
          ? `session didn't count: ${inWindowFail.reason ?? "did not qualify"}`
          : s.proof === "workout-tag"
            ? `no workout tagged at the gym starting by ${clockLabel(deadline)}`
            : `no Start at the gym by ${clockLabel(deadline)}`;
    results.push({ plan, status: "missed", deadline, reason, failedAt });
  }

  // Make-ups go first to misses that still lock (newest first), then to lapsed ones (oldest first),
  // so a session always clears a live lock when one exists.
  const misses = results
    .filter((r) => r.status === "missed")
    .sort((a, b) =>
      missLocks(a, now) !== missLocks(b, now)
        ? missLocks(a, now)
          ? -1
          : 1
        : missLocks(a, now)
          ? ms(b.plan.start) - ms(a.plan.start)
          : ms(a.plan.start) - ms(b.plan.start),
    );
  for (const result of misses) {
    const opens = ms(result.plan.start) - s.earlyMin * MIN;
    const madeAt = plannedAt(result.plan);
    const makeup = checks
      .filter(
        (c) =>
          c.qualifies &&
          !used.has(c.session.id) &&
          ms(c.session.start) >= opens &&
          ms(c.session.end) >= madeAt &&
          ms(c.session.start) <= now,
      )
      .sort((a, b) => ms(a.session.start) - ms(b.session.start))[0];
    if (!makeup) continue;
    used.add(makeup.session.id);
    result.status = "made-up";
    result.sessionId = makeup.session.id;
  }
  return results;
}

/** A cancel recorded at or after the planned start. */
export function cancelledLate(plan: GymPlan): boolean {
  const cancel = [...plan.log].reverse().find((e) => e.action === "cancel");
  return !!cancel && ms(cancel.at) >= ms(plan.start);
}

/** Vancouver label for a time, e.g. "Thu, Nov 5 18:00". */
export const when = (iso: string) => {
  const at = ms(iso);
  const { day } = localTime(at);
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const zone = zoneNote(at);
  return `${date} ${clockLabel(at)}${zone ? ` ${zone}` : ""}`;
};

export type GymRequirement = { slot: string; kind: "gym"; label: string };

export const gymSlot = (planId: string) => `gym/${planId}`;

/** Polls run every 2 minutes; a read older than this can't lock the gate. */
export const FRESH_READ_MS = 10 * MIN;
/** A miss locks the gate for at most this long after it failed (Alex, 2026-11-02); it stays missed and can still be made up. */
export const LOCK_MAX_MS = 24 * 60 * MIN;
export const missLocks = (r: PlanResult, now: number) => now < (r.failedAt ?? r.deadline) + LOCK_MAX_MS;

/**
 * Missed plans not yet made up: these lock the gate, but only on a fresh,
 * successful read of Uplifting. A failed or stale read fails open for the gym
 * (a make-up could have happened since), never for the photo checks.
 */
export function gymOutstanding(gym: GymState | undefined, now: number): GymRequirement[] {
  if (!gym?.syncedAt || gym.syncError || now - ms(gym.syncedAt) > FRESH_READ_MS) return [];
  // During a travel pause nothing gym-related locks, except a miss that was already locking
  // when the pause was made: a pause is for travel, not a way out of a live lock.
  const pause = pauseAt(gym, now);
  return evaluateGym(gym, now)
    // A plan whose deadline fell on a travel day (a zone change) doesn't lock either.
    .filter(
      (r) =>
        r.status === "missed" &&
        missLocks(r, now) &&
        !inTransit(r.deadline) &&
        (!pause || (r.failedAt ?? r.deadline) <= ms(pause.at)),
    )
    .map((r) => ({
      slot: gymSlot(r.plan.id),
      kind: "gym" as const,
      label: `gym session planned ${when(r.plan.start)} (${r.reason})`,
    }));
}

/** Plans starting today, or in progress, that don't lock yet. */
export function gymDueToday(gym: GymState | undefined, now: number): GymRequirement[] {
  const today = localTime(now).day;
  return evaluateGym(gym, now)
    .filter(
      (r) =>
        r.status === "in-progress" ||
        (r.status === "upcoming" && localTime(ms(r.plan.start)).day === today),
    )
    .map((r) => ({
      slot: gymSlot(r.plan.id),
      kind: "gym" as const,
      label:
        r.status === "in-progress"
          ? "gym session in progress (tap Finish in Uplifting)"
          : now >= r.deadline
            ? `gym session at ${clockLabel(ms(r.plan.start))} (checking Uplifting)`
            : `gym session at ${clockLabel(ms(r.plan.start))} (tap Start in Uplifting at the gym by ${clockLabel(r.deadline)})`,
    }));
}

// ---- Plan edits ----

export type PlanEdit =
  | { action: "add"; start: string; graceMin?: number; note?: string; by?: string }
  | { action: "move"; id: string; start: string; by?: string; note?: string }
  | { action: "cancel"; id: string; by?: string; note?: string };

export type PlanEditResult = { ok: true; plan: GymPlan; message: string } | { ok: false; error: string };

const MAX_GRACE_MIN = 6 * 60;

/** Applies one edit to `gym` in place. Times are ISO strings; ids are short and stable. */
export function editPlan(gym: GymState, edit: PlanEdit, now: number): PlanEditResult {
  const nowIso = new Date(now).toISOString();
  const note = edit.note?.slice(0, 200);
  if (edit.action === "add") {
    const start = Date.parse(edit.start);
    if (!Number.isFinite(start)) return { ok: false, error: "start must be an ISO time" };
    if (start <= now) return { ok: false, error: "start must be in the future" };
    const paused = pauseAt(gym, start);
    if (paused) return { ok: false, error: pausedError(paused) };
    const grace = edit.graceMin ?? gymSettings(gym).graceMin;
    if (!Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_MIN)
      return { ok: false, error: `grace must be a whole number of minutes, 0-${MAX_GRACE_MIN}` };
    const iso = new Date(start).toISOString();
    const plan: GymPlan = {
      id: nextId(gym, start),
      start: iso,
      graceMin: grace,
      status: "planned",
      createdAt: nowIso,
      ...(note ? { note } : {}),
      log: [{ at: nowIso, action: "add", to: iso, ...(edit.by ? { by: edit.by } : {}), ...(note ? { note } : {}) }],
    };
    gym.plans.push(plan);
    return { ok: true, plan, message: `planned ${when(plan.start)}, start by ${clockLabel(start + grace * MIN)}` };
  }
  const plan = gym.plans.find((p) => p.id === edit.id);
  if (!plan) return { ok: false, error: `no plan ${edit.id}` };
  if (plan.status === "cancelled") return { ok: false, error: `plan ${edit.id} is already cancelled` };
  const started = now >= ms(plan.start);
  const by = edit.by ? { by: edit.by } : {};
  if (edit.action === "move") {
    if (started)
      return { ok: false, error: "this plan has already started, so it can't move. Cancel it (that counts as a miss) and add a new one." };
    const start = Date.parse(edit.start);
    if (!Number.isFinite(start)) return { ok: false, error: "start must be an ISO time" };
    if (start <= now) return { ok: false, error: "start must be in the future" };
    const paused = pauseAt(gym, start);
    if (paused) return { ok: false, error: pausedError(paused) };
    const iso = new Date(start).toISOString();
    plan.log.push({ at: nowIso, action: "move", from: plan.start, to: iso, ...by, ...(note ? { note } : {}) });
    plan.start = iso;
    return { ok: true, plan, message: `moved to ${when(plan.start)}, start by ${clockLabel(start + plan.graceMin * MIN)}` };
  }
  plan.status = "cancelled";
  plan.log.push({ at: nowIso, action: "cancel", ...by, ...(note ? { note } : {}) });
  return {
    ok: true,
    plan,
    message: started
      ? "cancelled after its start: it still counts as a miss unless a session is logged"
      : `cancelled ${when(plan.start)}`,
  };
}

function nextId(gym: GymState, start: number): string {
  const base = localTime(start).day;
  let n = 1;
  while (gym.plans.some((p) => p.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---- Travel pauses ----

/** The pause running at `at`, if any. */
export function pauseAt(gym: GymState | undefined, at: number): GymPause | undefined {
  return gym?.pauses?.find((p) => ms(p.from) <= at && at < ms(p.to));
}

const pauseLabel = (p: GymPause) => `${p.id} (${when(p.from)} to ${when(p.to)}: ${p.reason})`;
const pausedError = (p: GymPause) => `that time is inside the travel pause ${pauseLabel(p)}; end the pause first if plans should resume`;

/** Longest pause: a long trip is fine, a pause that quietly never ends is not. */
const MAX_PAUSE_MS = 62 * 86_400_000;

export type PauseResult = { ok: true; pause: GymPause; message: string } | { ok: false; error: string };

/**
 * Adds a pause. It may start now or later but can't reach back over a plan
 * that has already started, so it never erases a miss; plans already inside
 * a future window become "paused" (logged on the pause).
 */
export function addPause(gym: GymState, input: { from: string; to: string; reason: string; by?: string }, now: number): PauseResult {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: "from and to must be ISO times" };
  if (to <= from) return { ok: false, error: "to must be after from" };
  if (to <= now) return { ok: false, error: "the pause must end in the future" };
  if (to - from > MAX_PAUSE_MS) return { ok: false, error: "a pause can last at most 62 days" };
  const reason = input.reason.trim().slice(0, 200);
  if (!reason) return { ok: false, error: "a pause needs a reason" };
  const effectiveFrom = Math.max(from, now);
  // A plan that already started inside the asked window stays judged as it is.
  const started = gym.plans.find(
    (p) => !(p.status === "cancelled" && !cancelledLate(p)) && from <= ms(p.start) && ms(p.start) <= now && ms(p.start) < to,
  );
  if (started) return { ok: false, error: `plan ${started.id} (${when(started.start)}) has already started; a pause can't reach back over it` };
  const overlap = (gym.pauses ?? []).find((p) => ms(p.from) < to && effectiveFrom < ms(p.to));
  if (overlap) return { ok: false, error: `overlaps ${pauseLabel(overlap)}` };
  let n = 1;
  while ((gym.pauses ?? []).some((p) => p.id === `pause-${n}`)) n++;
  const pause: GymPause = {
    id: `pause-${n}`,
    from: new Date(effectiveFrom).toISOString(),
    to: new Date(to).toISOString(),
    reason,
    at: new Date(now).toISOString(),
    ...(input.by ? { by: input.by.slice(0, 80) } : {}),
  };
  (gym.pauses ??= []).push(pause);
  const inside = gym.plans.filter((p) => p.status === "planned" && ms(p.start) >= effectiveFrom && ms(p.start) < to);
  return {
    ok: true,
    pause,
    message: `paused the gym gate ${when(pause.from)} to ${when(pause.to)} (${reason})${inside.length ? `; ${inside.length} plan(s) inside it no longer count: ${inside.map((p) => p.id).join(", ")}` : ""}`,
  };
}

/** Ends a pause now (or drops it if it hasn't started). Plans that started inside it stay paused. */
export function endPause(gym: GymState, id: string, now: number, by?: string): PauseResult {
  const pause = gym.pauses?.find((p) => p.id === id);
  if (!pause) return { ok: false, error: `no pause ${id}` };
  if (ms(pause.to) <= now) return { ok: false, error: `${id} has already ended` };
  const endAt = Math.max(now, ms(pause.from));
  pause.to = new Date(endAt).toISOString();
  pause.endedAt = new Date(now).toISOString();
  if (by) pause.by = `${pause.by ? `${pause.by}, ` : ""}ended by ${by.slice(0, 80)}`;
  return { ok: true, pause, message: `ended ${id}; plans count again from ${when(pause.to)}` };
}

// ---- Uplifting data ----

/** What Uplifting's gate route returns (uplifting apps/api/src/routes/gate.ts). */
export type UpliftingFeed = {
  checkins: Array<{
    client_workout_id: string;
    kind: "start" | "finish";
    at: string;
    latitude: number | null;
    longitude: number | null;
    accuracy_m: number | null;
  }>;
  workouts: Array<{
    id: string;
    client_id: string | null;
    start_time: string;
    end_time: string | null;
    kind: string;
    set_count: number;
    /** The gym the workout was tagged with in Uplifting (added 2026-11-02; absent from older APIs). */
    gym_location?: string | null;
  }>;
};

const KEEP_DAYS = 60;

/** A plan a gym photo could help now: its window has opened, and it isn't settled, kept, made up or cancelled. */
export function gymPhotoWanted(gym: GymState | undefined, now: number): boolean {
  if (!gym) return false;
  const early = gymSettings(gym).earlyMin * MIN;
  return evaluateGym(gym, now).some(
    (r) =>
      r.status === "in-progress" ||
      (r.status === "missed" && missLocks(r, now)) ||
      (r.status === "upcoming" && now >= ms(r.plan.start) - early),
  );
}

/**
 * Records a gym photo as a Start check-in (distance only). "replay" when this
 * photo was recorded before, "near" when a near copy of a recorded one was
 * (`isNear` compares difference hashes); either way nothing is added.
 */
export function recordGymPhoto(
  gym: GymState,
  photo: { id: string; distanceM: number; at: number; now: number; dhash?: string | null },
  isNear: (a: string, b: string) => boolean = () => false,
): "recorded" | "replay" | "near" {
  const clientId = `${PHOTO_PREFIX}${photo.id}`;
  if (gym.checkins.some((c) => c.clientId === clientId)) return "replay";
  // Only recent gym photos: the same mirror and pose on another day is a new photo.
  const recent = (c: GymCheckin) => Math.abs(ms(c.at) - photo.at) <= NEAR_WINDOW_MS;
  if (photo.dhash && gym.checkins.some((c) => isPhoto(c) && c.dhash && recent(c) && isNear(c.dhash, photo.dhash!))) return "near";
  gym.checkins.push({
    clientId,
    kind: "start",
    at: new Date(photo.at).toISOString(),
    distanceM: Math.round(photo.distanceM),
    accuracyM: null,
    receivedAt: new Date(photo.now).toISOString(),
    ...(photo.dhash ? { dhash: photo.dhash } : {}),
  });
  return "recorded";
}

/**
 * Merges a feed into the gate's copy. A session is recorded once, the first
 * time it is seen finished, so editing its times later can't create or move
 * one. Check-ins keep only the distance to the gym. Returns whether anything
 * changed.
 */
export function mergeFeed(gym: GymState, feed: UpliftingFeed, now: number): boolean {
  const s = gymSettings(gym);
  const nowIso = new Date(now).toISOString();
  let changed = false;
  for (const c of feed.checkins ?? []) {
    if (typeof c?.client_workout_id !== "string" || (c.kind !== "start" && c.kind !== "finish")) continue;
    if (!Number.isFinite(Date.parse(c.at))) continue;
    if (gym.checkins.some((x) => x.clientId === c.client_workout_id && x.kind === c.kind)) continue;
    const located = typeof c.latitude === "number" && typeof c.longitude === "number";
    gym.checkins.push({
      clientId: c.client_workout_id,
      kind: c.kind,
      at: new Date(Date.parse(c.at)).toISOString(),
      distanceM: located ? Math.round(distanceM({ lat: c.latitude!, lon: c.longitude! }, s.gym)) : null,
      accuracyM: typeof c.accuracy_m === "number" ? Math.round(c.accuracy_m) : null,
      receivedAt: nowIso,
    });
    changed = true;
  }
  for (const w of feed.workouts ?? []) {
    if (typeof w?.id !== "string" || w.kind !== "workout" || !w.end_time) continue;
    if (!Number.isFinite(Date.parse(w.start_time)) || !Number.isFinite(Date.parse(w.end_time))) continue;
    if (gym.sessions.some((x) => x.id === w.id)) continue;
    gym.sessions.push({
      id: w.id,
      clientId: typeof w.client_id === "string" ? w.client_id : null,
      start: new Date(Date.parse(w.start_time)).toISOString(),
      end: new Date(Date.parse(w.end_time)).toISOString(),
      sets: Number.isFinite(w.set_count) ? w.set_count : 0,
      seenAt: nowIso,
      ...(typeof w.gym_location === "string" && w.gym_location.trim() ? { gymTag: w.gym_location.trim().slice(0, 100) } : {}),
    });
    changed = true;
  }
  return pruneGym(gym, now) || changed;
}

/**
 * Drops sessions and check-ins older than KEEP_DAYS unless a still-missed plan
 * could use them. Plans stay as the record.
 */
export function pruneGym(gym: GymState, now: number): boolean {
  const cutoff = now - KEEP_DAYS * 86_400_000;
  const results = evaluateGym(gym, now);
  const sessionStart = new Map(gym.sessions.map((x) => [x.id, ms(x.start)]));
  let changed = false;
  for (const r of results) {
    if (r.status !== "kept" && r.status !== "made-up") continue;
    if (r.plan.settled) continue;
    // Settle a day before pruning can reach the plan, its session (which can
    // start before the plan) or that session's check-ins.
    if (Math.min(ms(r.plan.start), sessionStart.get(r.sessionId!) ?? Infinity) < cutoff + 86_400_000) {
      r.plan.settled = { status: r.status, sessionId: r.sessionId!, at: new Date(now).toISOString() };
      changed = true;
    }
  }
  // A miss past the data window no longer locks (24 h cap) and can't pin old data forever.
  const missed = results.filter((r) => r.status === "missed" && ms(r.plan.start) >= cutoff);
  const needed = missed.length ? Math.min(...missed.map((r) => ms(r.plan.start))) - gymSettings(gym).earlyMin * MIN : Infinity;
  const keepFrom = Math.min(cutoff, needed);
  const before = gym.sessions.length + gym.checkins.length;
  gym.sessions = gym.sessions.filter((x) => ms(x.start) >= keepFrom || x.manual);
  gym.checkins = gym.checkins.filter((x) => ms(x.at) >= keepFrom);
  return changed || gym.sessions.length + gym.checkins.length !== before;
}
