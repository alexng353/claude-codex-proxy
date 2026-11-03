import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setZoneHistory, zonedTime } from "../src/hygiene";
import { handleHygieneApi, setAuthenticator } from "../src/hygiene-api";
import { resetGateCache, setGateDeps } from "../src/hygiene-gate";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = "2026-11-05";

let directory = "";
let run = 0;
let clock = at(DAY, "06:00");
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hygiene-bypass-test-"));
  for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE"]) saved[key] = process.env[key];
  delete process.env.HYGIENE_GATE_REMOTE;
  setAuthenticator(async (token) =>
    token === "phone"
      ? { id: "phone-1", name: "iphone", role: "phone" }
      : token === "agent"
        ? { id: "agent-1", name: "bubble", role: "agent" }
        : null,
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

beforeEach(async () => {
  run++;
  process.env.PROXY_STATE_DIR = join(directory, `state-${run}`);
  process.env.HYGIENE_GATE_STATE = join(directory, `state-${run}`, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, `disabled-${run}`);
  resetGateCache();
  clock = at(DAY, "06:00");
  setGateDeps({ now: () => clock, wake: async () => "sent" });
  await mkdir(join(directory, `state-${run}`), { recursive: true });
  // First arm Nov 5 05:00 with nothing filled: the morning teeth photo locks at 06:00.
  await writeFile(
    process.env.HYGIENE_GATE_STATE!,
    JSON.stringify({ version: 1, startsAt: iso(at(DAY, "05:00")), images: [], filled: {}, bypass: { count: 0, until: null, history: [] }, debts: [], notes: [], extraGatedTriggers: [] }),
  );
});

async function bypass(body: unknown, token = "phone") {
  const request = new Request("http://localhost/hygiene/api/v1/bypass", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await handleHygieneApi(request, new URL(request.url));
  return { status: reply!.status, body: (await reply!.json()) as any };
}
const state = async () => JSON.parse(await readFile(process.env.HYGIENE_GATE_STATE!, "utf8"));

describe("shield bypass", () => {
  test("opens the gate from the tap for the asked minutes, with a debt", async () => {
    const tap = at(DAY, "05:58");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(tap) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, applied: true, duplicate: false, until: iso(tap + 15 * 60_000), debt_id: `${DAY}-shield-1` });
    expect(r.body.gate.state).toBe("bypassed");
    const s = await state();
    expect(s.bypass).toMatchObject({ count: 1, until: iso(tap + 15 * 60_000) });
    expect(s.debts).toMatchObject([{ id: `${DAY}-shield-1`, status: "open", skipped: ["morning teeth photo"] }]);
  });

  test("a repeat of the same tap returns the first answer and opens nothing new", async () => {
    const body = { minutes: 15, source: "cairn-shield", at: iso(at(DAY, "05:58")) };
    await bypass(body);
    clock = at(DAY, "06:10");
    const again = await bypass(body);
    expect(again.body).toMatchObject({ applied: true, duplicate: true, debt_id: `${DAY}-shield-1` });
    const s = await state();
    expect(s.bypass.count).toBe(1);
    expect(s.debts).toHaveLength(1);
  });

  test("a report after its window ended opens nothing but still records the debt", async () => {
    clock = at(DAY, "07:00");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:10")) });
    expect(r.body).toMatchObject({ applied: false, duplicate: false, until: null, debt_id: `${DAY}-shield-1` });
    expect(r.body.gate.state).toBe("armed");
    expect((await state()).bypass.count).toBe(0);
  });

  test("a tap while a bypass is already open costs nothing and never shortens it", async () => {
    const s = await state();
    s.bypass = { count: 1, until: iso(at(DAY, "07:00")), history: [iso(at(DAY, "06:00"))] };
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "06:05");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:01")) });
    expect(r.body).toMatchObject({ applied: false, until: null, debt_id: null });
    const after = await state();
    expect(after.bypass.until).toBe(iso(at(DAY, "07:00")));
    expect(after.bypass.count).toBe(1);
    expect(after.debts).toEqual([]);
  });

  test("a late report while the gate is locked is charged; the model rules on it", async () => {
    clock = at(DAY, "06:30");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "04:30")) });
    expect(r.body).toMatchObject({ applied: false, until: null, debt_id: `${DAY}-shield-1` });
    expect(r.body.gate.state).toBe("armed");
    // Nothing was due at 04:30: the debt says the lock was seen at the report.
    expect((await state()).debts).toMatchObject([{ skipped: ["at report: morning teeth photo"], status: "open" }]);
  });

  test("a tap locked by a morning photo is charged even when the report arrives after midnight", async () => {
    const s = await state();
    s.filled = { [`${DAY}/shower`]: iso(at(DAY, "21:00")), [`${DAY}/night-teeth`]: iso(at(DAY, "21:00")) };
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at("2026-11-06", "00:10");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "23:00")) });
    expect(r.body.gate.state).toBe("clear");
    expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
    expect((await state()).debts).toMatchObject([{ skipped: ["morning teeth photo"] }]);
  });

  test("a penance paid after the tap does not make the tap free", async () => {
    const s = await state();
    s.filled = { [`${DAY}/morning-teeth`]: iso(at(DAY, "05:30")) };
    s.debts = [{ id: "d0", at: iso(at(DAY, "05:00")), skipped: [], status: "penance", penance: { description: "ten pushups", setAt: iso(at(DAY, "05:10")), paidAt: iso(at(DAY, "06:20")) } }];
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "06:30");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:10")) });
    expect(r.body.gate.state).toBe("clear");
    expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
  });

  describe("gym", () => {
    // Morning photo done, so only the gym can lock. A 07:00 plan misses at 07:30.
    const plan = { id: "p", start: iso(at(DAY, "07:00")), graceMin: 30, status: "planned" as const, createdAt: iso(at(DAY, "01:00")), log: [] };
    async function withGym(gym: Record<string, unknown>) {
      const s = await state();
      s.filled = { [`${DAY}/morning-teeth`]: iso(at(DAY, "05:30")) };
      s.gym = { plans: [plan], sessions: [], checkins: [], ...gym };
      await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
      resetGateCache();
    }

    test("a tap locked by a missed plan is charged after the read goes stale", async () => {
      await withGym({ syncedAt: iso(at(DAY, "07:45")), readAt: iso(at(DAY, "07:45")) });
      clock = at(DAY, "08:20");
      const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "07:50")) });
      expect(r.body.gate.state).toBe("clear");
      expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
    });

    test("a failed read after the tap does not make the tap free", async () => {
      await withGym({ syncedAt: iso(at(DAY, "07:45")), readAt: iso(at(DAY, "07:52")), syncError: "Uplifting answered 502" });
      clock = at(DAY, "07:55");
      const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "07:50")) });
      // The live gate fails open for the gym on the error; the tap was still locked.
      expect(r.body.gate.state).toBe("clear");
      expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
      expect((await state()).debts[0].skipped[0]).toContain("gym");
    });

    test("a check-in received after the tap does not make the tap free", async () => {
      await withGym({
        syncedAt: iso(at(DAY, "08:06")),
        readAt: iso(at(DAY, "08:06")),
        checkins: [{ clientId: "c1", kind: "start", at: iso(at(DAY, "07:10")), distanceM: 20, accuracyM: 10, receivedAt: iso(at(DAY, "08:06")) }],
      });
      clock = at(DAY, "08:08");
      const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "07:50")) });
      expect(r.body.gate.state).toBe("clear");
      expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
    });

    test("a session seen after the tap does not make the tap free", async () => {
      await withGym({
        syncedAt: iso(at(DAY, "08:30")),
        readAt: iso(at(DAY, "08:30")),
        sessions: [{ id: "manual:1", clientId: null, start: iso(at(DAY, "07:05")), end: iso(at(DAY, "08:00")), sets: 8, seenAt: iso(at(DAY, "08:30")), manual: { by: "test", reason: "photo" } }],
      });
      clock = at(DAY, "08:35");
      const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "07:50")) });
      expect(r.body.gate.state).toBe("clear");
      expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
    });
  });

  test("proof accepted after the tap does not make the tap free", async () => {
    const s = await state();
    s.filled = { [`${DAY}/morning-teeth`]: iso(at(DAY, "06:20")) };
    s.images = [{ at: iso(at(DAY, "06:20")), verdict: "accepted", kind: "teeth", slot: `${DAY}/morning-teeth`, sha256: "a".repeat(64) }];
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "06:30");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:10")) });
    expect(r.body.gate.state).toBe("clear");
    expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
    expect((await state()).debts).toMatchObject([{ skipped: ["a lock cleared after the tap"] }]);
  });

  test("a BYPASS typed after the tap does not make the tap free", async () => {
    const s = await state();
    s.bypass = { count: 1, until: iso(at(DAY, "07:30")), history: [iso(at(DAY, "07:00"))] };
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "07:05");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:40")) });
    expect(r.body).toMatchObject({ applied: false, debt_id: `${DAY}-shield-1` });
    expect((await state()).bypass.count).toBe(1);
  });

  test("a DELAY typed after the tap does not make the tap free", async () => {
    const s = await state();
    s.delay = { count: 1, until: iso(at(DAY, "08:10")), day: DAY, history: [DAY] };
    await writeFile(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "06:20");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "06:05")) });
    expect(r.body.debt_id).toBe(`${DAY}-shield-1`);
  });

  test("a tap from a fast phone clock is anchored to the receive time", async () => {
    clock = at(DAY, "06:10");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock + 3 * 60_000) });
    expect(r.body).toMatchObject({ applied: true, until: iso(clock + 15 * 60_000) });
    const s = await state();
    expect(s.bypass.history).toEqual([iso(clock)]);
    expect(s.debts[0].at).toBe(iso(clock));
  });

  test("a duplicate of a tap that opened nothing answers exactly like the first", async () => {
    clock = at(DAY, "04:30");
    const body = { minutes: 15, source: "cairn-shield", at: iso(at(DAY, "04:29")) };
    const first = await bypass(body);
    const again = await bypass(body);
    expect(first.body).toMatchObject({ applied: false, until: null, debt_id: null, duplicate: false });
    expect(again.body).toMatchObject({ applied: false, until: null, debt_id: null, duplicate: true });
  });

  test("taps more than 24 hours old are refused", async () => {
    clock = at(DAY, "06:30");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock - 25 * 3_600_000) });
    expect(r.status).toBe(400);
    expect((await state()).debts).toEqual([]);
  });

  test("with the gate clear nothing opens and no debt is made", async () => {
    clock = at(DAY, "04:30");
    const r = await bypass({ minutes: 15, source: "cairn-shield", at: iso(at(DAY, "04:29")) });
    expect(r.body).toMatchObject({ applied: false, debt_id: null, until: null });
    expect((await state()).debts).toEqual([]);
  });

  test("bad input and future taps are refused; agents and strangers can't call it", async () => {
    expect((await bypass({ minutes: 0, source: "cairn-shield", at: iso(clock) })).status).toBe(400);
    expect((await bypass({ minutes: 61, source: "cairn-shield", at: iso(clock) })).status).toBe(400);
    expect((await bypass({ minutes: 15, source: "cairn shield!", at: iso(clock) })).status).toBe(400);
    expect((await bypass({ minutes: 15, source: "cairn-shield", at: "soon" })).status).toBe(400);
    expect((await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock + 6 * 60_000) })).status).toBe(400);
    expect((await bypass({ minutes: "15", source: "cairn-shield", at: iso(clock) })).status).toBe(400);
    expect((await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock) }, "nope")).status).toBe(401);
    expect((await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock) }, "agent")).status).toBe(403);
    expect((await state()).debts).toEqual([]);
  });

  test("answers 503 while the gate is switched off", async () => {
    await writeFile(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    expect((await bypass({ minutes: 15, source: "cairn-shield", at: iso(clock) })).status).toBe(503);
  });
});

