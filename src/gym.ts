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
import { clockLabel, localTime } from "./hygiene";

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
};

export type GymSettings = {
  graceMin: number;
  minMinutes: number;
  minSets: number;
  /** A Start with no Finish after this long is a miss. */
  maxOpenMin: number;
  /** A session may start this long before the plan and still keep it. */
  earlyMin: number;
  gym: { name: string; lat: number; lon: number; radiusM: number };
};

export type GymState = {
  settings?: Partial<GymSettings>;
  plans: GymPlan[];
  sessions: GymSession[];
  checkins: GymCheckin[];
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
  | "cancelled";

export type PlanResult = {
  plan: GymPlan;
  status: PlanStatus;
  deadline: number;
  /** Why a missed plan was missed. */
  reason?: string;
  /** The session that kept or made up the plan. */
  sessionId?: string;
};

export type SessionCheck = { session: GymSession; qualifies: boolean; reason?: string };

/** Whether a finished session counts, and why not when it doesn't. */
export function checkSession(gym: GymState, session: GymSession): SessionCheck {
  if (session.manual) return { session, qualifies: true };
  const s = gymSettings(gym);
  const minutes = (ms(session.end) - ms(session.start)) / MIN;
  if (!(minutes >= s.minMinutes)) return { session, qualifies: false, reason: `${Math.round(minutes)} min, under ${s.minMinutes}` };
  if (session.sets < s.minSets) return { session, qualifies: false, reason: `${session.sets} sets, under ${s.minSets}` };
  for (const kind of ["start", "finish"] as const) {
    const fix = session.clientId ? checkinFor(gym, session.clientId, kind) : undefined;
    if (!fix || fix.distanceM === null) return { session, qualifies: false, reason: `no location at ${kind}` };
    if (fix.distanceM > s.gym.radiusM)
      return { session, qualifies: false, reason: `${Math.round(fix.distanceM)} m from the gym at ${kind}` };
  }
  return { session, qualifies: true };
}

function checkinFor(gym: GymState, clientId: string, kind: "start" | "finish"): GymCheckin | undefined {
  return gym.checkins.find((c) => c.clientId === clientId && c.kind === kind);
}

const atGym = (gym: GymState, c: GymCheckin) => c.distanceM !== null && c.distanceM <= gymSettings(gym).gym.radiusM;

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
 * mid-workout. Missed plans are then made up, oldest first, by unused
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
  const checks = gym.sessions.map((session) => checkSession(gym, session));
  const used = new Set<string>();
  const finishedClients = new Map(gym.sessions.filter((x) => x.clientId).map((x) => [x.clientId!, x]));
  const plans = [...gym.plans].sort((a, b) => ms(a.start) - ms(b.start));
  const results: PlanResult[] = [];

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
    const unfinished = started.filter((c) => !finishedClients.has(c.clientId));
    const open = unfinished.find((c) => now < ms(c.at) + s.maxOpenMin * MIN);
    if (open) {
      results.push({ plan, status: "in-progress", deadline });
      continue;
    }
    // Evidence of a miss: a read from after the moment the plan failed.
    const failedAt = Math.max(deadline, ...unfinished.map((c) => ms(c.at) + s.maxOpenMin * MIN));
    if (now < deadline || !(gym.syncedAt && ms(gym.syncedAt) >= failedAt)) {
      results.push({ plan, status: "upcoming", deadline });
      continue;
    }
    const failed = started.map((c) => finishedClients.get(c.clientId)).find(Boolean);
    const failedCheck = failed && checks.find((c) => c.session.id === failed.id);
    const reason = failed
      ? failedCheck?.qualifies
        ? ms(failed.end) < madeAt
          ? `session ended ${clockLabel(ms(failed.end))}, before this plan was made`
          : "that session already counted for another plan"
        : `session didn't count: ${failedCheck?.reason ?? "did not qualify"}`
      : started.length
        ? "started, never finished"
        : `no Start at the gym by ${clockLabel(deadline)}`;
    results.push({ plan, status: "missed", deadline, reason });
  }

  for (const result of results) {
    if (result.status !== "missed") continue;
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
  return `${date} ${clockLabel(at)}`;
};

export type GymRequirement = { slot: string; kind: "gym"; label: string };

export const gymSlot = (planId: string) => `gym/${planId}`;

/** Polls run every 2 minutes; a read older than this can't lock the gate. */
export const FRESH_READ_MS = 10 * MIN;

/**
 * Missed plans not yet made up: these lock the gate, but only on a fresh,
 * successful read of Uplifting. A failed or stale read fails open for the gym
 * (a make-up could have happened since), never for the photo checks.
 */
export function gymOutstanding(gym: GymState | undefined, now: number): GymRequirement[] {
  if (!gym?.syncedAt || gym.syncError || now - ms(gym.syncedAt) > FRESH_READ_MS) return [];
  return evaluateGym(gym, now)
    .filter((r) => r.status === "missed")
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
  }>;
};

const KEEP_DAYS = 60;

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
  const missed = results.filter((r) => r.status === "missed");
  const needed = missed.length ? Math.min(...missed.map((r) => ms(r.plan.start))) - gymSettings(gym).earlyMin * MIN : Infinity;
  const keepFrom = Math.min(cutoff, needed);
  const before = gym.sessions.length + gym.checkins.length;
  gym.sessions = gym.sessions.filter((x) => ms(x.start) >= keepFrom || x.manual);
  gym.checkins = gym.checkins.filter((x) => ms(x.at) >= keepFrom);
  return changed || gym.sessions.length + gym.checkins.length !== before;
}
