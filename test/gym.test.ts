import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GYM_SETTINGS,
  editPlan,
  emptyGym,
  evaluateGym,
  gymDueToday,
  gymOutstanding,
  mergeFeed,
  pruneGym,
  type GymState,
  type UpliftingFeed,
} from "../src/gym";
import { emptyState, lockedText, outstanding, zonedTime } from "../src/hygiene";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = "2026-11-05";
const GOLDS = { lat: DEFAULT_GYM_SETTINGS.gym.lat, lon: DEFAULT_GYM_SETTINGS.gym.lon };
// About 500 m north of the gym, across Broadway and beyond.
const AWAY = { lat: GOLDS.lat + 0.0045, lon: GOLDS.lon };

/** A gym with one plan at 18:00 on DAY, added the day before. */
function planned(grace = 30): { gym: GymState; id: string } {
  const gym = emptyGym();
  const r = editPlan(gym, { action: "add", start: iso(at(DAY, "18:00")), graceMin: grace, by: "test" }, at("2026-11-04", "12:00"));
  if (!r.ok) throw new Error(r.error);
  return { gym, id: r.plan.id };
}

function checkin(client: string, kind: "start" | "finish", time: number, where = GOLDS): UpliftingFeed["checkins"][number] {
  return { client_workout_id: client, kind, at: iso(time), latitude: where.lat, longitude: where.lon, accuracy_m: 20 };
}
function workout(id: string, client: string, start: number, end: number, sets = 12): UpliftingFeed["workouts"][number] {
  return { id, client_id: client, start_time: iso(start), end_time: iso(end), kind: "workout", set_count: sets };
}
function feed(gym: GymState, now: number, f: Partial<UpliftingFeed>) {
  mergeFeed(gym, { checkins: f.checkins ?? [], workouts: f.workouts ?? [] }, now);
  gym.syncedAt = iso(now);
}
const statusAt = (gym: GymState, now: number) => evaluateGym(gym, now).map((r) => r.status);

