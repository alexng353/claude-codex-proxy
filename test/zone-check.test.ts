import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkZone, runZoneCheck, zoneAlarm, type ZoneCheck } from "../src/zone-check";
import { offsetAt } from "../src/zone";

const NOW = Date.parse("2026-11-02T07:25:00Z");

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
    // No expectation on the answer (it depends on the installed bun); the check must run.
    const c = checkZone(NOW);
    expect(c.source).toBe("tzif");
    expect(typeof c.runtimeAgrees).toBe("boolean");
  });

  test("the gate's clock on the Intl fallback is an error", () => {
    const c: ZoneCheck = { zone: "America/Vancouver", runtime: "bun x", source: "intl", path: null, runtimeAgrees: true, year: 2026 };
    expect(zoneAlarm(c)).toMatchObject({ level: "error", key: "zone-fallback-2026" });
  });

  test("pages once per alarm key; a failed page is retried next time", async () => {
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
