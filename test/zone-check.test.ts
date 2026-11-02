import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkZone, runZoneCheck, zoneAlarm, type ZoneCheck } from "../src/zone-check";
import { offsetAt, wallTime } from "../src/zone";
import { probes } from "../src/zone-check";

const NOW = Date.parse("2026-11-02T07:25:00Z");

/**
 * Today's daemon, as `today-daemon send --client-message-id` behaves: a new id is
 * delivered; the same id with the same text is a duplicate (exit 0, not delivered
 * again); the same id with other text is refused (exit 3).
 */
function fakeDaemon() {
  const seen = new Map<string, string>();
  const delivered: string[] = [];
  let failing = false;
  const send = async (text: string, id: string) => {
    if (failing) return false;
    const prev = seen.get(id);
    if (prev !== undefined) return prev === text;
    seen.set(id, text);
    delivered.push(id);
    return true;
  };
  return { send, delivered, fail: (on: boolean) => void (failing = on) };
}

describe("zone self-check", () => {
  test("a runtime that agrees with the database raises nothing", () => {
    const c = checkZone(NOW, "America/Vancouver", (ms, zone) => offsetAt(ms, zone));
    expect(c).toMatchObject({ source: "tzif", runtimeAgrees: true });
    expect(zoneAlarm(c)).toBeNull();
  });

  test("a runtime an hour behind (bun 1.4.3's ICU after Nov 1 2026) is caught at the first differing probe", () => {
    const lagging = (ms: number, zone: string) => {
      const real = offsetAt(ms, zone);
      return ms >= Date.parse("2026-11-01T09:00:00Z") ? { ...real, offsetMs: real.offsetMs - 3600_000, abbrev: "PST" } : real;
    };
    const c = checkZone(NOW, "America/Vancouver", lagging);
    expect(c.runtimeAgrees).toBe(false);
    expect(c.mismatch?.at).toBe("2026-11-01T12:00:00.000Z");
    const alarm = zoneAlarm(c)!;
    expect(alarm.level).toBe("warn");
    expect(alarm.key).toMatch(/^zone-intl-[A-Za-z0-9._-]+-2026$/);
    expect(alarm.text).toContain("(PST)");
    // Same runtime, data and year: identical text, so a restart pages nothing new.
    expect(zoneAlarm(checkZone(NOW + 3 * 3600_000, "America/Vancouver", lagging))!.text).toBe(alarm.text);
  });

  test("this bun's own Intl is compared for real", () => {
    // The answer depends on the installed bun. Work it out here with Intl directly
    // (wall-clock fields, not offsets) and require the default check to match it.
    const c = checkZone(NOW);
    expect(c.source).toBe("tzif");
    const intl = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Vancouver", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
    });
    const fields = (ms: number) => {
      const p = Object.fromEntries(intl.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return [+p.year, +p.month, +p.day, +p.hour, +p.minute];
    };
    const firstDiff = [...probes(NOW), NOW].find((ms) => {
      const w = wallTime(ms, "America/Vancouver");
      return JSON.stringify(fields(ms)) !== JSON.stringify([w.year, w.month, w.day, w.hour, w.minute]);
    });
    expect({ agrees: c.runtimeAgrees, at: c.mismatch?.at }).toEqual({
      agrees: firstDiff === undefined,
      at: firstDiff === undefined ? undefined : new Date(firstDiff).toISOString(),
    });
  });

  test("the gate's clock on the Intl fallback is an error", () => {
    const c: ZoneCheck = { zone: "America/Vancouver", runtime: "bun x", source: "intl", path: null, runtimeAgrees: true, year: 2026 };
    expect(zoneAlarm(c)).toMatchObject({ level: "error", key: "zone-fallback-2026" });
  });

  test("a gate clock on a stale copy of the zone file is an error that does not say Intl", () => {
    const c: ZoneCheck = { zone: "America/Vancouver", runtime: "bun x", source: "stale", path: "/z", runtimeAgrees: true, year: 2026 };
    const alarm = zoneAlarm(c)!;
    expect(alarm).toMatchObject({ level: "error", key: "zone-fallback-2026" });
    expect(alarm.text).toContain("last good copy");
    expect(alarm.text).not.toContain("Intl");
  });

  test("each fallback episode is delivered under its own id; retries in an episode reuse it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-check-"));
    const base = { zone: "America/Vancouver", runtime: "bun x", path: null, runtimeAgrees: true, year: 2026 } as const;
    const down: ZoneCheck = { ...base, source: "intl" };
    const up: ZoneCheck = { ...base, source: "tzif" };
    const daemon = fakeDaemon();
    const quiet = console.error;
    console.error = () => {};
    try {
      const run = (c: ZoneCheck, at: number) => runZoneCheck({ now: NOW + at, send: daemon.send, dir, check: () => c });
      daemon.fail(true);
      await run(down, 0); // episode 1 starts; the page fails
      daemon.fail(false);
      await run(down, 60_000); // retried under episode 1's id
      await run(down, 120_000); // already delivered: nothing
      await run(up, 180_000); // recovered
      await run(down, 240_000); // episode 2
      expect(daemon.delivered).toEqual([`zone-fallback-2026-${NOW}`, `zone-fallback-2026-${NOW + 240_000}`]);
    } finally {
      console.error = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pages once per alarm key, retrying a failed page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-check-"));
    try {
      const bad: ZoneCheck = {
        zone: "America/Vancouver", runtime: "bun 1.4.3", source: "tzif", path: "/x", runtimeAgrees: false, year: 2026,
        mismatch: { at: "2026-11-15T12:00:00.000Z", database: { offsetMs: -25200_000, abbrev: "MST", isDst: false }, runtime: { offsetMs: -28800_000, abbrev: "PST", isDst: false } },
      };
      const sent: string[] = [];
      let ok = false;
      const send = async (_text: string, id: string) => (sent.push(id), ok);
      const quiet = console.warn;
      console.warn = () => {};
      try {
        expect((await runZoneCheck({ now: NOW, send, dir, check: () => bad })).paged).toBe(false);
        ok = true;
        expect((await runZoneCheck({ now: NOW, send, dir, check: () => bad })).paged).toBe(true);
        expect((await runZoneCheck({ now: NOW, send, dir, check: () => bad })).paged).toBe(false);
      } finally {
        console.warn = quiet;
      }
      expect(sent).toEqual(["zone-intl-bun_1.4.3-2026", "zone-intl-bun_1.4.3-2026"]);
      expect(existsSync(join(dir, "zone-intl-bun_1.4.3-2026"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