describe("plans and the deadline", () => {
  test("no Start at the gym by start + 30 min locks, but only once Uplifting was read after the deadline", () => {
    const { gym } = planned();
    expect(statusAt(gym, at(DAY, "18:29"))).toEqual(["upcoming"]);
    // Past the deadline with no read since: wait, never lock on missing evidence.
    gym.syncedAt = iso(at(DAY, "18:25"));
    expect(statusAt(gym, at(DAY, "18:31"))).toEqual(["upcoming"]);
    expect(gymOutstanding(gym, at(DAY, "18:31"))).toEqual([]);
    feed(gym, at(DAY, "18:31"), {});
    const due = gymOutstanding(gym, at(DAY, "18:31"));
    expect(due).toHaveLength(1);
    expect(due[0].label).toBe("gym session planned Thu, Nov 5 18:00 (no Start at the gym by 18:30)");
  });

  test("a Start at the gym in time holds the plan open; a qualifying Finish keeps it", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:20"), { checkins: [checkin("c1", "start", at(DAY, "18:15"))] });
    feed(gym, at(DAY, "18:40"), {});
    expect(statusAt(gym, at(DAY, "18:40"))).toEqual(["in-progress"]);
    expect(gymDueToday(gym, at(DAY, "18:40"))[0].label).toBe("gym session in progress (tap Finish in Uplifting)");
    feed(gym, at(DAY, "19:30"), {
      checkins: [checkin("c1", "finish", at(DAY, "19:20"))],
      workouts: [workout("w1", "c1", at(DAY, "18:15"), at(DAY, "19:20"))],
    });
    expect(evaluateGym(gym, at(DAY, "19:30"))[0]).toMatchObject({ status: "kept", sessionId: "w1" });
  });

  test("a session that doesn't qualify is a miss, with the reason", () => {
    for (const [w, checkins, reason] of [
      [workout("w1", "c1", at(DAY, "18:00"), at(DAY, "18:30")), ["start", "finish"], "30 min, under 45"],
      [workout("w1", "c1", at(DAY, "18:00"), at(DAY, "19:00"), 5), ["start", "finish"], "5 sets, under 6"],
      [workout("w1", "c1", at(DAY, "18:00"), at(DAY, "19:00")), ["start"], "no location at finish"],
    ] as const) {
      const { gym } = planned();
      feed(gym, at(DAY, "19:05"), {
        checkins: checkins.map((k) => checkin("c1", k, k === "start" ? at(DAY, "18:00") : at(DAY, "19:00"))),
        workouts: [w],
      });
      expect(evaluateGym(gym, at(DAY, "19:05"))[0]).toMatchObject({ status: "missed", reason: `session didn't count: ${reason}` });
    }
  });

  test("a Start away from the gym does not hold the plan", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:31"), { checkins: [checkin("c1", "start", at(DAY, "18:10"), AWAY)] });
    expect(gym.checkins[0].distanceM).toBeGreaterThan(400);
    expect(statusAt(gym, at(DAY, "18:31"))).toEqual(["missed"]);
  });

  test("a Start with no Finish for 4 hours is a miss", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:10"), { checkins: [checkin("c1", "start", at(DAY, "18:05"))] });
    feed(gym, at(DAY, "22:04"), {});
    expect(statusAt(gym, at(DAY, "22:04"))).toEqual(["in-progress"]);
    // Past the 4 hours, but the last read is from before then: no evidence yet.
    expect(statusAt(gym, at(DAY, "22:06"))).toEqual(["upcoming"]);
    feed(gym, at(DAY, "22:06"), {});
    expect(evaluateGym(gym, at(DAY, "22:06"))[0]).toMatchObject({ status: "missed", reason: "started, never finished" });
  });

  test("a new plan can't take the session that made up an older miss", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:31"), {});
    const later = at("2026-11-06", "19:05");
    feed(gym, later, {
      checkins: [checkin("c2", "start", at("2026-11-06", "18:00")), checkin("c2", "finish", at("2026-11-06", "19:00"))],
      workouts: [workout("w2", "c2", at("2026-11-06", "18:00"), at("2026-11-06", "19:00"))],
    });
    expect(statusAt(gym, later)).toEqual(["made-up"]);
    // Planned at 19:05 for 20:05: the 18:00 session is in its early window but predates it.
    editPlan(gym, { action: "add", start: iso(at("2026-11-06", "20:05")) }, later);
    expect(statusAt(gym, later)).toEqual(["made-up", "upcoming"]);
  });

  test("a stale or failed read never locks, though the plan shows as missed", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:31"), {});
    expect(gymOutstanding(gym, at(DAY, "18:31"))).toHaveLength(1);
    expect(gymOutstanding(gym, at(DAY, "18:42"))).toEqual([]);
    gym.syncError = "Uplifting timed out";
    expect(gymOutstanding(gym, at(DAY, "18:32"))).toEqual([]);
    expect(statusAt(gym, at(DAY, "18:32"))).toEqual(["missed"]);
  });

  test("a qualifying session later makes up a miss; one session never counts twice", () => {
    const { gym } = planned();
    editPlan(gym, { action: "add", start: iso(at("2026-11-07", "10:00")) }, at("2026-11-04", "12:00"));
    feed(gym, at(DAY, "18:31"), {});
    expect(statusAt(gym, at(DAY, "18:31"))).toEqual(["missed", "upcoming"]);
    // Nov 6: an unplanned session makes up Nov 5.
    feed(gym, at("2026-11-06", "20:00"), {
      checkins: [checkin("c2", "start", at("2026-11-06", "19:00")), checkin("c2", "finish", at("2026-11-06", "19:50"))],
      workouts: [workout("w2", "c2", at("2026-11-06", "19:00"), at("2026-11-06", "19:50"))],
    });
    expect(evaluateGym(gym, at("2026-11-06", "20:00"))[0]).toMatchObject({ status: "made-up", sessionId: "w2" });
    // Nov 7 10:00 needs its own session: w2 is spent.
    feed(gym, at("2026-11-07", "10:31"), {});
    expect(statusAt(gym, at("2026-11-07", "10:31"))).toEqual(["made-up", "missed"]);
  });

  test("a session before the plan's window can't make it up", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "18:31"), {
      checkins: [checkin("c0", "start", at(DAY, "08:00")), checkin("c0", "finish", at(DAY, "09:00"))],
      workouts: [workout("w0", "c0", at(DAY, "08:00"), at(DAY, "09:00"))],
    });
    expect(statusAt(gym, at(DAY, "18:31"))).toEqual(["missed"]);
  });

  test("a session up to 3 hours early keeps the plan", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "16:30"), {
      checkins: [checkin("c0", "start", at(DAY, "15:15")), checkin("c0", "finish", at(DAY, "16:15"))],
      workouts: [workout("w0", "c0", at(DAY, "15:15"), at(DAY, "16:15"))],
    });
    expect(statusAt(gym, at(DAY, "16:30"))).toEqual(["kept"]);
  });
});

