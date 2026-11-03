import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GYM_SETTINGS, type UpliftingFeed } from "../src/gym";
import { refreshIfDeciding, setGymFetcher, startGymSync } from "../src/gym-sync";
import { zonedTime } from "../src/hygiene";
import { gateRequest, handleHygieneRoute, resetGateCache, setGateDeps } from "../src/hygiene-gate";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = "2026-11-05";
const GOLDS = { latitude: DEFAULT_GYM_SETTINGS.gym.lat, longitude: DEFAULT_GYM_SETTINGS.gym.lon };

let directory = "";
let run = 0;
let clock = at(DAY, "12:00");
let uplifting: UpliftingFeed | Error = { checkins: [], workouts: [] };
let reads = 0;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gym-gate-test-"));
  for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE"]) saved[key] = process.env[key];
  delete process.env.HYGIENE_GATE_REMOTE;
});

afterAll(async () => {
  setGateDeps({});
  setGymFetcher();
  resetGateCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  run++;
  process.env.PROXY_STATE_DIR = join(directory, `state-${run}`);
  process.env.HYGIENE_GATE_STATE = join(directory, `state-${run}`, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, `disabled-${run}`);
  resetGateCache();
  clock = at(DAY, "12:00");
  uplifting = { checkins: [], workouts: [] };
  reads = 0;
  setGateDeps({ now: () => clock, wake: async () => "sent" });
  setGymFetcher(async () => {
    reads++;
    if (uplifting instanceof Error) throw uplifting;
    return uplifting;
  });
  await mkdir(join(directory, `state-${run}`), { recursive: true });
  // Photo checks start in 2027, so only the gym can lock here.
  await writeFile(
    process.env.HYGIENE_GATE_STATE!,
    JSON.stringify({
      version: 1,
      startsAt: iso(at("2027-01-01", "05:00")),
      images: [],
      filled: {},
      bypass: { count: 0, until: null, history: [] },
      debts: [],
      notes: [],
      extraGatedTriggers: [],
    }),
  );
});

