import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zonedTime } from "../src/hygiene";
import { handleHygieneApi, setAuthenticator } from "../src/hygiene-api";
import { gateRequest, resetGateCache, setGateDeps, shieldSignature } from "../src/hygiene-gate";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

// Alex, Nov 28 (00:00 WIB Nov 29, after a LATER moved night teeth to 01:00 and the whole-phone
// lock hit him anyway): "can I have it so a LATER pushes my screen time lock too, but not for x
// and aidoku". The gate tells the phone when tonight's whole-phone lock starts; the late-app lock
// (X, Aidoku) is the phone's own and stays from 23:00.
const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const NIGHT = "2026-11-06";
const THREAD = "01a10494-b499-7af3-986b-3c30d8c94b91";

let directory = "";
let run = 0;
let clock = at(NIGHT, "00:04");
let photoKind = "teeth";
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hygiene-later-bedtime-test-"));
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

// `hold`: this Cairn keeps the proxy's bedtime_full_from (its capability in the report).
const report = (bedtime: boolean, hold = true, receivedAt = at(NIGHT, "00:00")) => ({
  version: 1,
  build: "test",
  reported_at: iso(at(NIGHT, "00:00")),
  authorization: "approved",
  time_zone: "America/Vancouver",
  bedtime_enabled: bedtime,
  wake_minute: 420,
  ...(hold ? { bedtime_full_from: true } : {}),
  device_id: "phone-1",
  received_at: iso(receivedAt),
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
      screenTime: [report(true)],
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
  photoKind = "teeth";
  setGateDeps({
    now: () => clock,
    wake: async () => "sent",
    bypassWords: () => "maple river otter",
    gymRefreshMs: 0,
    classify: async () => ({ kind: photoKind, confidence: 0.95, reason: "fake" }) as any,
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
let photos = 0;
const sendPhoto = async (kind: string) => {
  photoKind = kind;
  const image = `data:image/jpeg;base64,${Buffer.from(`fake ${kind} proof ${++photos}`).toString("base64")}`;
  const input = [env, { type: "message", role: "user", content: [{ type: "input_text", text: "here" }, { type: "input_image", image_url: image, detail: "auto" }] }];
  const d = await gateRequest({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta, input } as ResponsesRequest);
  return d.action === "respond" ? d.text : null;
};
async function getStatus() {
  const request = new Request("http://localhost/hygiene/api/v1/status", { headers: { authorization: "Bearer phone" } });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return (await reply!.json()) as any;
}
const state = async () => JSON.parse(await readFile(process.env.HYGIENE_GATE_STATE!, "utf8"));

const phone = (time: string) => `Your phone's whole-phone lock waits until ${time} too; the late-night apps stay locked.`;

describe("a LATER for last night's photos moves tonight's whole-phone lock", () => {
  test("no move: the phone keeps its own midnight start", async () => {
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("LATER 00:45 at 00:04 moves the phone lock to 00:45 and the reply says so", async () => {
    const before = shieldSignature();
    expect(await say("LATER 00:45")).toBe(
      `⏩ moved shower (Nov 5), night teeth (Nov 5) to 00:45. No bypass, no debt (1 more move today); it locks again at 00:45, and if it isn't done by 04:00 it counts as a skip. ${phone("00:45")}`,
    );
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:45")));
    // The change wakes Cairn, so the phone lifts its lock without being opened.
    expect(shieldSignature()).not.toBe(before);
    expect(shieldSignature()).toContain(`bedtime-full:${iso(at(NIGHT, "00:45"))}`);
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toEqual([]);
  });

  // Bubble, Nov 28: the hold never runs past 01:00, even when the photos move later.
  test("a move to 03:00 holds the phone lock only until 01:00, and the reply names 01:00", async () => {
    const reply = (await say("LATER 03:00"))!;
    expect(reply).toContain("it locks again at 03:00, and if it isn't done by 04:00 it counts as a skip.");
    expect(reply).toEndWith(
      "Your phone's whole-phone lock waits until 01:00 too (the latest it waits); the late-night apps stay locked.",
    );
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:00")));
    clock = at(NIGHT, "00:59");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:00")));
    clock = at(NIGHT, "01:00");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("at the moved time the normal lock applies again", async () => {
    await say("LATER 00:45");
    clock = at(NIGHT, "00:44");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:45")));
    clock = at(NIGHT, "00:45");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  // Bubble, Nov 28 (c): sending the photos late must not pay, so done photos keep the hold.
  test("photos done early keep the hold until the moved time", async () => {
    await say("LATER 00:45");
    clock = at(NIGHT, "00:20");
    await sendPhoto("shower");
    await sendPhoto("teeth");
    expect((await state()).filled["2026-11-05/night-teeth"]).toBeTruthy();
    expect((await state()).filled["2026-11-05/shower"]).toBeTruthy();
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:45")));
    clock = at(NIGHT, "00:45");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("never past 01:00, even from a stored move that names a later time", async () => {
    await writeState({
      moves: [
        { slot: "2026-11-05/night-teeth", from: iso(at(NIGHT, "00:00")), to: iso(at(NIGHT, "05:00")), by: "test", at: iso(at(NIGHT, "00:01")) },
      ],
    });
    clock = at(NIGHT, "00:30");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:00")));
    clock = at(NIGHT, "01:00");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  // F1: the reply names the time the phone actually waits until, the earliest hold. F5: while
  // another photo still locks the gate, the phone stays locked until it is in.
  test("two moved photos: the reply names the earliest hold and any photo still owed", async () => {
    // The gate's own armed lines follow the move's line.
    expect(await say("MOVE shower 00:30")).toContain(
      "it counts as a skip. Your phone's whole-phone lock waits until 00:30 once your other photos are in; the late-night apps stay locked.\n",
    );
    expect(await say("MOVE night 00:50")).toEndWith(phone("00:30"));
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:30")));
  });

  // F3 (build lane, 12:23): the hold ends at the earliest moved time and never comes back, so the
  // phone never relocks at 00:30 and then unlocks again until 00:50.
  test("the hold ends at the earliest moved time, done or not, and never comes back", async () => {
    await say("MOVE shower 00:30");
    await say("MOVE night 00:50");
    clock = at(NIGHT, "00:10");
    await sendPhoto("shower");
    expect((await state()).filled["2026-11-05/shower"]).toBeTruthy();
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:30")));
    for (const time of ["00:30", "00:35", "00:49", "00:50", "00:55"]) {
      clock = at(NIGHT, time);
      expect((await getStatus()).bedtime_full_from).toBeUndefined();
    }
  });

  test("a LATER after the first moved time has passed holds nothing and says nothing about the phone", async () => {
    await say("MOVE shower 00:30");
    clock = at(NIGHT, "00:35");
    const reply = (await say("MOVE night 00:50"))!;
    expect(reply).toStartWith("⏩ moved night teeth (Nov 5) to 00:50.");
    expect(reply).not.toContain("whole-phone");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("a LATER after 01:00 holds nothing and says nothing about the phone", async () => {
    clock = at(NIGHT, "01:10");
    const reply = (await say("LATER 02:00"))!;
    expect(reply).toStartWith("⏩ moved shower (Nov 5), night teeth (Nov 5) to 02:00.");
    expect(reply).not.toContain("whole-phone");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("a morning photo's move never touches the phone lock", async () => {
    // During a hold, moving only this morning's photo leaves the hold alone and says nothing of it.
    await writeState({ creatineStartsAt: iso(at("2026-11-05", "05:00")) });
    await say("LATER 00:45");
    clock = at(NIGHT, "00:10");
    const during = (await say("MOVE creatine 08:00"))!;
    expect(during).toStartWith("⏩ moved morning creatine (Nov 6) to 08:00.");
    expect(during).not.toContain("whole-phone");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:45")));
    clock = at(NIGHT, "12:00");
    expect(await say("LATER 23:00")).not.toContain("whole-phone");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("last night's move does not carry into the next night", async () => {
    await say("LATER 00:45");
    clock = at("2026-11-07", "00:30");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  // F2: an older Cairn ignores bedtime_full_from, so only a fresh report from a Cairn that keeps
  // it (and runs the bedtime lock) gets the promise.
  test("the reply mentions the phone lock only when a fresh report says this Cairn holds it", async () => {
    for (const screen of [report(false), report(true, false), report(true, true, at(NIGHT, "00:00") - 25 * 3600_000)]) {
      await writeState({ screenTime: [screen] });
      const reply = (await say("LATER 00:45"))!;
      expect(reply).toStartWith("⏩ moved shower (Nov 5), night teeth (Nov 5) to 00:45.");
      expect(reply).not.toContain("whole-phone");
      // The status still names the hold; a phone that keeps it reads it either way.
      expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "00:45")));
    }
  });
});