describe("edits", () => {
  test("cancel before the start removes the plan; after the start it still counts", () => {
    const early = planned();
    expect(editPlan(early.gym, { action: "cancel", id: early.id }, at(DAY, "17:00"))).toMatchObject({ ok: true });
    feed(early.gym, at(DAY, "18:31"), {});
    expect(statusAt(early.gym, at(DAY, "18:31"))).toEqual(["cancelled"]);

    const late = planned();
    const r = editPlan(late.gym, { action: "cancel", id: late.id }, at(DAY, "18:05"));
    expect(r).toMatchObject({ ok: true, message: "cancelled after its start: it still counts as a miss unless a session is logged" });
    feed(late.gym, at(DAY, "18:31"), {});
    expect(statusAt(late.gym, at(DAY, "18:31"))).toEqual(["missed"]);
  });

  test("move before the start shifts the deadline; after the start it is refused", () => {
    const { gym, id } = planned();
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "20:00")) }, at(DAY, "17:00"))).toMatchObject({
      ok: true,
      message: "moved to Thu, Nov 5 20:00, start by 20:30",
    });
    feed(gym, at(DAY, "18:31"), {});
    expect(statusAt(gym, at(DAY, "18:31"))).toEqual(["upcoming"]);
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "22:00")) }, at(DAY, "20:01"))).toMatchObject({ ok: false });
    expect(gym.plans[0].log.map((e) => e.action)).toEqual(["add", "move"]);
  });

  test("plans must start in the future, with a sane grace", () => {
    const gym = emptyGym();
    expect(editPlan(gym, { action: "add", start: iso(at(DAY, "10:00")) }, at(DAY, "11:00"))).toMatchObject({ ok: false });
    expect(editPlan(gym, { action: "add", start: "tomorrow" }, at(DAY, "11:00"))).toMatchObject({ ok: false });
    expect(editPlan(gym, { action: "add", start: iso(at(DAY, "18:00")), graceMin: 999 }, at(DAY, "11:00"))).toMatchObject({ ok: false });
    const r = editPlan(gym, { action: "add", start: iso(at(DAY, "18:00")), graceMin: 60 }, at(DAY, "11:00"));
    expect(r).toMatchObject({ ok: true, message: "planned Thu, Nov 5 18:00, start by 19:00" });
    expect(editPlan(gym, { action: "add", start: iso(at(DAY, "19:00")) }, at(DAY, "11:00"))).toMatchObject({ ok: true, plan: { id: `${DAY}-2` } });
  });
});

