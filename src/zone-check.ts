/**
 * Startup self-check: does this runtime's Intl agree with the system zone
 * database about Alex's zone, and is the hygiene clock really reading the
 * database? (dst-hygiene-gate, Nov 2 2026: bun 1.4.3's ICU had Vancouver at
 * PST from 2026-11-01, an hour behind tzdata, and the gate followed it.)
 *
 * - The gate's clock on the Intl fallback (no readable zone file): an error,
 *   paged, because the gate's windows may be an hour off.
 * - Intl disagreeing with the database: logged and paged once per runtime
 *   version and year (a marker file in the state dir keeps handoffs quiet).
 *   The gate is unaffected (it reads src/zone.ts); anything still on Intl is not.
 * Pages go to COMB_BLOCKED_PAGE_THREAD on this machine, like blocked-task pages.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { localMachine, THREAD_ID } from "./hygiene-wake";
import { stateDir } from "./sessions";
import { intlOffsetAt, offsetAt, zoneSource, type Offset } from "./zone";

export const CHECK_ZONE = "America/Vancouver";
const RECHECK_MS = 12 * 60 * 60 * 1000;

export type ZoneCheck = {
  zone: string;
  runtime: string;
  source: "tzif" | "intl";
  path: string | null;
  /** Intl and the zone database give the same UTC offset at every probe. */
  runtimeAgrees: boolean;
  /** The first probe where they differ. */
  mismatch?: { at: string; database: Offset; runtime: Offset };
  year: number;
};

export const runtimeName = () =>
  typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;

/**
 * Fixed probes (noon UTC on the 1st and 15th of every month of this year and
 * the next), so the same runtime and data give the same result and the page
 * text stays identical across restarts. `now` is probed last.
 */
export function probes(now: number): number[] {
  const year = new Date(now).getUTCFullYear();
  const out: number[] = [];
  for (const y of [year, year + 1])
    for (let m = 0; m < 12; m++) for (const d of [1, 15]) out.push(Date.UTC(y, m, d, 12));
  return out;
}

export function checkZone(
  now = Date.now(),
  zone = CHECK_ZONE,
  runtimeOffset: (ms: number, zone: string) => Offset = intlOffsetAt,
): ZoneCheck {
  const { kind, path } = zoneSource(zone);
  const check: ZoneCheck = {
    zone, runtime: runtimeName(), source: kind, path, runtimeAgrees: true, year: new Date(now).getUTCFullYear(),
  };
  for (const at of [...probes(now), now]) {
    const database = offsetAt(at, zone);
    const runtime = runtimeOffset(at, zone);
    if (database.offsetMs !== runtime.offsetMs) {
      check.runtimeAgrees = false;
      check.mismatch = { at: new Date(at).toISOString(), database, runtime };
      break;
    }
  }
  return check;
}

const utc = (o: Offset) => {
  const m = Math.round(o.offsetMs / 60_000);
  const a = Math.abs(m);
  const mm = a % 60 ? `:${String(a % 60).padStart(2, "0")}` : "";
  return `UTC${m < 0 ? "-" : "+"}${Math.floor(a / 60)}${mm} (${o.abbrev})`;
};

/** What to log and page, or null when all is well. Deterministic for one runtime, data set and year. */
export function zoneAlarm(c: ZoneCheck): { level: "error" | "warn"; key: string; text: string } | null {
  if (c.source !== "tzif")
    return {
      level: "error",
      key: `zone-fallback-${c.year}`,
      text: `[agent] claude-codex-proxy zone self-check: no readable zone file for ${c.zone} (${c.path ?? "no path"}), so the hygiene gate's clock fell back to ${c.runtime}'s Intl, which may lag tzdata. Gate windows can be an hour off until the zone file is readable again.`,
    };
  if (!c.runtimeAgrees && c.mismatch)
    return {
      level: "warn",
      key: `zone-intl-${c.runtime.replace(/[^A-Za-z0-9.]+/g, "_")}-${c.year}`,
      text: `[agent] claude-codex-proxy zone self-check: ${c.runtime}'s Intl disagrees with the system zone database for ${c.zone}. At ${c.mismatch.at} Intl says ${utc(c.mismatch.runtime)}, the database (${c.path}) says ${utc(c.mismatch.database)}. The hygiene gate reads the database (src/zone.ts) and is unaffected; anything else in this runtime that formats Vancouver times with Intl or local Date is off by the difference.`,
    };
  return null;
}

type Sender = (text: string, id: string) => Promise<boolean>;

/** Today's `today-daemon send` to COMB_BLOCKED_PAGE_THREAD, this machine only. */
export const sendZonePage: Sender = async (text, id) => {
  // No test may ever message a real chat.
  if (process.env.NODE_ENV === "test" || process.env.COMB_BLOCKED_PAGE === "off") return false;
  const thread = process.env.COMB_BLOCKED_PAGE_THREAD?.trim();
  const machine = process.env.COMB_BLOCKED_PAGE_MACHINE?.trim() || localMachine();
  if (!thread || !THREAD_ID.test(thread) || machine !== localMachine() || !/^zone-[A-Za-z0-9._-]{1,80}$/.test(id))
    return false;
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const argv = [
    process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon"),
    "send", "--socket", `/run/user/${process.getuid!()}/today/daemon.sock`, "--from", "claude-codex-proxy",
    "--client-message-id", id, "--", thread, "-",
  ];
  const child = Bun.spawn(argv, { env, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) console.error(`zone-check: page failed (exit ${code}): ${error.trim().slice(0, 200)}`);
    return code === 0;
  } finally {
    clearTimeout(timer);
  }
};

let last: ZoneCheck | null = null;
/** The newest self-check result, for /health. */
export const lastZoneCheck = () => last;

/** Runs one check: logs, and pages once per alarm key (marker files in `dir`). */
export async function runZoneCheck({
  now = Date.now(),
  send = sendZonePage,
  dir = join(stateDir(), "zone-check"),
  check = (at: number) => checkZone(at),
}: { now?: number; send?: Sender; dir?: string; check?: (now: number) => ZoneCheck } = {}): Promise<{
  check: ZoneCheck;
  paged: boolean;
}> {
  const c = check(now);
  last = c;
  // Back on the zone file: the next fallback is a new episode and pages again.
  if (c.source === "tzif" && existsSync(dir))
    for (const f of readdirSync(dir)) if (f.startsWith("zone-fallback-")) unlinkSync(join(dir, f));
  const alarm = zoneAlarm(c);
  if (!alarm) return { check: c, paged: false };
  (alarm.level === "error" ? console.error : console.warn)(alarm.text.replace(/^\[agent\] /, ""));
  const marker = join(dir, alarm.key);
  if (existsSync(marker)) return { check: c, paged: false };
  const paged = await send(alarm.text, alarm.key).catch(() => false);
  if (paged) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
  }
  return { check: c, paged };
}

/** At startup and every 12 h (a tzdata update or a fallback mid-run is caught too). Returns a stop function. */
export function startZoneCheck(): () => void {
  const run = () => void runZoneCheck().catch((e) => console.error("zone-check failed:", (e as Error).message));
  run();
  const timer = setInterval(run, RECHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
