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

const report = (bedtime: boolean) => ({
  version: 1,
  build: "test",
  reported_at: iso(at(NIGHT, "00:00")),
  authorization: "approved",
  time_zone: "America/Vancouver",
  bedtime_enabled: bedtime,
  wake_minute: 420,
  device_id: "phone-1",
  received_at: iso(at(NIGHT, "00:00")),
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

const PHONE = "Your phone's whole-phone lock waits until 01:30 too; the late-night apps stay locked.";

describe("a LATER for last night's photos moves tonight's whole-phone lock", () => {
  test("no move: the phone keeps its own midnight start", async () => {
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("LATER 01:30 at 00:04 moves the phone lock to 01:30 and the reply says so", async () => {
    const before = shieldSignature();
    expect(await say("LATER 01:30")).toBe(
      `⏩ moved shower (Nov 5), night teeth (Nov 5) to 01:30. No bypass, no debt (1 more move today); it locks again at 01:30, and if it isn't done by 04:00 it counts as a skip. ${PHONE}`,
    );
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:30")));
    // The change wakes Cairn, so the phone lifts its lock without being opened.
    expect(shieldSignature()).not.toBe(before);
    expect(shieldSignature()).toContain(`bedtime-full:${iso(at(NIGHT, "01:30"))}`);
    const s = await state();
    expect(s.bypass.count).toBe(0);
    expect(s.debts).toEqual([]);
  });

  test("at the moved time the normal lock applies again", async () => {
    await say("LATER 01:30");
    clock = at(NIGHT, "01:29");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:30")));
    clock = at(NIGHT, "01:30");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("once the moved photos are done the normal lock applies at once", async () => {
    await say("LATER 01:30");
    clock = at(NIGHT, "00:20");
    await sendPhoto("shower");
    // Night teeth is still owed and moved: the phone lock still waits for it.
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:30")));
    await sendPhoto("teeth");
    expect((await state()).filled["2026-11-05/night-teeth"]).toBeTruthy();
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("never past the 04:00 cap, even from a stored move that names a later time", async () => {
    await writeState({
      moves: [
        { slot: "2026-11-05/night-teeth", from: iso(at(NIGHT, "00:00")), to: iso(at(NIGHT, "05:00")), by: "test", at: iso(at(NIGHT, "00:01")) },
      ],
    });
    clock = at(NIGHT, "03:00");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "04:00")));
    clock = at(NIGHT, "04:00");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("two moved photos at different times: the earliest wins", async () => {
    await say("MOVE shower 01:00");
    await say("MOVE night 02:00");
    expect((await getStatus()).bedtime_full_from).toBe(iso(at(NIGHT, "01:00")));
  });

  test("a morning photo's move never touches the phone lock", async () => {
    clock = at(NIGHT, "12:00");
    expect(await say("LATER 23:00")).not.toContain("whole-phone");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("last night's move does not carry into the next night", async () => {
    await say("LATER 01:30");
    clock = at("2026-11-07", "00:30");
    expect((await getStatus()).bedtime_full_from).toBeUndefined();
  });

  test("the reply mentions the phone lock only when the phone runs the bedtime lock", async () => {
    await writeState({ screenTime: [report(false)] });
    const reply = (await say("LATER 01:30"))!;
    expect(reply).toStartWith("⏩ moved shower (Nov 5), night teeth (Nov 5) to 01:30.");
    expect(reply).not.toContain("whole-phone");
  });
});
