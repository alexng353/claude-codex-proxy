import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, setZoneHistory, zonedTime, type GateState } from "../src/hygiene";
import { gateStatus, resetGateCache, setGateDeps, shieldSignature } from "../src/hygiene-gate";
import { handleHygieneApi, setAuthenticator } from "../src/hygiene-api";

// cairn-gate-badge (Alex, 12:07 Nov 15): Cairn's icon badge is the number of gate items
// missing right now. 0 unless the gate is armed; the phone wakes when the count changes.

const DAY = "2026-11-05";
let dir = "";
let now = 0;
const saved: Record<string, string | undefined> = {};
const KEYS = ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE"];

/** Morning teeth, weigh-in and creatine on from DAY 05:00 Vancouver; nothing from the day before. */
function base(): GateState {
  const s = emptyState(new Date(zonedTime(DAY, 5 * 60)).toISOString());
  s.weighInStartsAt = s.startsAt;
  s.creatineStartsAt = s.startsAt;
  return s;
}
function write(s: GateState) {
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.HYGIENE_GATE_REMOTE;
  dir = mkdtempSync(join(tmpdir(), "gate-badge-"));
  process.env.PROXY_STATE_DIR = dir;
  process.env.HYGIENE_GATE_STATE = join(dir, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(dir, "disabled");
  now = zonedTime(DAY, 7 * 60);
  setGateDeps({ now: () => now, wake: async () => "sent" });
});
afterEach(() => {
  setGateDeps({});
  resetGateCache();
  setZoneHistory(undefined);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("badge", () => {
  test("armed: the number of outstanding items", () => {
    write(base());
    const s = gateStatus();
    expect(s.state).toBe("armed");
    expect(s.badge).toBe(3);
    expect(s.badge).toBe(s.outstanding.length);
  });

  test("clear, bypassed and disabled show no badge", () => {
    write(base());
    now = zonedTime(DAY, 4 * 60);
    expect(gateStatus()).toMatchObject({ state: "clear", badge: 0 });
    now = zonedTime(DAY, 7 * 60);
    const s = base();
    s.bypass = { count: 1, until: new Date(zonedTime(DAY, 8 * 60)).toISOString(), history: [] };
    write(s);
    expect(gateStatus()).toMatchObject({ state: "bypassed", badge: 0 });
    expect(gateStatus().outstanding.length).toBe(3);
    write(base());
    writeFileSync(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    expect(gateStatus()).toMatchObject({ state: "disabled", badge: 0 });
  });

  test("items paused by day skips (the live Nov 15 to Dec 2 weigh-in/creatine pause) are not counted", () => {
    const s = base();
    s.skips = ["morning-weight", "morning-creatine"].map((item) => ({
      day: DAY,
      item,
      at: new Date(zonedTime(DAY, 0)).toISOString(),
      by: "Bubble 0b7c3073 via chat 67646",
      reason: "paused while travelling",
    }));
    write(s);
    expect(gateStatus()).toMatchObject({ state: "armed", badge: 1 });
  });

  test("a cancelled (stopped) item is not counted", () => {
    const s = base();
    s.cancellations = { "morning-creatine": { at: new Date(zonedTime(DAY, 0)).toISOString(), reason: "stop" } };
    write(s);
    expect(gateStatus()).toMatchObject({ state: "armed", badge: 2 });
  });

  test("a credited item drops the count, and the signature changes with only the count", () => {
    write(base());
    const before = shieldSignature();
    expect(gateStatus().badge).toBe(3);
    const s = base();
    s.filled[`${DAY}/morning-teeth`] = new Date(now).toISOString();
    write(s);
    const after = shieldSignature();
    expect(gateStatus()).toMatchObject({ state: "armed", badge: 2 });
    expect(after).not.toBe(before);
    expect(after.split("|").slice(0, 2)).toEqual(before.split("|").slice(0, 2));
  });

  test("Jakarta: the morning arms at 05:00 WIB, which changes the count and the signature", () => {
    // 2026-11-20 05:00 WIB is 2026-11-19 22:00Z; the phone has reported Jakarta since Nov 15.
    const s = emptyState("2026-11-19T21:00:00.000Z");
    s.zones = [{ zone: "Asia/Jakarta", from: "2026-11-15T01:00:00.000Z", seenAt: "2026-11-19T20:00:00.000Z" }];
    write(s);
    now = Date.parse("2026-11-19T21:59:00Z");
    const early = shieldSignature();
    expect(gateStatus()).toMatchObject({ zone: "Asia/Jakarta", state: "clear", badge: 0 });
    now = Date.parse("2026-11-19T22:00:00Z");
    expect(gateStatus()).toMatchObject({ state: "armed", badge: 1 });
    expect(gateStatus().outstanding.map((r) => r.slot)).toEqual(["2026-11-20/morning-teeth"]);
    expect(shieldSignature()).not.toBe(early);
  });

  test("the phone's status read carries the badge", async () => {
    write(base());
    setAuthenticator(async () => ({ id: "test", name: "phone", role: "phone" }));
    try {
      const url = new URL("http://localhost/hygiene/api/v1/status");
      const body = await (await handleHygieneApi(new Request(url, { headers: { authorization: "Bearer test" } }), url))!.json();
      expect(body.state).toBe("armed");
      expect(body.badge).toBe(3);
    } finally {
      setAuthenticator();
    }
  });
});