describe("Uplifting feed", () => {
  test("a session is recorded once; editing its times later changes nothing", () => {
    const gym = emptyGym();
    const now = at(DAY, "20:00");
    mergeFeed(gym, { checkins: [], workouts: [workout("w1", "c1", at(DAY, "18:00"), at(DAY, "19:00"))] }, now);
    mergeFeed(gym, { checkins: [], workouts: [workout("w1", "c1", at(DAY, "10:00"), at(DAY, "19:00"))] }, now);
    expect(gym.sessions).toHaveLength(1);
    expect(gym.sessions[0].start).toBe(iso(at(DAY, "18:00")));
  });

  test("rest days, unfinished workouts and malformed rows are ignored; only distance is kept", () => {
    const gym = emptyGym();
    mergeFeed(
      gym,
      {
        checkins: [
          checkin("c1", "start", at(DAY, "18:00")),
          { client_workout_id: "c2", kind: "start", at: "nope", latitude: 1, longitude: 1, accuracy_m: null },
          { client_workout_id: "c3", kind: "start", at: iso(at(DAY, "18:00")), latitude: null, longitude: null, accuracy_m: null },
        ],
        workouts: [
          { ...workout("r1", "x", at(DAY, "00:00"), at(DAY, "00:00")), kind: "rest" },
          { ...workout("w2", "c2", at(DAY, "18:00"), at(DAY, "19:00")), end_time: null },
        ],
      },
      at(DAY, "20:00"),
    );
    expect(gym.sessions).toEqual([]);
    expect(gym.checkins.map((c) => [c.clientId, c.distanceM])).toEqual([
      ["c1", 0],
      ["c3", null],
    ]);
    expect(JSON.stringify(gym)).not.toContain("latitude");
  });

  test("pruning old sessions never reopens a plan they kept", () => {
    const { gym } = planned();
    feed(gym, at(DAY, "19:30"), {
      checkins: [checkin("c1", "start", at(DAY, "18:00")), checkin("c1", "finish", at(DAY, "19:00"))],
      workouts: [workout("w1", "c1", at(DAY, "18:00"), at(DAY, "19:00"))],
    });
    const later = at("2027-02-01", "12:00");
    gym.syncedAt = iso(later);
    expect(pruneGym(gym, later)).toBe(true);
    expect(gym.sessions).toEqual([]);
    expect(evaluateGym(gym, later)[0]).toMatchObject({ status: "kept", sessionId: "w1" });
  });

  test("pruning a session that started before its plan settles the plan first", () => {
    const { gym } = planned();
    // Arrived early: Start at 17:50 for the 18:00 plan.
    feed(gym, at(DAY, "19:30"), {
      checkins: [checkin("c1", "start", at(DAY, "17:50")), checkin("c1", "finish", at(DAY, "19:00"))],
      workouts: [workout("w1", "c1", at(DAY, "17:50"), at(DAY, "19:00"))],
    });
    // Step through the window where the session is past the cutoff but the plan isn't.
    for (const minutes of [0, 5, 10]) {
      const now = at(DAY, "17:50") + 60 * 86_400_000 + minutes * 60_000;
      gym.syncedAt = iso(now);
      pruneGym(gym, now);
      expect(evaluateGym(gym, now)[0]).toMatchObject({ status: "kept", sessionId: "w1" });
    }
    expect(gym.plans[0].settled).toMatchObject({ status: "kept", sessionId: "w1" });
  });
});

describe("the gate", () => {
  test("a missed plan is an outstanding requirement with gym wording", () => {
    const state = emptyState(iso(at("2027-01-01", "05:00")));
    state.gym = planned().gym;
    state.gym.syncedAt = iso(at(DAY, "18:31"));
    const due = outstanding(state, at(DAY, "18:31"));
    expect(due.map((r) => r.kind)).toEqual(["gym"]);
    expect(lockedText(due)).toBe(
      "💪 gate armed: gym session planned Thu, Nov 5 18:00 (no Start at the gym by 18:30)\n" +
        "Log a gym session in Uplifting (Start and Finish at the gym) to unlock, or reply BYPASS.",
    );
    expect(lockedText([{ slot: "x", kind: "shower", label: "shower photo" }, ...due]).split("\n")[1]).toBe(
      "Send a fresh photo and log a gym session in Uplifting (Start and Finish at the gym) to unlock, or reply BYPASS.",
    );
  });
});