describe("device time zone (X-Device-Time-Zone on GET /status)", () => {
  async function status(zone?: string) {
    const request = new Request("http://localhost/hygiene/api/v1/status", {
      headers: { authorization: "Bearer phone", ...(zone ? { "x-device-time-zone": zone } : {}) },
    });
    const reply = await handleHygieneApi(request, new URL(request.url));
    return (await reply!.json()) as any;
  }
  afterAll(() => setZoneHistory(undefined));

  test("records the zone and follows it; an unknown zone is ignored; a repeat adds nothing", async () => {
    expect((await status()).zone).toBe("America/Vancouver");
    expect((await state()).zones).toBeUndefined();
    await status("America/Vancouver");
    clock += 60_000;
    const jkt = await status("Asia/Jakarta");
    expect(jkt.zone).toBe("Asia/Jakarta");
    expect(jkt.today).toBe("2026-11-05");
    // The 05:00 Vancouver slot armed before the gate heard from the phone at all, so it was a
    // live lock before the change and stays one; the travel day starts at the first report.
    expect(jkt.state).toBe("armed");
    expect((await state()).zones.map((z: any) => z.zone)).toEqual(["America/Vancouver", "Asia/Jakarta"]);
    expect((await status("Mars/Olympus")).zone).toBe("Asia/Jakarta");
    expect((await status("../../etc/passwd")).zone).toBe("Asia/Jakarta");
    clock += 60_000;
    await status("Asia/Jakarta");
    const zones = (await state()).zones;
    expect(zones).toHaveLength(2);
    expect(zones[1].seenAt).toBe(zones[1].from);
    clock += 3_600_000;
    await status("Asia/Jakarta");
    expect((await state()).zones[1].seenAt).toBe(iso(clock));
  });
});
