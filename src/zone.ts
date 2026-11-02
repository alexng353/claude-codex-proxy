/**
 * Wall-clock time from the system zone database, not from the runtime's ICU.
 *
 * Bun ships its own ICU time-zone table and it lags tzdata: bun 1.4.3 still
 * had America/Vancouver falling back to PST (UTC-8) on 2026-11-01, while
 * tzdata 2026 keeps BC at UTC-7 from then on (permanent daylight time, named
 * MST). `Intl.DateTimeFormat` and local `Date` getters in bun therefore read
 * Alex's clock an hour behind. This module reads the TZif file the OS
 * (glibc, `date`, Python, the Today daemon) uses, so the proxy follows the
 * same rule whenever tzdata changes, with no code change.
 *
 * Lookup order: `$TZDIR/<name>` (default /usr/share/zoneinfo); for the local
 * zone, `$TZ` (a name, `:name` or a path) then /etc/localtime. The file is
 * re-checked at most once a minute, so a tzdata update applies without a
 * restart. If no file can be read, it falls back to Intl and says so once.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Offset = { offsetMs: number; abbrev: string; isDst: boolean };

export type WallTime = {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  abbrev: string;
  offsetMs: number;
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const RECHECK_MS = 60_000;
const DAY_S = 86_400;

// ---- POSIX TZ rule (the TZif footer, RFC 8536 section 3.3) ----

type RuleDate = { kind: "J"; day: number } | { kind: "n"; day: number } | { kind: "M"; month: number; week: number; weekday: number };
type PosixRule = {
  std: { abbrev: string; utoff: number };
  dst?: { abbrev: string; utoff: number; start: RuleDate; startTime: number; end: RuleDate; endTime: number };
};

/** Parses a POSIX TZ string such as "MST7" or "PST8PDT,M3.2.0,M11.1.0". Offsets are seconds east of UTC. */
export function parsePosixTz(text: string): PosixRule | null {
  let i = 0;
  const name = (): string | null => {
    if (text[i] === "<") {
      const close = text.indexOf(">", i);
      if (close < 0) return null;
      const n = text.slice(i + 1, close);
      i = close + 1;
      return n.length >= 3 ? n : null;
    }
    const m = /^[A-Za-z]{3,}/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  // [+-]hh[:mm[:ss]] in seconds; hours may run to 167 (RFC 8536 extension for rule times).
  const time = (): number | null => {
    const m = /^([+-]?)(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    const s = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
    return m[1] === "-" ? -s : s;
  };
  const date = (): RuleDate | null => {
    let m: RegExpExecArray | null;
    const rest = text.slice(i);
    if ((m = /^M(\d{1,2})\.(\d)\.(\d)/.exec(rest))) {
      i += m[0].length;
      const [month, week, weekday] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (month < 1 || month > 12 || week < 1 || week > 5 || weekday > 6) return null;
      return { kind: "M", month, week, weekday };
    }
    if ((m = /^J(\d{1,3})/.exec(rest))) {
      i += m[0].length;
      const day = Number(m[1]);
      return day >= 1 && day <= 365 ? { kind: "J", day } : null;
    }
    if ((m = /^(\d{1,3})/.exec(rest))) {
      i += m[0].length;
      const day = Number(m[1]);
      return day <= 365 ? { kind: "n", day } : null;
    }
    return null;
  };

  const stdName = name();
  if (!stdName) return null;
  const stdOff = time();
  if (stdOff === null) return null;
  // POSIX offsets are west of UTC ("MST7" is UTC-7).
  const rule: PosixRule = { std: { abbrev: stdName, utoff: -stdOff } };
  if (i === text.length) return rule;
  const dstName = name();
  if (!dstName) return null;
  let dstUtoff = rule.std.utoff + 3600;
  if (i < text.length && text[i] !== ",") {
    const off = time();
    if (off === null) return null;
    dstUtoff = -off;
  }
  // A DST name with no rule: the POSIX default is the US rule.
  let start: RuleDate = { kind: "M", month: 3, week: 2, weekday: 0 };
  let end: RuleDate = { kind: "M", month: 11, week: 1, weekday: 0 };
  let startTime = 7200;
  let endTime = 7200;
  if (text[i] === ",") {
    i++;
    const s = date();
    if (!s) return null;
    start = s;
    if (text[i] === "/") {
      i++;
      const t = time();
      if (t === null) return null;
      startTime = t;
    }
    if (text[i] !== ",") return null;
    i++;
    const e = date();
    if (!e) return null;
    end = e;
    if (text[i] === "/") {
      i++;
      const t = time();
      if (t === null) return null;
      endTime = t;
    }
  }
  if (i !== text.length) return null;
  rule.dst = { abbrev: dstName, utoff: dstUtoff, start, startTime, end, endTime };
  return rule;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Seconds from the epoch to local midnight of the rule's date in `year` (as if UTC). */
function ruleDay(year: number, d: RuleDate): number {
  const jan1 = Date.UTC(year, 0, 1) / 1000;
  if (d.kind === "J") {
    // 1-365, February 29 never counted.
    const extra = isLeap(year) && d.day >= 60 ? 1 : 0;
    return jan1 + (d.day - 1 + extra) * DAY_S;
  }
  if (d.kind === "n") return jan1 + d.day * DAY_S;
  const first = Date.UTC(year, d.month - 1, 1) / 1000;
  const firstWeekday = new Date(first * 1000).getUTCDay();
  let day = 1 + ((d.weekday - firstWeekday + 7) % 7) + (d.week - 1) * 7;
  const length = new Date(Date.UTC(year, d.month, 0)).getUTCDate();
  while (day > length) day -= 7;
  return first + (day - 1) * DAY_S;
}

function ruleOffset(rule: PosixRule, t: number): Offset {
  const std = { offsetMs: rule.std.utoff * 1000, abbrev: rule.std.abbrev, isDst: false };
  const dst = rule.dst;
  if (!dst) return std;
  const year = new Date((t + rule.std.utoff) * 1000).getUTCFullYear();
  // Each transition time is in the local time in effect just before it.
  const start = ruleDay(year, dst.start) + dst.startTime - rule.std.utoff;
  const end = ruleDay(year, dst.end) + dst.endTime - dst.utoff;
  const inDst = start < end ? t >= start && t < end : !(t >= end && t < start);
  return inDst ? { offsetMs: dst.utoff * 1000, abbrev: dst.abbrev, isDst: true } : std;
}

/** A POSIX TZ rule's offset at `ms` (exported for tests). */
export function posixOffsetAt(rule: PosixRule, ms: number): Offset {
  return ruleOffset(rule, Math.floor(ms / 1000));
}

// ---- TZif (RFC 8536) ----

type Tzif = {
  times: number[];
  idx: number[];
  types: { utoff: number; isDst: boolean; abbrev: string }[];
  footer: PosixRule | null;
};

export function parseTzif(buf: Uint8Array): Tzif {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== "TZif") throw new Error("not a TZif file");
  const version = buf[4];
  const header = (at: number) => ({
    isutcnt: view.getUint32(at + 20),
    isstdcnt: view.getUint32(at + 24),
    leapcnt: view.getUint32(at + 28),
    timecnt: view.getUint32(at + 32),
    typecnt: view.getUint32(at + 36),
    charcnt: view.getUint32(at + 40),
  });
  let at = 0;
  let h = header(0);
  let timeSize = 4;
  if (version >= 0x32) {
    // Skip the 32-bit block; the 64-bit one after it covers every instant.
    at = 44 + h.timecnt * 4 + h.timecnt + h.typecnt * 6 + h.charcnt + h.leapcnt * 8 + h.isstdcnt + h.isutcnt;
    h = header(at);
    timeSize = 8;
  }
  if (h.typecnt === 0) throw new Error("TZif file has no time types");
  let p = at + 44;
  const times: number[] = [];
  for (let k = 0; k < h.timecnt; k++, p += timeSize)
    times.push(timeSize === 8 ? Number(view.getBigInt64(p)) : view.getInt32(p));
  const idx = Array.from(buf.subarray(p, p + h.timecnt));
  p += h.timecnt;
  const raw: { utoff: number; isDst: boolean; desig: number }[] = [];
  for (let k = 0; k < h.typecnt; k++, p += 6)
    raw.push({ utoff: view.getInt32(p), isDst: buf[p + 4] === 1, desig: buf[p + 5] });
  const chars = buf.subarray(p, p + h.charcnt);
  p += h.charcnt + h.leapcnt * (timeSize + 4) + h.isstdcnt + h.isutcnt;
  const abbrevAt = (start: number) => {
    let end = start;
    while (end < chars.length && chars[end] !== 0) end++;
    return String.fromCharCode(...chars.subarray(start, end));
  };
  const types = raw.map((r) => ({ utoff: r.utoff, isDst: r.isDst, abbrev: abbrevAt(r.desig) }));
  if (idx.some((k) => k >= types.length)) throw new Error("TZif transition names a missing type");
  let footer: PosixRule | null = null;
  if (timeSize === 8 && buf[p] === 0x0a) {
    const close = buf.indexOf(0x0a, p + 1);
    const text = String.fromCharCode(...buf.subarray(p + 1, close < 0 ? buf.length : close));
    footer = text ? parsePosixTz(text) : null;
  }
  return { times, idx, types, footer };
}

function tzifOffset(z: Tzif, t: number): Offset {
  const asOffset = (k: number): Offset => ({ offsetMs: z.types[k].utoff * 1000, abbrev: z.types[k].abbrev, isDst: z.types[k].isDst });
  if (!z.times.length || t < z.times[0]) {
    if (!z.times.length && z.footer) return ruleOffset(z.footer, t);
    return asOffset(0);
  }
  if (t >= z.times[z.times.length - 1] && z.footer) return ruleOffset(z.footer, t);
  let lo = 0;
  let hi = z.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (z.times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return asOffset(z.idx[lo]);
}

// ---- Zone lookup ----

type Source = { kind: "tzif" | "intl"; offset(t: number): Offset };
type Entry = { path: string | null; stamp: string; checkedAt: number; source: Source };
const cache = new Map<string, Entry>();
const warned = new Set<string>();

const VALID_NAME = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

/** The TZif path for a zone name, or for the local zone when `name` is undefined. */
function zonePath(name: string | undefined): string | null {
  const dir = process.env.TZDIR || "/usr/share/zoneinfo";
  if (name === undefined) {
    const tz = process.env.TZ;
    if (tz === undefined || tz === "" || tz === ":") return "/etc/localtime";
    const spec = tz.startsWith(":") ? tz.slice(1) : tz;
    if (isAbsolute(spec)) return spec;
    return VALID_NAME.test(spec) ? join(dir, spec) : null;
  }
  return VALID_NAME.test(name) ? join(dir, name) : null;
}

function fileStamp(path: string): string | null {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Intl, for a zone with no readable TZif file (it may lag tzdata; see the top of this file). */
function intlSource(name: string | undefined): Source {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: name,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return {
    kind: "intl",
    offset(t) {
      const parts = Object.fromEntries(format.formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
      const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
      return { offsetMs: wall - t * 1000, abbrev: parts.timeZoneName ?? "", isDst: false };
    },
  };
}

function load(key: string, name: string | undefined, now: number): Source {
  const path = zonePath(name);
  const hit = cache.get(key);
  if (hit && hit.path === path && now - hit.checkedAt < RECHECK_MS) return hit.source;
  const stamp = path ? fileStamp(path) : null;
  if (hit && hit.path === path && stamp !== null && hit.stamp === stamp) {
    hit.checkedAt = now;
    return hit.source;
  }
  let source: Source | null = null;
  if (path && stamp !== null) {
    try {
      const z = parseTzif(readFileSync(path));
      source = { kind: "tzif", offset: (t) => tzifOffset(z, t) };
    } catch (error) {
      if (!warned.has(path)) console.error(`zone: cannot read ${path}: ${(error as Error).message}; using Intl`);
      warned.add(path);
    }
  } else if (!warned.has(key)) {
    console.error(`zone: no zone file for ${name ?? "the local zone"}${path ? ` (${path})` : ""}; using Intl`);
    warned.add(key);
  }
  if (!source) {
    try {
      source = intlSource(name);
    } catch {
      source = intlSource("UTC");
    }
  }
  cache.set(key, { path, stamp: stamp ?? "", checkedAt: now, source });
  return source;
}

/** UTC offset and abbreviation in effect at `ms` in zone `name` (undefined: this machine's zone). */
export function offsetAt(ms: number, name?: string): Offset {
  const key = name ?? "\0local";
  return load(key, name, Date.now()).offset(Math.floor(ms / 1000));
}

/** Where zone `name`'s offsets come from: the zone database file, or the Intl fallback. */
export function zoneSource(name?: string): { kind: "tzif" | "intl"; path: string | null } {
  const key = name ?? "\0local";
  const kind = load(key, name, Date.now()).kind;
  return { kind, path: cache.get(key)?.path ?? null };
}

/** This runtime's own Intl offset for `name` at `ms` (what bun's bundled ICU says). */
export function intlOffsetAt(ms: number, name?: string): Offset {
  return intlSource(name).offset(Math.floor(ms / 1000));
}

/** Wall-clock fields at `ms` in zone `name` (undefined: this machine's zone). */
export function wallTime(ms: number, name?: string): WallTime {
  const { offsetMs, abbrev } = offsetAt(ms, name);
  const d = new Date(Math.floor(ms / 1000) * 1000 + offsetMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    abbrev,
    offsetMs,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" at `ms` in zone `name`. */
export function dayKey(ms: number, name?: string): string {
  const w = wallTime(ms, name);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** "YYYY-MM-DD HH:MM:SS ZONE" at `ms` in zone `name`. */
export function stampLabel(ms: number, name?: string): string {
  const w = wallTime(ms, name);
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${w.abbrev}`;
}

/** For tests: forget cached zones so a changed TZDIR or TZ applies at once. */
export function resetZoneCache(): void {
  cache.clear();
  warned.clear();
}
