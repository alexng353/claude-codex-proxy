import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localTime, outstanding, emptyState, zonedTime, type GateState } from "../src/hygiene";
import { parseCaptureTime } from "../src/hygiene-proof";
import { offsetAt, parsePosixTz, posixOffsetAt, resetZoneCache, wallTime, zoneSource } from "../src/zone";

/**
 * Every expectation here comes from glibc's `date` reading the same zone
 * database, never from a hard-coded offset, so these tests keep passing
 * whatever rule tzdata gives BC next. The fake databases built with zic prove
 * the proxy follows the file, not a rule baked into it or into bun's ICU.
 */
const ZONE = "America/Vancouver";
const hasZic = Bun.spawnSync(["sh", "-c", "command -v zic"]).exitCode === 0;

function sh(args: string[], env: Record<string, string> = {}): string {
  const run = Bun.spawnSync(args, { env: { ...process.env, TZ: ZONE, ...env } });
  if (run.exitCode !== 0) throw new Error(`${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}
/** glibc: the instant a Vancouver wall time names, in ms. */
const sysInstant = (local: string, env?: Record<string, string>) => Number(sh(["date", "-d", local, "+%s"], env)) * 1000;
/** glibc: offset (ms east of UTC) and abbreviation at an instant. */
function sysOffset(ms: number, env?: Record<string, string>) {
  const [z, abbrev] = sh(["date", "-d", `@${Math.floor(ms / 1000)}`, "+%z %Z"], env).split(" ");
  const sign = z[0] === "-" ? -1 : 1;
  return { offsetMs: sign * (Number(z.slice(1, 3)) * 3600 + Number(z.slice(3, 5)) * 60) * 1000, abbrev };
}

const savedTzdir = process.env.TZDIR;
afterEach(() => {
  if (savedTzdir === undefined) delete process.env.TZDIR;
  else process.env.TZDIR = savedTzdir;
  resetZoneCache();
});

// Instants either side of the March 2026 change, the Nov 1 2026 change, today and beyond.
const PROBES = [
  "2026-03-08T09:59:00Z", "2026-03-08T10:00:00Z", "2026-07-01T12:00:00Z",
  "2026-11-01T08:59:59Z", "2026-11-01T09:00:00Z", "2026-11-01T09:30:00Z", "2026-11-02T07:25:00Z",
  "2026-12-01T13:00:00Z", "2027-03-14T10:30:00Z", "2027-11-07T10:30:00Z", "2031-01-15T00:00:00Z", "2045-07-04T19:00:00Z",
];

describe("zone database clock", () => {
  test("America/Vancouver offset and name match glibc at every probe", () => {
    for (const iso of PROBES) {
      const ms = Date.parse(iso);
      const { offsetMs, abbrev } = offsetAt(ms, ZONE);
      expect({ iso, offsetMs, abbrev }).toEqual({ iso, ...sysOffset(ms) });
    }
  });

  test("wall clock matches glibc's, field by field", () => {
    for (const iso of PROBES) {
      const w = wallTime(Date.parse(iso), ZONE);
      const pad = (n: number) => String(n).padStart(2, "0");
      const mine = `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${w.weekday}`;
      expect({ iso, mine }).toEqual({ iso, mine: sh(["date", "-d", `@${Date.parse(iso) / 1000}`, "+%Y-%m-%d %H:%M:%S %w"]) });
    }
  });

  test("the gate's local midnight and 05:00 are glibc's, across both 2026 changes", () => {
    for (const day of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-10-31", "2026-11-01", "2026-11-02", "2026-12-01", "2027-03-14"]) {
      for (const [hhmm, minutes] of [["00:00", 0], ["05:00", 300], ["17:00", 1020]] as const) {
        const want = sysInstant(`${day} ${hhmm}`);
        expect({ day, hhmm, at: zonedTime(day, minutes) }).toEqual({ day, hhmm, at: want });
        expect(localTime(want)).toEqual({ day, minutes });
      }
    }
  });

  test("EXIF time with no offset is read as Vancouver wall time from the zone database", () => {
    for (const local of ["2026-03-08 03:30:00", "2026-11-01 05:10:00", "2026-11-02 00:25:00", "2027-01-10 07:00:00"]) {
      const exif = local.replace(/-/g, ":");
      expect({ local, at: parseCaptureTime(exif) }).toEqual({ local, at: sysInstant(local) });
    }
  });

  test("the midnight overdue lock fires at Vancouver midnight on Nov 2 2026, not an hour later", () => {
    const day = "2026-11-01";
    const s: GateState = emptyState(new Date(sysInstant("2026-10-31 05:00")).toISOString());
    s.filled["2026-10-31/shower"] = "x";
    s.filled["2026-10-31/night-teeth"] = "x";
    s.filled[`${day}/morning-teeth`] = "x";
    const midnight = sysInstant("2026-11-02 00:00");
    expect(outstanding(s, midnight - 60_000).map((r) => r.slot)).toEqual([]);
    expect(outstanding(s, midnight).map((r) => r.slot)).toEqual([`${day}/shower`, `${day}/night-teeth`]);
    // ...and the next morning arms at 05:00 on the wall.
    s.filled[`${day}/shower`] = "x";
    s.filled[`${day}/night-teeth`] = "x";
    const morning = sysInstant("2026-11-02 05:00");
    expect(outstanding(s, morning - 60_000).map((r) => r.slot)).toEqual([]);
    expect(outstanding(s, morning).map((r) => r.slot)).toEqual(["2026-11-02/morning-teeth"]);
  });
});

// These tests are what prove the gate follows tzdata, so a machine without zic fails
// here instead of passing with them skipped (Arch: tzdata ships zic; macOS: built in).
test("zic is installed (the zone-database tests below need it)", () => {
  expect({ zic: hasZic ? "found" : "missing: install tzdata's zic, these tests must not be skipped" }).toEqual({ zic: "found" });
});

describe.if(hasZic)("follows whatever rule the zone database has", () => {
  function fakeTzdir(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "zone-test-"));
    writeFileSync(join(dir, "src.zi"), source);
    sh(["zic", "-d", dir, join(dir, "src.zi")]);
    return dir;
  }
  const OLD_RULE = [
    "Rule Old 2007 max - Mar Sun>=8 2:00 1:00 D",
    "Rule Old 2007 max - Nov Sun>=1 2:00 0 S",
  ];

  test("a database that keeps the old fall-back to PST", () => {
    const dir = fakeTzdir([...OLD_RULE, "Zone America/Vancouver -8:00 Old P%sT", ""].join("\n"));
    try {
      process.env.TZDIR = dir;
      resetZoneCache();
      const env = { TZDIR: dir };
      for (const iso of PROBES) {
        const ms = Date.parse(iso);
        expect({ iso, ...offsetAt(ms, ZONE), isDst: undefined }).toEqual({ iso, ...sysOffset(ms, env), isDst: undefined });
      }
      expect(zonedTime("2026-11-02", 0)).toBe(sysInstant("2026-11-02 00:00", env));
      expect(sysOffset(Date.parse("2026-11-02T07:25:00Z"), env).offsetMs).toBe(-8 * 3600_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database where BC changes its rule again later (UTC-6 from 2027-03-14)", () => {
    const dir = fakeTzdir([
      ...OLD_RULE,
      "Zone America/Vancouver -8:00 Old P%sT 2026 Nov 1 2:00",
      "\t-7:00 - MST 2027 Mar 14 2:00",
      "\t-6:00 - XST",
      "",
    ].join("\n"));
    try {
      process.env.TZDIR = dir;
      resetZoneCache();
      const env = { TZDIR: dir };
      for (const iso of PROBES) {
        const ms = Date.parse(iso);
        const { offsetMs, abbrev } = offsetAt(ms, ZONE);
        expect({ iso, offsetMs, abbrev }).toEqual({ iso, ...sysOffset(ms, env) });
      }
      for (const day of ["2027-03-13", "2027-03-15", "2027-07-01"])
        expect({ day, at: zonedTime(day, 300) }).toEqual({ day, at: sysInstant(`${day} 05:00`, env) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zone file that read before keeps its rule while missing mid-update, then reloads", () => {
    const dir = fakeTzdir(["Zone America/Vancouver -6:00 - XST", ""].join("\n"));
    const file = join(dir, "America/Vancouver");
    const realNow = Date.now;
    const quiet = console.error;
    try {
      process.env.TZDIR = dir;
      resetZoneCache();
      console.error = () => {};
      const ms = Date.parse("2030-01-01T00:00:00Z");
      expect(offsetAt(ms, ZONE).offsetMs).toBe(-6 * 3600_000);
      const logged: string[] = [];
      console.error = (...a: unknown[]) => void logged.push(a.join(" "));
      rmSync(file);
      Date.now = () => realNow() + 61_000;
      // Gone for a moment (a tzdata upgrade): still the file's rule, never Intl, and said so.
      expect(offsetAt(ms, ZONE)).toMatchObject({ offsetMs: -6 * 3600_000, abbrev: "XST" });
      expect(zoneSource(ZONE).kind).toBe("stale");
      expect(logged.join("\n")).toContain("last good copy");
      expect(logged.join("\n")).not.toContain("using Intl");
      writeFileSync(join(dir, "src.zi"), ["Zone America/Vancouver -5:00 - YST", ""].join("\n"));
      sh(["zic", "-d", dir, join(dir, "src.zi")]);
      Date.now = () => realNow() + 122_000;
      expect(offsetAt(ms, ZONE)).toMatchObject({ offsetMs: -5 * 3600_000, abbrev: "YST" });
      expect(zoneSource(ZONE).kind).toBe("tzif");
    } finally {
      Date.now = realNow;
      console.error = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Root reads a mode-000 file anyway, so this cannot be shown as root.
  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)(`a zone file that could not be read is retried once readable, even with the same stamp${asRoot ? " (SKIPPED: running as root)" : ""}`, () => {
    const dir = fakeTzdir(["Zone America/Vancouver -6:00 - XST", ""].join("\n"));
    const file = join(dir, "America/Vancouver");
    const realNow = Date.now;
    const quiet = console.error;
    try {
      process.env.TZDIR = dir;
      resetZoneCache();
      chmodSync(file, 0o000);
      console.error = () => {};
      const ms = Date.parse("2030-01-01T00:00:00Z");
      // Unreadable: the Intl fallback, whatever this runtime says (never XST's -6).
      expect(offsetAt(ms, ZONE).offsetMs).not.toBe(-6 * 3600_000);
      chmodSync(file, 0o644);
      Date.now = () => realNow() + 61_000;
      expect(offsetAt(ms, ZONE)).toMatchObject({ offsetMs: -6 * 3600_000, abbrev: "XST" });
    } finally {
      Date.now = realNow;
      console.error = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zone file replaced under a running process is picked up", () => {
    const dir = fakeTzdir(["Zone America/Vancouver -7:00 - MST", ""].join("\n"));
    try {
      process.env.TZDIR = dir;
      resetZoneCache();
      const ms = Date.parse("2030-01-01T00:00:00Z");
      expect(offsetAt(ms, ZONE).offsetMs).toBe(-7 * 3600_000);
      writeFileSync(join(dir, "src.zi"), ["Zone America/Vancouver -6:00 - XST", ""].join("\n"));
      sh(["zic", "-d", dir, join(dir, "src.zi")]);
      // Within a minute of the last check the cached rule stands; a later check reloads.
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 61_000;
        expect(offsetAt(ms, ZONE)).toMatchObject({ offsetMs: -6 * 3600_000, abbrev: "XST" });
      } finally {
        Date.now = realNow;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POSIX TZ footer rules", () => {
  const rule = (tz: string) => {
    const r = parsePosixTz(tz);
    if (!r) throw new Error(`unparsed: ${tz}`);
    return r;
  };
  test("parses the forms tzdata writes", () => {
    expect(parsePosixTz("MST7")).toEqual({ std: { abbrev: "MST", utoff: -7 * 3600 } });
    expect(parsePosixTz("<+0330>-3:30")).toEqual({ std: { abbrev: "+0330", utoff: 3.5 * 3600 } });
    expect(rule("PST8PDT,M3.2.0,M11.1.0").dst).toMatchObject({ abbrev: "PDT", utoff: -7 * 3600, startTime: 7200, endTime: 7200 });
    expect(rule("<-03>3<-02>,M3.5.0/-2,M10.5.0/-1").dst).toMatchObject({ startTime: -7200, endTime: -3600 });
    expect(parsePosixTz("")).toBeNull();
    expect(parsePosixTz("PST8PDT,M13.1.0,M11.1.0")).toBeNull();
    expect(parsePosixTz("PST8PDT,M3.2.0")).toBeNull();
  });

  test("rule-driven transitions match glibc for northern and southern zones", () => {
    for (const tz of ["PST8PDT,M3.2.0,M11.1.0", "AEST-10AEDT,M10.1.0,M4.1.0/3", "<-03>3<-02>,M3.5.0/-2,M10.5.0/-1", "XXX5YYY,J60/1,J300/3", "XXX5YYY,59/1,299/3"]) {
      const r = rule(tz);
      for (const iso of ["2028-01-15T12:00:00Z", "2028-03-12T09:59:59Z", "2028-03-12T10:00:00Z", "2028-04-02T15:59:59Z", "2028-04-02T16:00:00Z", "2028-07-01T00:00:00Z", "2028-10-01T15:59:59Z", "2028-10-01T16:00:00Z", "2028-11-05T08:59:59Z", "2028-11-05T09:00:00Z", "2028-12-31T23:30:00Z"]) {
        const ms = Date.parse(iso);
        // A TZ string with a rule needs no zone file: glibc evaluates it directly.
        const want = sysOffset(ms, { TZ: tz, TZDIR: "/nonexistent" });
        const got = posixOffsetAt(r, ms);
        expect({ tz, iso, offsetMs: got.offsetMs, abbrev: got.abbrev }).toEqual({ tz, iso, ...want });
      }
    }
  });
});
