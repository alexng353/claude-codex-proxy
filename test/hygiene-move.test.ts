import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editPlan, emptyGym, evaluateGym, type GymState } from "../src/gym";
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
  clock = at(DAY, "12:00");
  setGateDeps({ now: () => clock, wake: async () => "sent", bypassWords: () => "maple river otter", gymRefreshMs: 0 });
  await mkdir(join(directory, `state-${run}`), { recursive: true });
  // First arm Nov 5 05:00, nothing filled: the morning teeth photo locks from 05:00.
  await writeState();
});

const meta = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", turn_trigger: "composer" }) };
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] }) as ResponseInputItem;
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const say = async (text: string) => {
  const d = await gateRequest({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta, input: [env, user(text)] } as ResponsesRequest);
  return d.action === "respond" ? d.text : null;
};
const state = async () => JSON.parse(await readFile(process.env.HYGIENE_GATE_STATE!, "utf8"));
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
    expect(typeof s.moves[0].by).toBe("string");
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
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("Cairn can move an item through the API; agent devices cannot", async () => {
    expect((await api("/move", { item: "teeth", to: "18:30" }, "agent")).status).toBe(403);
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
    await say("hi");
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toMatchObject([{ status: "open", items: ["morning-teeth"], source: "move" }]);
  });

  test("a shield tap before a move is still charged", async () => {
    clock = at(DAY, "12:10");
    await say("LATER 18:30");
    const r = await api("/bypass", { minutes: 15, source: "cairn-shield", at: iso(at(DAY, "12:05")) });
    expect(r.body.debt_id).not.toBeNull();
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
  });
});