async function route(path: string, body?: unknown) {
  const request = new Request(`http://127.0.0.1:3456${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const reply = await handleHygieneRoute(request, new URL(request.url));
  // Unknown paths fall through to app.ts, which answers 404.
  if (!reply) return { status: 404, body: null as any };
  return { status: reply!.status, body: (await reply!.json()) as any };
}

const turn = (text: string): ResponsesRequest =>
  ({
    model: "opus",
    prompt_cache_key: "01a10494-b499-7af3-986b-3c30d8c94b91",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", turn_trigger: "composer" }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] } as ResponseInputItem],
  }) as ResponsesRequest;
const reply = async (text: string) => {
  const d = await gateRequest(turn(text));
  return d.action === "respond" ? d.text : "forwarded";
};

describe("gym on the gate", () => {
  describe("gym photo replays, keepsakes and the recheck route", () => {
    const fix = { lat: GOLDS.latitude, lon: GOLDS.longitude };
    const dh: Record<string, string> = { gym: "0".repeat(64), gym2: "0".repeat(63) + "1", gymB: "f".repeat(64), tooth: "a".repeat(64), gymTooth: "a".repeat(63) + "b" };
    const located = new Set(["gym", "gym2", "gymB", "gymTooth"]);
    let verdict: () => Promise<{ kind: string; confidence: number; reason: string }>;
    let archived: string[];
    let strip: (image: { mediaType: string; bytes: Buffer }) => Promise<{ mediaType: string; bytes: Buffer } | null>;
    let wakes: number;

    beforeEach(async () => {
      await writeFile(
        process.env.HYGIENE_GATE_STATE!,
        JSON.stringify({ version: 1, startsAt: iso(at(DAY, "05:00")), images: [], filled: {}, bypass: { count: 0, until: null, history: [] }, debts: [], notes: [], extraGatedTriggers: [] }),
      );
      resetGateCache();
      archived = [];
      wakes = 0;
      verdict = async () => ({ kind: "none", confidence: 0.9, reason: "a gym" });
      strip = async (image) => ({ ...image, bytes: Buffer.from(`stripped:${image.bytes}`) });
      setGateDeps({
        now: () => clock,
        wake: async () => {
          wakes++;
          return "sent";
        },
        captureTime: async () => at(DAY, "18:20"),
        gpsFix: async (bytes) => (located.has(bytes.toString("utf8")) ? fix : null),
        dhash: async (bytes) => dh[bytes.toString("utf8")] ?? null,
        stripGps: (image) => strip(image),
        archive: (image) => {
          archived.push(image.bytes.toString("utf8"));
          return "/dev/null";
        },
        classify: () => verdict() as any,
      });
      await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
      clock = at(DAY, "18:35");
    });

    let n = 0;
    const send = async (name: string) => {
      const request = {
        ...turn(""),
        prompt_cache_key: `01a10494-b499-7af3-986b-3c30d8c9${String(1000 + ++n).padStart(4, "0")}`,
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`, detail: "auto" }] } as ResponseInputItem],
      } as ResponsesRequest;
      const d = await gateRequest(request);
      return d.action === "respond" ? d.text : "forwarded";
    };
    const photoCheckins = async () => (await route("/hygiene/gym")).body.checkins.filter((c: any) => c.clientId.startsWith("photo:"));

    test("after a 'none' hygiene verdict, a near copy and a replay earn nothing, and the reply says so", async () => {
      // The morning teeth photo still locks; the gym part is recorded either way.
      expect(await send("gym")).toContain("gym photo recorded");
      expect(await photoCheckins()).toHaveLength(1);
      expect(await send("gym2")).not.toContain("gym photo recorded");
      expect(await photoCheckins()).toHaveLength(1);
      const again = await gateRequest({
        ...turn(""),
        prompt_cache_key: "01a10494-b499-7af3-986b-3c30d8c99999",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }, { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from("gym").toString("base64")}`, detail: "auto" }] } as ResponseInputItem],
      } as ResponsesRequest);
      expect(JSON.stringify(again)).toContain("already counted");
      expect(await photoCheckins()).toHaveLength(1);
    });

    test("after a checker error, a near copy earns nothing", async () => {
      verdict = async () => {
        throw new Error("down");
      };
      await send("gym");
      await send("gym2");
      expect(await photoCheckins()).toHaveLength(1);
    });

    test("a near copy of an earlier hygiene proof earns no gym credit", async () => {
      verdict = async () => ({ kind: "teeth", confidence: 0.95, reason: "brushing" });
      await send("tooth");
      expect(await photoCheckins()).toHaveLength(0);
      expect(await send("gymTooth")).toContain("not counted for the gym");
      expect(await photoCheckins()).toHaveLength(0);
    });

    test("the keepsake gets the stripped bytes, or isn't saved", async () => {
      verdict = async () => ({ kind: "teeth", confidence: 0.95, reason: "brushing" });
      await send("gym");
      expect(archived).toEqual(["stripped:gym"]);
      strip = async () => null;
      clock = at("2026-11-06", "06:00");
      await send("gymB");
      expect(archived).toEqual(["stripped:gym"]);
    });

    test("recheck: a checker error isn't acknowledged, and the gym part still counts", async () => {
      verdict = async () => {
        throw new Error("down");
      };
      const url = `data:image/jpeg;base64,${Buffer.from("gym").toString("base64")}`;
      const first = await route("/hygiene/recheck", { url, at: clock });
      expect(first.body).toEqual({ checked: false });
      expect(await photoCheckins()).toHaveLength(1);
    });

    test("recheck: a gym photo that clears the only lock wakes held chats", async () => {
      // Nothing hygiene-related is enforced yet, so the gym plan is the only lock.
      await writeFile(
        process.env.HYGIENE_GATE_STATE!,
        JSON.stringify({ version: 1, startsAt: iso(at("2027-01-01", "05:00")), images: [], filled: {}, bypass: { count: 0, until: null, history: [] }, debts: [], notes: [], extraGatedTriggers: [] }),
      );
      resetGateCache();
      clock = at(DAY, "12:00");
      await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
      clock = at(DAY, "18:35");
      expect(await reply("hi")).toContain("gate armed");
      const url = `data:image/jpeg;base64,${Buffer.from("gym").toString("base64")}`;
      expect((await route("/hygiene/recheck", { url, at: clock })).body).toEqual({ checked: true });
      await Bun.sleep(50);
      expect(wakes).toBe(1);
    });
  });

  test("gym photos: a replay, a near copy or no GPS adds nothing; a checker error stays retryable", async () => {
    // Morning teeth photo due from 05:00 so the hygiene checker runs too.
    await writeFile(
      process.env.HYGIENE_GATE_STATE!,
      JSON.stringify({ version: 1, startsAt: iso(at(DAY, "05:00")), images: [], filled: {}, bypass: { count: 0, until: null, history: [] }, debts: [], notes: [], extraGatedTriggers: [] }),
    );
    resetGateCache();
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
    const fix = { lat: GOLDS.latitude, lon: GOLDS.longitude };
    const meta: Record<string, { gps: typeof fix | null; dhash: string }> = {
      gym: { gps: fix, dhash: "0".repeat(64) },
      gym2: { gps: fix, dhash: "0".repeat(63) + "1" },
      nogps: { gps: null, dhash: "f".repeat(64) },
    };
    let down = true;
    let classified = 0;
    setGateDeps({
      now: () => clock,
      wake: async () => "sent",
      captureTime: async () => at(DAY, "18:20"),
      gpsFix: async (bytes) => meta[bytes.toString("utf8")]?.gps ?? null,
      dhash: async (bytes) => meta[bytes.toString("utf8")]?.dhash ?? null,
      archive: () => "/dev/null",
      classify: async () => {
        classified++;
        if (down) throw new Error("down");
        return { kind: "teeth", confidence: 0.95, reason: "brushing" };
      },
    });
    const send = async (name: string, thread = "01a10494-b499-7af3-986b-3c30d8c94b91") => {
      const request = {
        ...turn(""),
        prompt_cache_key: thread,
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`, detail: "auto" }] } as ResponseInputItem],
      } as ResponsesRequest;
      const d = await gateRequest(request);
      return d.action === "respond" ? d.text : "forwarded";
    };
    const photoCheckins = async () => (await route("/hygiene/gym")).body.checkins.filter((c: any) => c.clientId.startsWith("photo:"));
    clock = at(DAY, "18:35");

    expect(await send("nogps")).toContain("gate armed");
    expect(await photoCheckins()).toHaveLength(0);

    // Checker down: the gym Start is kept, the teeth photo isn't recorded.
    expect(await send("gym")).toContain("couldn't check the photo");
    expect(await photoCheckins()).toHaveLength(1);
    // Resent once the checker works: classified again and accepted; the gym Start isn't doubled.
    down = false;
    expect(await send("gym", "01a10494-b499-7af3-986b-3c30d8c94b92")).toBe("forwarded");
    // nogps, then gym (down), then gym again: classified each time.
    expect(classified).toBe(3);
    expect(await photoCheckins()).toHaveLength(1);

    // A near copy (re-encoded) and an exact replay in another chat add no gym credit.
    await send("gym2", "01a10494-b499-7af3-986b-3c30d8c94b93");
    await send("gym", "01a10494-b499-7af3-986b-3c30d8c94b94");
    expect(await photoCheckins()).toHaveLength(1);
  });

  test("a geotagged photo at the gym unlocks a missed plan; a photo elsewhere doesn't", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
    const exif: Record<string, { taken: number; fix: { lat: number; lon: number } | null }> = {
      gym: { taken: at(DAY, "18:20"), fix: { lat: GOLDS.latitude, lon: GOLDS.longitude } },
      far: { taken: at(DAY, "18:20"), fix: { lat: GOLDS.latitude + 0.0045, lon: GOLDS.longitude } },
      old: { taken: at(DAY, "17:00"), fix: { lat: GOLDS.latitude, lon: GOLDS.longitude } },
    };
    setGateDeps({
      now: () => clock,
      wake: async () => "sent",
      captureTime: async (bytes) => exif[bytes.toString("utf8")]?.taken ?? null,
      gpsFix: async (bytes) => exif[bytes.toString("utf8")]?.fix ?? null,
      classify: async () => ({ kind: "none", confidence: 0.9, reason: "no hygiene proof" }),
    });
    const photoTurn = (name: string): ResponsesRequest =>
      ({
        ...turn(""),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`, detail: "auto" }],
          } as ResponseInputItem,
        ],
      }) as ResponsesRequest;
    clock = at(DAY, "18:35");
    expect(await reply("hi")).toContain("gate armed: gym session");
    for (const name of ["far", "old"]) {
      const d = await gateRequest(photoTurn(name));
      expect(d.action).toBe("respond");
    }
    const d = await gateRequest(photoTurn("gym"));
    expect(d.action).toBe("forward");
    const report = await route("/hygiene/gym");
    expect(report.body.plans[0].status).toBe("in-progress");
    expect(report.body.checkins).toHaveLength(1);
    expect(report.body.checkins[0]).toMatchObject({ kind: "start", distanceM: 0, at: iso(at(DAY, "18:20")) });
    expect(report.body.checkins[0].clientId).toStartWith("photo:");
    // The photo's coordinates are never stored, only its distance.
    expect(Object.keys(report.body.checkins[0]).sort()).toEqual(["accuracyM", "at", "clientId", "distanceM", "kind", "receivedAt"]);
  });

  test("a missed plan locks the next turn; a qualifying session unlocks it", async () => {
    const added = await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, plan: { id: `${DAY}-1`, graceMin: 30 } });

    clock = at(DAY, "18:29");
    expect(await reply("hi")).toBe("forwarded");

    clock = at(DAY, "18:31");
    // The turn reads Uplifting first: nothing there, so the plan is missed.
    expect(await reply("hi")).toBe(
      "💪 gate armed: gym session planned Thu, Nov 5 18:00 (no Start at the gym by 18:30)\n" +
        "Log a gym session in Uplifting (Start and Finish at the gym, or send a photo taken at the gym with location on) to unlock, or reply BYPASS.",
    );
    expect(reads).toBeGreaterThan(0);

    uplifting = {
      checkins: [
        { client_workout_id: "c1", kind: "start", at: iso(at(DAY, "19:00")), ...GOLDS, accuracy_m: 15 },
        { client_workout_id: "c1", kind: "finish", at: iso(at(DAY, "19:55")), ...GOLDS, accuracy_m: 15 },
      ],
      workouts: [
        { id: "w1", client_id: "c1", start_time: iso(at(DAY, "19:00")), end_time: iso(at(DAY, "19:55")), kind: "workout", set_count: 14 },
      ],
    };
    clock = at(DAY, "20:00");
    expect(await reply("back")).toBe("forwarded");
    const report = await route("/hygiene/gym");
    expect(report.body.plans[0]).toMatchObject({ status: "made-up", sessionId: "w1" });
    expect(report.body.sessions[0]).toMatchObject({ id: "w1", counts: true });
  });

  test("with Uplifting unreachable the gate never locks on a plan", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    uplifting = new Error("Uplifting answered 502");
    clock = at(DAY, "19:00");
    expect(await reply("hi")).toBe("forwarded");
    expect((await route("/hygiene/gym")).body).toMatchObject({ syncError: "Uplifting answered 502", plans: [{ status: "upcoming" }] });
  });

  test("move, cancel and the grace setting go through the routes and are logged", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), by: "bubble" });
    expect((await route("/hygiene/gym/settings", { grace_min: 45 })).body).toMatchObject({ ok: true, settings: { graceMin: 45 } });
    const moved = await route(`/hygiene/gym/plans/${DAY}-1/move`, { start: iso(at(DAY, "19:00")), by: "bubble", note: "class ran late" });
    expect(moved.body).toMatchObject({ ok: true, message: "moved to Thu, Nov 5 19:00, start by 19:30" });
    await route("/hygiene/gym/plans", { start: iso(at("2026-11-06", "07:00")) });
    expect((await route("/hygiene/gym/plans/2026-11-06-1", {})).status).toBe(404);
    expect((await route("/hygiene/gym/plans/2026-11-06-1/cancel", { by: "bubble" })).body).toMatchObject({
      ok: true,
      plan: { status: "cancelled", graceMin: 45 },
    });
    const plans = (await route("/hygiene/gym")).body.plans;
    expect(plans.map((p: any) => [p.id, p.status])).toEqual([
      [`${DAY}-1`, "upcoming"],
      ["2026-11-06-1", "cancelled"],
    ]);
    expect(plans[0].log.map((e: any) => [e.action, e.by])).toEqual([
      ["add", "bubble"],
      ["move", "bubble"],
    ]);
    expect((await route("/hygiene/gym/plans", { start: "soon" })).status).toBe(400);
  });

  test("a hand credit clears a miss and needs a reason", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    clock = at(DAY, "18:31");
    expect(await reply("hi")).toContain("gate armed");
    // A session that hasn't ended yet can't be credited.
    expect(
      (await route("/hygiene/gym/sessions/credit", { by: "cli", reason: "x", start: iso(at(DAY, "18:40")), end: iso(at(DAY, "19:40")) })).body,
    ).toEqual({ error: "a credited session must already have ended" });
    clock = at(DAY, "19:45");
    expect((await route("/hygiene/gym/sessions/credit", { by: "cli", start: iso(at(DAY, "18:40")), end: iso(at(DAY, "19:40")) })).status).toBe(400);
    const credited = await route("/hygiene/gym/sessions/credit", {
      by: "cli",
      reason: "photo at Gold's plus Uplifting workout",
      start: iso(at(DAY, "18:40")),
      end: iso(at(DAY, "19:40")),
      workout_id: "w-hand",
    });
    expect(credited.body).toMatchObject({ ok: true, session: { id: "w-hand", manual: { by: "cli" } } });
    expect(await reply("hi")).toBe("forwarded");
  });

  test("a failed read after a miss stops the gym lock (fail open)", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    clock = at(DAY, "18:31");
    expect(await reply("hi")).toContain("gate armed");
    uplifting = new Error("Uplifting answered 502");
    clock = at(DAY, "18:35");
    await route("/hygiene/gym/sync", {});
    expect(await reply("hi")).toBe("forwarded");
    expect((await route("/hygiene/gym")).body.plans[0].status).toBe("missed");
  });

  test("grace_min null means the default, not zero", async () => {
    const added = await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")), grace_min: null });
    expect(added.body).toMatchObject({ ok: true, plan: { graceMin: 30 } });
    expect((await route("/hygiene/gym/settings", { grace_min: null })).status).toBe(400);
    expect((await route("/hygiene/gym/plans", { start: iso(at(DAY, "19:00")), grace_min: "10" })).status).toBe(400);
  });

  test("the poller never throws on a broken state file", async () => {
    await writeFile(process.env.HYGIENE_GATE_STATE!, "{broken");
    resetGateCache();
    const { gymHost } = await import("../src/hygiene-gate");
    let stop: (() => Promise<void>) | undefined;
    expect(() => {
      stop = startGymSync(gymHost, 60_000);
    }).not.toThrow();
    await stop!();
    expect(gymHost.neededSince()).toBeNull();
  });

  test("the decision refresh is bounded even when saving waits on the gate's lock", async () => {
    const now = at(DAY, "18:40");
    const host = { now: () => now, hasGym: () => true, neededSince: () => null, apply: () => new Promise<void>(() => {}) };
    const gym = {
      plans: [{ id: "p", start: iso(at(DAY, "18:00")), graceMin: 30, status: "planned" as const, createdAt: iso(at(DAY, "12:00")), log: [] }],
      sessions: [],
      checkins: [],
    };
    const started = Date.now();
    await refreshIfDeciding(host, gym, 60_000, 200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /** One fetcher for a whole test: the first call hangs until released, later calls answer `next`. */
  function hangFirst(next: () => Promise<UpliftingFeed>) {
    let calls = 0;
    let release!: (feed: UpliftingFeed) => void;
    setGymFetcher(() => (calls++ === 0 ? new Promise((resolve) => (release = resolve)) : next()));
    return (feed: UpliftingFeed) => release(feed);
  }
  const lateSession: UpliftingFeed = {
    checkins: [],
    workouts: [{ id: "w-late", client_id: null, start_time: iso(at(DAY, "17:00")), end_time: iso(at(DAY, "17:30")), kind: "workout", set_count: 3 }],
  };

  test("a stuck read is abandoned after 30 s; its late result merges but never moves the read time back", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    const release = hangFirst(async () => ({ checkins: [], workouts: [] }));
    const { syncGym } = await import("../src/gym-sync");
    const { gymHost } = await import("../src/hygiene-gate");
    clock = at(DAY, "18:31");
    const slow = syncGym(gymHost);
    // Within 30 s the same stuck read is reused.
    clock = at(DAY, "18:31") + 20_000;
    expect(syncGym(gymHost)).toBe(slow);
    // After 30 s a fresh read starts and finishes while the old one still hangs.
    clock = at(DAY, "18:31") + 40_000;
    await syncGym(gymHost);
    const fresh = (await route("/hygiene/gym")).body.syncedAt;
    expect(Date.parse(fresh)).toBe(clock);
    release(lateSession);
    await slow;
    const after = (await route("/hygiene/gym")).body;
    expect(after.syncedAt).toBe(fresh);
    expect(after.sessions.map((s: any) => s.id)).toEqual(["w-late"]);
  });

  test("a late success never clears a newer failure", async () => {
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    const release = hangFirst(async () => {
      throw new Error("Uplifting answered 502");
    });
    const { syncGym } = await import("../src/gym-sync");
    const { gymHost } = await import("../src/hygiene-gate");
    clock = at(DAY, "18:31");
    const slow = syncGym(gymHost);
    clock = at(DAY, "18:31") + 40_000;
    await syncGym(gymHost);
    release({ checkins: [], workouts: [] });
    await slow;
    const report = (await route("/hygiene/gym")).body;
    expect(report.syncError).toBe("Uplifting answered 502");
    expect(report.syncedAt).toBeNull();
    expect(await reply("hi")).toBe("forwarded");
  });

  test("a hung Uplifting at decision time forwards the turn within the refresh cap", async () => {
    setGateDeps({ now: () => clock, wake: async () => "sent", gymRefreshMs: 200 });
    await route("/hygiene/gym/plans", { start: iso(at(DAY, "18:00")) });
    clock = at(DAY, "18:31");
    await route("/hygiene/gym/sync", {});
    expect(await reply("hi")).toContain("gate armed");
    // Uplifting stops answering; 11 minutes on, the copy is stale and the refresh hangs.
    setGymFetcher(() => new Promise(() => {}));
    clock = at(DAY, "18:42");
    const started = Date.now();
    expect(await reply("hi")).toBe("forwarded");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("the decision refresh lets the read finish in the background", async () => {
    const gym = {
      plans: [{ id: "p", start: iso(at(DAY, "18:00")), graceMin: 30, status: "planned" as const, createdAt: iso(at(DAY, "12:00")), log: [] }],
      sessions: [],
      checkins: [],
    } as import("../src/gym").GymState;
    const now = at(DAY, "18:40");
    const host = {
      now: () => now,
      hasGym: () => true,
      neededSince: () => null,
      apply: async (edit: (g: typeof gym, n: number) => boolean) => void edit(gym, now),
    };
    setGymFetcher(() => new Promise((resolve) => setTimeout(() => resolve({ checkins: [], workouts: [] }), 300)));
    const started = Date.now();
    await refreshIfDeciding(host, gym, 60_000, 100);
    expect(Date.now() - started).toBeLessThan(300);
    await Bun.sleep(400);
    expect(gym).toMatchObject({ syncedAt: iso(now) });
    expect("syncError" in gym).toBe(false);
  });
});
