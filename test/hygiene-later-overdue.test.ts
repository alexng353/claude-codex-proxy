import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedText, zonedTime } from "../src/hygiene";
import { handleHygieneApi, setAuthenticator } from "../src/hygiene-api";
import { gateRequest, resetGateCache, setGateDeps } from "../src/hygiene-gate";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

// Same fakes as hygiene-move.test.ts, armed from Nov 4 so Nov 5's night photos are overdue after midnight.
const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = "2026-11-05";
const NIGHT = "2026-11-06";
const THREAD = "01a10494-b499-7af3-986b-3c30d8c94b91";

let directory = "";
let run = 0;
let clock = at(NIGHT, "00:04");
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hygiene-later-overdue-test-"));
  for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE", "HYGIENE_PHOTO_DIR"]) saved[key] = process.env[key];
  delete process.env.HYGIENE_GATE_REMOTE;
  setAuthenticator(async (token) => (token === "phone" ? { id: "phone-1", name: "iphone", role: "phone" } : null));
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
      startsAt: iso(at("2026-11-04", "05:00")),
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
  clock = at(NIGHT, "00:04");
  setGateDeps({
    now: () => clock,
    wake: async () => "sent",
    bypassWords: () => "maple river otter",
    gymRefreshMs: 0,
    classify: async () => ({ kind: "teeth", confidence: 0.95, reason: "brush" }),
    dhash: async () => null,
    captureTime: async () => clock - 60_000,
    stripGps: async (image) => image,
  });
  await mkdir(join(directory, `state-${run}`), { recursive: true });
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
async function getStatus() {
  const request = new Request("http://localhost/hygiene/api/v1/status", { headers: { authorization: "Bearer phone" } });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return (await reply!.json()) as any;
}
async function api(path: string, body: unknown) {
  const request = new Request(`http://localhost/hygiene/api/v1${path}`, {
    method: "POST",
    headers: { authorization: "Bearer phone", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return { status: reply!.status, body: (await reply!.json()) as any };
}

const SMALL_HOURS = /Still up\? Reply LATER and a time before 04:00, e\.g\. LATER (\d{2}:\d{2}) \(not a bypass\)\./;
const BOTH = "shower photo (overdue from Nov 5), night teeth photo (overdue from Nov 5)";
const LOCK = `🚿 gate armed: ${BOTH}\nSend a fresh photo to unlock, or reply BYPASS maple river otter.`;

/** Alex, Nov 27 00:04 WIB: the lock offered "a time before midnight, e.g. LATER 21:00" for last night's photos, so he typed BYPASS. */
describe("LATER for last night's overdue photos, after midnight", () => {
  test("the lock offers a small-hours LATER, never 'before midnight' or 21:00", async () => {
    const lock = (await say("hi"))!;
    expect(lock).toBe(`${LOCK}\nStill up? Reply LATER and a time before 04:00, e.g. LATER 01:30 (not a bypass).`);
    expect(lock).not.toContain("midnight");
    expect(lock).not.toContain("21:00");
  });

  test("the hint's example is always a future time before 04:00, and LATER with it works", async () => {
    const cases = [
      ["00:04", "01:30"],
      ["01:20", "02:30"],
      ["02:59", "03:45"],
      ["03:44", "03:45"],
      ["03:50", "03:59"],
      ["03:58", "03:59"],
    ];
    for (const [now, example] of cases) {
      await writeState();
      clock = at(NIGHT, now);
      const shown = SMALL_HOURS.exec((await say("hi")) ?? "")?.[1];
      expect([now, shown]).toEqual([now, example]);
      expect(at(NIGHT, shown!)).toBeGreaterThan(clock);
      expect(await say(`LATER ${shown}`)).toStartWith(`⏩ moved shower (Nov 5), night teeth (Nov 5) to ${shown}.`);
    }
  });

  test("from 03:59 no minute before 04:00 is left, so the lock offers no LATER", async () => {
    clock = at(NIGHT, "03:59") + 30_000;
    expect(await say("hi")).toBe(LOCK);
  });

  test("LATER 01:30 at 00:04 moves both, with no bypass or debt, and they lock again at 01:30", async () => {
    expect(await say("LATER 01:30")).toBe(
      "⏩ moved shower (Nov 5), night teeth (Nov 5) to 01:30. No bypass, no debt (1 more move today); it locks again at 01:30, and if it isn't done by 04:00 it counts as a skip.",
    );
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toEqual([]);
    expect(s.moves.map((m: any) => [m.slot, m.to])).toEqual([
      ["2026-11-05/shower", iso(at(NIGHT, "01:30"))],
      ["2026-11-05/night-teeth", iso(at(NIGHT, "01:30"))],
    ]);
    clock = at(NIGHT, "01:29");
    expect(await say("hi")).toBeNull();
    clock = at(NIGHT, "01:30");
    expect(await say("hi")).toStartWith(`${LOCK}\n`);
  });

  test("an overdue photo can't move to 04:00 or later; the refusal names 04:00 and BYPASS, and nothing moves", async () => {
    for (const time of ["04:00", "05:00", "23:00"]) {
      const reply = (await say(`LATER ${time}`))!;
      expect(reply).toStartWith(
        "⏩ can't move: last night's shower (Nov 5), night teeth (Nov 5) can move only to a time before 04:00; send the photo, or reply BYPASS.\n",
      );
      expect(reply).toContain("Still up? Reply LATER");
    }
    const r = await api("/move", { item: "shower", to: "23:00" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("last night's shower (Nov 5) can move only to a time before 04:00; send the photo, or reply BYPASS");
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("past 04:00 an overdue photo can't move at all, and the lock stops offering LATER for it", async () => {
    clock = at(NIGHT, "04:30");
    expect(await say("hi")).toBe(LOCK);
    expect(await say("LATER 23:00")).toStartWith(
      "⏩ can't move: last night's shower (Nov 5), night teeth (Nov 5) could move only until 04:00; send the photo, or reply BYPASS.\n",
    );
    expect(await say("MOVE shower 23:00")).toStartWith("⏩ can't move: last night's shower (Nov 5) could move only until 04:00; send the photo, or reply BYPASS.\n");
    expect((await state()).moves ?? []).toEqual([]);
  });

  test("this morning's photo keeps the old rule beside an overdue one: LATER moves only what can move", async () => {
    clock = at(NIGHT, "12:00");
    expect(await say("hi")).toEndWith("Doing it later today? Reply LATER and a time before midnight, e.g. LATER 21:00 (not a bypass).");
    expect(await say("LATER 23:00")).toStartWith(
      `⏩ moved morning teeth (Nov 6) to 23:00. No bypass, no debt (1 more move today); if it isn't done by midnight it counts as a skip.\n${LOCK}`,
    );
  });

  test("a broken overdue move is charged once, at 04:00, not at the next midnight", async () => {
    await say("LATER 01:30");
    clock = at(NIGHT, "03:59");
    expect((await getStatus()).open_debts).toEqual([]);
    clock = at(NIGHT, "04:00");
    expect((await getStatus()).open_debts).toMatchObject([
      { source: "move", at: iso(at(NIGHT, "04:00")), skipped: ["shower (Nov 5) (moved to 01:30, not done by 04:00)"] },
      { source: "move", at: iso(at(NIGHT, "04:00")), skipped: ["night teeth (Nov 5) (moved to 01:30, not done by 04:00)"] },
    ]);
    // The skip is charged, so its lock ends: nothing locks until this morning's photo at 05:00.
    clock = at(NIGHT, "04:30");
    expect(await say("hi")).toBeNull();
    clock = at(NIGHT, "08:00");
    expect(await say("BYPASS maple river otter")).toContain("bypass #1");
    expect((await state()).debts.find((d: any) => d.source !== "move")).toMatchObject({ items: ["morning-teeth"] });
    clock = at("2026-11-07", "00:30");
    await say("hi");
    expect((await state()).debts.filter((d: any) => d.source === "move")).toHaveLength(2);
  });

  test("a BYPASS of the moved overdue lock is the one charge for that skip", async () => {
    await say("LATER 01:30");
    clock = at(NIGHT, "02:00");
    expect(await say("BYPASS maple river otter")).toContain("bypass #1");
    for (const time of ["04:00", "12:00"]) {
      clock = at(NIGHT, time);
      await say("hi");
    }
    clock = at("2026-11-07", "00:30");
    await say("hi");
    expect((await state()).debts.map((d: any) => d.source ?? "bypass")).toEqual(["bypass"]);
  });

  test("a shield tap in the moved overdue window, reported after 04:00, supersedes the move debt", async () => {
    await say("LATER shower 01:30");
    clock = at(NIGHT, "04:05");
    expect((await getStatus()).open_debts).toMatchObject([{ source: "move" }]);
    const r = await api("/bypass", { minutes: 15, source: "cairn-shield", at: iso(at(NIGHT, "03:30")) });
    expect(r.body.debt_id).not.toBeNull();
    expect((await state()).debts.find((d: any) => d.source === "move")).toMatchObject({
      status: "justified",
      reason: expect.stringContaining("superseded by"),
    });
  });
});

describe("LATER before midnight is unchanged", () => {
  test("a morning lock at noon still offers a time before midnight and takes LATER 23:00", async () => {
    await writeState({ startsAt: iso(at(DAY, "05:00")) });
    clock = at(DAY, "12:00");
    expect(await say("hi")).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER and a time before midnight, e.g. LATER 21:00 (not a bypass).",
    );
    expect(await say("LATER 23:00")).toBe(
      "⏩ moved morning teeth (Nov 5) to 23:00. No bypass, no debt (1 more move today); if it isn't done by midnight it counts as a skip.",
    );
  });

  test("lockedText without a time keeps the plain hint", () => {
    expect(lockedText([{ slot: `${DAY}/morning-teeth`, kind: "teeth", label: "morning teeth photo" }])).toEndWith(
      "before midnight, e.g. LATER 21:00 (not a bypass).",
    );
  });
});
