import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GYM_SETTINGS, addPause, cancelledLate, editPlan, emptyGym, evaluateGym, mergeFeed, type GymState } from "../src/gym";
import { zonedTime } from "../src/hygiene";
import { handleHygieneApi, setAuthenticator } from "../src/hygiene-api";
import { gateRequest, resetGateCache, setGateDeps } from "../src/hygiene-gate";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = "2026-11-05";
const THREAD = "01a10494-b499-7af3-986b-3c30d8c94b91";

let directory = "";
let run = 0;
let clock = at(DAY, "12:00");
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hygiene-move-test-"));
  for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE"]) saved[key] = process.env[key];
  saved.HYGIENE_PHOTO_DIR = process.env.HYGIENE_PHOTO_DIR;
  delete process.env.HYGIENE_GATE_REMOTE;
  setAuthenticator(async (token) =>
    token === "phone" ? { id: "phone-1", name: "iphone", role: "phone" } : token === "agent" ? { id: "agent-1", name: "bubble", role: "agent" } : null,
  );
});

afterAll(async () => {
  setAuthenticator();
  setGateDeps({});
  resetGateCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

async function writeState(extra: Record<string, unknown> = {}) {
  await writeFile(
    process.env.HYGIENE_GATE_STATE!,
    JSON.stringify({
      version: 1,
      startsAt: iso(at(DAY, "05:00")),
      images: [],
      filled: {},
      bypass: { count: 0, until: null, history: [] },
      debts: [],
      notes: [],
      extraGatedTriggers: [],
      ...extra,
    }),
  );
  resetGateCache();
}

beforeEach(async () => {
  run++;
  process.env.PROXY_STATE_DIR = join(directory, `state-${run}`);
  process.env.HYGIENE_GATE_STATE = join(directory, `state-${run}`, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, `disabled-${run}`);
  process.env.HYGIENE_PHOTO_DIR = join(directory, `photos-${run}`);
  clock = at(DAY, "12:00");
  setGateDeps({
    now: () => clock,
    wake: async () => "sent",
    bypassWords: () => "maple river otter",
    gymRefreshMs: 0,
    classify: async () => ({ kind: "creatine", confidence: 0.95, reason: "scoop" }),
    dhash: async () => null,
    captureTime: async () => clock - 60_000,
    stripGps: async (image) => image,
  });
  await mkdir(join(directory, `state-${run}`), { recursive: true });
  // First arm Nov 5 05:00, nothing filled: the morning teeth photo locks from 05:00.
  await writeState();
});

const meta = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", turn_trigger: "composer" }) };
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] }) as ResponseInputItem;
const photoTurn = (name: string) =>
  ({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "here" },
      { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`, detail: "auto" },
    ],
  }) as ResponseInputItem;
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const say = async (text: string) => {
  const d = await gateRequest({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta, input: [env, user(text)] } as ResponsesRequest);
  return d.action === "respond" ? d.text : null;
};
const state = async () => JSON.parse(await readFile(process.env.HYGIENE_GATE_STATE!, "utf8"));
async function getStatus() {
  const request = new Request("http://localhost/hygiene/api/v1/status", { headers: { authorization: "Bearer phone" } });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return (await reply!.json()) as any;
}
async function api(path: string, body: unknown, token = "phone") {
  const request = new Request(`http://localhost/hygiene/api/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return { status: reply!.status, body: (await reply!.json()) as any };
}

describe("MOVE / LATER on the hygiene gate", () => {
  test("LATER shifts the due time and unlocks now; it locks again at the new time", async () => {
    expect(await say("hi")).toContain("gate armed: morning teeth photo");
    const reply = await say("LATER 18:30");
    expect(reply).toContain("moved");
    expect(reply).toContain("18:30");
    expect(await say("hi")).toBeNull();
    const s = await state();
    expect(s.moves).toMatchObject([{ slot: `${DAY}/morning-teeth`, from: iso(at(DAY, "05:00")), to: iso(at(DAY, "18:30")), at: iso(at(DAY, "12:00")) }]);
    expect(s.moves[0].by).toBe(`chat:${THREAD}`);
    clock = at(DAY, "18:30");
    expect(await say("hi")).toContain("gate armed: morning teeth photo");
  });

  test("moves leave the bypass count and debts unchanged", async () => {
    await say("MOVE teeth 14:00");
    clock = at(DAY, "14:30");
    await say("move teeth 16:00");
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.bypass.history).toEqual([]);
    expect(s.debts).toEqual([]);
    expect(s.moves).toHaveLength(2);
  });

  test("a third move of an item the same day is refused with a clear message", async () => {
    await say("MOVE teeth 14:00");
    clock = at(DAY, "14:30");
    await say("MOVE teeth 15:00");
    clock = at(DAY, "15:30");
    const reply = await say("MOVE teeth 17:00");
    expect(reply).toContain("already moved twice today");
    expect(reply).toContain("BYPASS maple river otter");
    expect((await state()).moves).toHaveLength(2);
    expect(await say("hi")).toContain("gate armed");
  });

  test("a move to another day, or to a time already past, is refused", async () => {
    expect(await say("MOVE teeth tomorrow 09:00")).toContain("same day");
    expect(await say("LATER 00:30")).toContain("already past");
    expect(await say("LATER 11:00")).toContain("already past");
    expect((await state()).moves ?? []).toEqual([]);
    const r = await api("/move", { item: "teeth", to: iso(at("2026-11-06", "09:00")) });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("same day");
    expect(await say("hi")).toContain("gate armed");
  });

  test("ordinary text that starts with later or move is not a gate reply", async () => {
    expect(await say("later today I'll fix the build")).toContain("gate armed");
    expect(await say("move the meeting to 3")).toContain("gate armed");
    // A bare number is a reply to a numbered list, not a time; while locked it gets the lock text.
    expect(await say("move 2")).toStartWith("🪥 gate armed");
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("a clear gate never swallows an unnamed LATER or a bare number", async () => {
    await writeState({ filled: { [`${DAY}/morning-teeth`]: "x" } });
    for (const text of ["move 2", "later 5", "later 5pm", "LATER 18:30"]) expect(await say(text)).toBeNull();
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("an item word from the prototype is not an item, and never fails the gate open", async () => {
    for (const text of ["MOVE constructor 18:30", "MOVE __proto__ 18:30", "MOVE toString 18:30"]) expect(await say(text)).toStartWith("🪥 gate armed");
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("a move during DELAY must land after the delay's end, which it logs as its from", async () => {
    clock = at(DAY, "07:00");
    expect(await say("DELAY")).toContain("delay: gate open until 09:00");
    expect(await say("MOVE teeth 08:00")).toContain("isn't due until 09:00");
    expect(await say("MOVE teeth 10:00")).toContain("moved");
    expect((await state()).moves).toMatchObject([{ from: iso(at(DAY, "09:00")), to: iso(at(DAY, "10:00")) }]);
    clock = at(DAY, "09:30");
    expect(await say("hi")).toBeNull();
    clock = at(DAY, "10:00");
    expect(await say("hi")).toContain("gate armed");
  });

  test("a creatine photo sent for a moved creatine requirement counts while the gate is open", async () => {
    await writeState({ creatineStartsAt: iso(at(DAY, "05:00")), filled: { [`${DAY}/morning-teeth`]: "x" } });
    expect(await say("MOVE creatine 18:00")).toContain("moved");
    clock = at(DAY, "12:30");
    const d = await gateRequest({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta, input: [env, photoTurn("scoop")] } as ResponsesRequest);
    expect(d.action).toBe("forward");
    expect((await state()).filled[`${DAY}/morning-creatine`]).toBe(iso(at(DAY, "12:30")));
  });

  test("Cairn can move an item through the API; agent devices cannot", async () => {
    expect((await api("/move", { item: "teeth", to: "18:30" }, "agent")).status).toBe(403);
    expect((await api("/move", { item: "constructor", to: "18:30" })).status).toBe(400);
    expect((await api("/move", { item: 3, to: "18:30" })).status).toBe(400);
    expect((await api("/move", { item: "teeth" })).status).toBe(400);
    const r = await api("/move", { item: "teeth", to: "18:30" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, moved: [{ slot: `${DAY}/morning-teeth`, to: iso(at(DAY, "18:30")), by: "cairn:iphone" }] });
    expect(r.body.gate.state).toBe("clear");
    expect(r.body.gate.moves).toHaveLength(1);
    expect(r.body.gate.due_today.find((d: any) => d.slot === `${DAY}/morning-teeth`)?.label).toContain("moved to 18:30");
  });

  test("a move that passes midnight unkept becomes an open debt, not a free skip", async () => {
    await say("LATER 23:00");
    clock = at("2026-11-06", "04:00");
    // The phone's status read charges it, without waiting for a chat turn.
    const status = await getStatus();
    expect(status.open_debts).toMatchObject([{ status: "open", source: "move" }]);
    await say("hi");
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toMatchObject([{ status: "open", items: ["morning-teeth"], source: "move" }]);
    expect(s.debts).toHaveLength(1);
  });

  test("a BYPASS of the moved lock itself is the one charge for that skip", async () => {
    await say("MOVE teeth 23:00");
    clock = at(DAY, "23:30");
    expect(await say("BYPASS maple river otter")).toContain("bypass #1");
    clock = at("2026-11-06", "04:00");
    await say("hi");
    expect((await state()).debts.map((d: any) => d.source ?? "bypass")).toEqual(["bypass"]);
  });

  test("a BYPASS before the move is a different skip: the broken move is still charged", async () => {
    clock = at(DAY, "06:00");
    expect(await say("BYPASS maple river otter")).toContain("bypass #1");
    clock = at(DAY, "07:30");
    expect(await say("MOVE teeth 23:00")).toContain("moved");
    clock = at("2026-11-06", "04:00");
    await say("hi");
    expect((await state()).debts.map((d: any) => d.source ?? "bypass")).toEqual(["bypass", "move"]);
  });

  test("a shield tap in the moved window reported after the move debt supersedes it", async () => {
    await say("MOVE teeth 23:00");
    clock = at("2026-11-06", "00:05");
    expect((await getStatus()).open_debts).toMatchObject([{ source: "move" }]);
    const r = await api("/bypass", { minutes: 15, source: "cairn-shield", at: iso(at(DAY, "23:30")) });
    expect(r.body.debt_id).not.toBeNull();
    const s = await state();
    expect(s.debts.filter((d: any) => d.status === "open").map((d: any) => d.source ?? "bypass")).toEqual(["bypass"]);
    expect(s.debts.find((d: any) => d.source === "move")).toMatchObject({ status: "justified", reason: expect.stringContaining("superseded by") });
  });

  test("a bypassed gate never swallows an unnamed LATER", async () => {
    expect(await say("BYPASS maple river otter")).toContain("bypass #1");
    expect(await say("later 5pm")).toBeNull();
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("the kill switch stops a status read charging a broken move", async () => {
    await say("LATER 23:00");
    await writeFile(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    clock = at("2026-11-06", "04:00");
    await getStatus();
    expect((await state()).debts).toEqual([]);
  });

  test("a shield tap before a move is still charged", async () => {
    clock = at(DAY, "12:10");
    await say("LATER 18:30");
    const r = await api("/bypass", { minutes: 15, source: "cairn-shield", at: iso(at(DAY, "12:05")) });
    expect(r.body.debt_id).not.toBeNull();
    // The tap-time view still sees the lock the later move cleared, so the debt names it.
    expect((await state()).debts[0]).toMatchObject({ skipped: ["morning teeth photo"], items: ["morning-teeth"] });
  });
});

describe("MOVE gym", () => {
  function plannedGym(): GymState {
    const gym = emptyGym();
    const r = editPlan(gym, { action: "add", start: iso(at(DAY, "18:00")), by: "test" }, at("2026-11-04", "12:00"));
    if (!r.ok) throw new Error(r.error);
    return gym;
  }

  test("a started gym plan can move within the same day; past its start-by time it can't", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "20:00")), by: "test" }, at(DAY, "18:10"))).toMatchObject({ ok: true });
    gym.syncedAt = iso(at(DAY, "18:45"));
    expect(evaluateGym(gym, at(DAY, "18:45"))[0].status).toBe("upcoming");
    const late = plannedGym();
    const lateId = late.plans[0].id;
    const r = editPlan(late, { action: "move", id: lateId, start: iso(at(DAY, "21:00")) }, at(DAY, "18:31"));
    expect(r).toMatchObject({ ok: false });
    expect(late.plans[0].log.map((e) => e.action)).toEqual(["add"]);
  });

  test("a started plan can't move to another day, nor more than twice a day", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    expect(editPlan(gym, { action: "move", id, start: iso(at("2026-11-06", "09:00")) }, at(DAY, "18:05"))).toMatchObject({ ok: false });
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "18:20")) }, at(DAY, "18:05"))).toMatchObject({ ok: true });
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "18:40")) }, at(DAY, "18:25"))).toMatchObject({ ok: true });
    const third = editPlan(gym, { action: "move", id, start: iso(at(DAY, "19:00")) }, at(DAY, "18:45"));
    expect(third).toMatchObject({ ok: false });
    expect((third as { error: string }).error).toContain("already moved twice today");
  });

  test("a started plan stays started after a move: no free move, cancel or pause before its new start", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "19:00")) }, at(DAY, "18:05"))).toMatchObject({ ok: true });
    expect(editPlan(gym, { action: "move", id, start: iso(at("2026-11-06", "09:00")) }, at(DAY, "18:06"))).toMatchObject({ ok: false });
    expect(addPause(gym, { from: iso(at(DAY, "18:07")), to: iso(at("2026-11-06", "00:00")), reason: "x" }, at(DAY, "18:07"))).toMatchObject({ ok: false });
    const r = editPlan(gym, { action: "cancel", id }, at(DAY, "18:08"));
    expect(r).toMatchObject({ ok: true, message: "cancelled after its start: it still counts as a miss unless a session is logged" });
    expect(cancelledLate(gym.plans[0])).toBe(true);
  });

  test("today's plan moves the bounded way even before its start; later days move freely", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    expect(editPlan(gym, { action: "move", id, start: iso(at("2026-11-06", "09:00")) }, at(DAY, "12:00"))).toMatchObject({ ok: false });
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "18:30")) }, at(DAY, "12:00"))).toMatchObject({ ok: true });
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "19:00")) }, at(DAY, "12:01"))).toMatchObject({ ok: true });
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "19:30")) }, at(DAY, "12:02"))).toMatchObject({ ok: false });
    const future = emptyGym();
    const add = editPlan(future, { action: "add", start: iso(at("2026-11-07", "18:00")) }, at(DAY, "12:00"));
    if (!add.ok) throw new Error(add.error);
    for (const time of ["19:00", "20:00", "21:00"])
      expect(editPlan(future, { action: "move", id: add.plan.id, start: iso(at("2026-11-07", time)) }, at(DAY, "12:00"))).toMatchObject({ ok: true });
  });

  test("a plan with an open Start at the gym can't move", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    const g = DEFAULT_GYM_SETTINGS.gym;
    mergeFeed(gym, { checkins: [{ client_workout_id: "w1", kind: "start", at: iso(at(DAY, "18:10")), latitude: g.lat, longitude: g.lon, accuracy_m: 10 }], workouts: [] }, at(DAY, "18:12"));
    expect(evaluateGym(gym, at(DAY, "18:15"))[0].status).toBe("in-progress");
    const r = editPlan(gym, { action: "move", id, start: iso(at(DAY, "21:30")) }, at(DAY, "18:15"));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("open Start");
  });

  test("a plan for just after midnight with an open Start before midnight can't move either", () => {
    const gym = emptyGym();
    const add = editPlan(gym, { action: "add", start: iso(at("2026-11-06", "00:30")) }, at(DAY, "12:00"));
    if (!add.ok) throw new Error(add.error);
    const g = DEFAULT_GYM_SETTINGS.gym;
    mergeFeed(gym, { checkins: [{ client_workout_id: "w1", kind: "start", at: iso(at(DAY, "23:40")), latitude: g.lat, longitude: g.lon, accuracy_m: 10 }], workouts: [] }, at(DAY, "23:41"));
    expect(evaluateGym(gym, at(DAY, "23:45"))[0].status).toBe("in-progress");
    expect(editPlan(gym, { action: "move", id: add.plan.id, start: iso(at("2026-11-06", "20:00")) }, at(DAY, "23:45"))).toMatchObject({ ok: false });
  });

  test("today's plan inside a travel pause can move out of it", () => {
    const gym = plannedGym();
    const id = gym.plans[0].id;
    expect(addPause(gym, { from: iso(at(DAY, "17:00")), to: iso(at(DAY, "19:00")), reason: "flight" }, at(DAY, "12:00"))).toMatchObject({ ok: true });
    expect(evaluateGym(gym, at(DAY, "12:00"))[0].status).toBe("paused");
    expect(editPlan(gym, { action: "move", id, start: iso(at(DAY, "20:00")) }, at(DAY, "12:00"))).toMatchObject({ ok: true });
    expect(evaluateGym(gym, at(DAY, "12:00"))[0].status).toBe("upcoming");
  });

  test("MOVE gym in a chat moves today's plan without a bypass", async () => {
    const gym = plannedGym();
    gym.syncedAt = iso(at(DAY, "18:05"));
    await writeState({ filled: { [`${DAY}/morning-teeth`]: "x" }, gym });
    clock = at(DAY, "18:05");
    const reply = await say("MOVE gym 19:30");
    expect(reply).toContain("19:30");
    const s = await state();
    expect(s.gym.plans[0].start).toBe(iso(at(DAY, "19:30")));
    expect(s.gym.plans[0].log.at(-1)).toMatchObject({ action: "move", from: iso(at(DAY, "18:00")), to: iso(at(DAY, "19:30")) });
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toEqual([]);
    // Gym moves show in status.moves beside photo moves, so Cairn can count what's left.
    const status = await getStatus();
    expect(status.moves).toMatchObject([{ slot: `gym/${s.gym.plans[0].id}`, to: iso(at(DAY, "19:30")) }]);
    expect(status.max_moves_per_day).toBe(2);
    expect(await say("MOVE gym 19:00")).toContain("only pushes it later");
  });
});
