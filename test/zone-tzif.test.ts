import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offsetAt, parseTzif, posixOffsetAt, resetZoneCache, wallTime } from "../src/zone";

/**
 * The transition table and the footer, each checked against glibc reading the
 * same file, plus the shape of file tzdata 2026f warned about: zic 2023d-2026a
 * in slim mode could drop Vancouver's last transition (PDT isdst=1 -> MST
 * isdst=0), leaving a footer that disagrees with the table's last type
 * (RFC 9636 section 3.3), and some readers then ignored the transition.
 */
const ZONE = "America/Vancouver";
const SYSTEM = join(process.env.TZDIR || "/usr/share/zoneinfo", ZONE);

function sysOffset(ms: number, env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["date", "-d", `@${Math.floor(ms / 1000)}`, "+%z %Z"], { env: { ...process.env, TZ: ZONE, ...env } });
  const [z, abbrev] = run.stdout.toString().trim().split(" ");
  const sign = z[0] === "-" ? -1 : 1;
  return { offsetMs: sign * (Number(z.slice(1, 3)) * 3600 + Number(z.slice(3, 5)) * 60) * 1000, abbrev };
}

const savedTzdir = process.env.TZDIR;
afterEach(() => {
  if (savedTzdir === undefined) delete process.env.TZDIR;
  else process.env.TZDIR = savedTzdir;
  resetZoneCache();
});

describe("system zone file", () => {
  const z = parseTzif(readFileSync(SYSTEM));

  test("every table transition from 2024 on matches glibc on both sides", () => {
    const recent = z.times.filter((t) => t >= Date.UTC(2024, 0, 1) / 1000);
    expect(recent.length).toBeGreaterThan(0);
    for (const t of recent)
      for (const ms of [t * 1000 - 1000, t * 1000]) {
        const { offsetMs, abbrev } = offsetAt(ms, ZONE);
        expect({ ms, offsetMs, abbrev }).toEqual({ ms, ...sysOffset(ms) });
      }
  });

  test("the footer matches glibc after the table ends", () => {
    expect(z.footer).not.toBeNull();
    const end = z.times.at(-1)!;
    for (const years of [0.5, 1, 3, 10, 25]) {
      const ms = (end + years * 365.25 * 86400) * 1000;
      const footer = posixOffsetAt(z.footer!, ms);
      expect({ years, offsetMs: footer.offsetMs, abbrev: footer.abbrev }).toEqual({ years, ...sysOffset(ms) });
    }
  });

  test("footer and last transition agree (RFC 9636 section 3.3; the 2026f slim-zic bug breaks this)", () => {
    const end = z.times.at(-1)!;
    const last = z.types[z.idx.at(-1)!];
    const footer = posixOffsetAt(z.footer!, end * 1000);
    expect({ utoff: footer.offsetMs / 1000, isDst: footer.isDst, abbrev: footer.abbrev }).toEqual({
      utoff: last.utoff,
      isDst: last.isDst,
      abbrev: last.abbrev,
    });
  });
});

/** A v2 TZif: `transitions` [unix seconds, type index], `types` [utoff, isDst, abbrev]. */
function tzif(transitions: [number, number][], types: [number, boolean, string][], footer: string): Uint8Array {
  const chars: number[] = [];
  const desig = types.map(([, , a]) => {
    const at = chars.length;
    chars.push(...[...a].map((c) => c.charCodeAt(0)), 0);
    return at;
  });
  const header = (timecnt: number, typecnt: number, charcnt: number) => {
    const h = new Uint8Array(44);
    h.set([0x54, 0x5a, 0x69, 0x66, 0x32]);
    const v = new DataView(h.buffer);
    v.setUint32(32, timecnt);
    v.setUint32(36, typecnt);
    v.setUint32(40, charcnt);
    return h;
  };
  // Empty v1 block (one type, as RFC 9636 requires), then the v2 data and footer.
  const v1 = [header(0, 1, 4), new Uint8Array([0, 0, 0, 0, 0, 0]), new Uint8Array([0x55, 0x54, 0x43, 0])];
  const body = new Uint8Array(transitions.length * 9 + types.length * 6 + chars.length);
  const v = new DataView(body.buffer);
  let p = 0;
  for (const [t] of transitions) (v.setBigInt64(p, BigInt(t)), (p += 8));
  for (const [, k] of transitions) body[p++] = k;
  types.forEach(([utoff, isDst], k) => {
    v.setInt32(p, utoff);
    body[p + 4] = isDst ? 1 : 0;
    body[p + 5] = desig[k];
    p += 6;
  });
  body.set(chars, p);
  const tail = new TextEncoder().encode(`\n${footer}\n`);
  const parts = [...v1, header(transitions.length, types.length, chars.length), body, tail];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) (out.set(x, at), (at += x.length));
  return out;
}

describe("a TZif in the 2026f-bug shape", () => {
  // Table ends at the 2026-03-08 change to PDT (isdst=1); the Nov 1 transition
  // to MST is missing; the footer says MST7. The footer disagrees with the last type.
  const MAR_2025 = Date.UTC(2025, 2, 9, 10) / 1000;
  const NOV_2025 = Date.UTC(2025, 10, 2, 9) / 1000;
  const MAR_2026 = Date.UTC(2026, 2, 8, 10) / 1000;
  const file = tzif(
    [[MAR_2025, 1], [NOV_2025, 0], [MAR_2026, 1]],
    [[-28800, false, "PST"], [-25200, true, "PDT"]],
    "MST7",
  );

  test("is read with the right UTC offset on every side of both 2026 changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "zone-bug-"));
    try {
      mkdirSync(join(dir, "America"));
      writeFileSync(join(dir, ZONE), file);
      process.env.TZDIR = dir;
      resetZoneCache();
      expect(offsetAt(Date.UTC(2026, 2, 8, 9, 59) , ZONE).offsetMs).toBe(-28800_000);
      // UTC-7 from Mar 8 2026 on, whichever of the table (PDT) or footer (MST) a reader trusts.
      for (const iso of ["2026-03-08T10:00:00Z", "2026-07-01T12:00:00Z", "2026-11-01T09:30:00Z", "2026-11-02T07:25:00Z", "2028-01-01T00:00:00Z"])
        expect({ iso, offsetMs: offsetAt(Date.parse(iso), ZONE).offsetMs }).toEqual({ iso, offsetMs: -25200_000 });
      const w = wallTime(Date.parse("2026-11-02T07:25:00Z"), ZONE);
      expect([w.day, w.hour, w.minute]).toEqual([2, 0, 25]);
      // And glibc, reading the same file, agrees on the offset.
      expect(sysOffset(Date.parse("2026-11-02T07:25:00Z"), { TZDIR: dir }).offsetMs).toBe(-25200_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the section 3.3 check catches it", () => {
    const z = parseTzif(file);
    const last = z.types[z.idx.at(-1)!];
    const footer = posixOffsetAt(z.footer!, z.times.at(-1)! * 1000);
    expect(footer.isDst === last.isDst && footer.abbrev === last.abbrev).toBe(false);
  });
});
