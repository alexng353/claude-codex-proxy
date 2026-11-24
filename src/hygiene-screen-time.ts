/** Config-only phone diagnostics. Reports never authorize a grant or change gate policy. */
import { knownZone, type GateState } from "./hygiene";

export type ScreenTimeReport = {
  version: 1;
  build: string;
  reported_at: string;
  authorization: "approved" | "denied" | "notDetermined";
  time_zone: string;
  bedtime_enabled: boolean;
  late_start_minute: number;
  full_start_minute: number;
  wake_minute: number;
  late_app_count: number;
  late_category_count: number;
  late_web_count: number;
  allowlist_app_count: number;
  allowlist_category_count: number;
  allowlist_web_count: number;
  scheduled_at: string | null;
  adult_filter_enabled: boolean;
  adult_filter_applied: boolean;
  adult_filter_unlock_until: string | null;
};
export type ScreenTimeSnapshot = ScreenTimeReport & { device_id: string; received_at: string };
const MINUTES = ["late_start_minute", "full_start_minute", "wake_minute"] as const;
const COUNTS = ["late_app_count", "late_category_count", "late_web_count", "allowlist_app_count", "allowlist_category_count", "allowlist_web_count"] as const;
const FLAGS = ["bedtime_enabled", "adult_filter_enabled", "adult_filter_applied"] as const;
const KEYS = ["version", "build", "reported_at", "authorization", "time_zone", ...MINUTES, ...COUNTS, ...FLAGS, "scheduled_at", "adult_filter_unlock_until"] as const;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
function iso(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 40) return false;
  const match = ISO.exec(v);
  if (!match || !Number.isFinite(Date.parse(v))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(n => Number(n ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second < 60;
}
const boundedInt = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Strict allowlist: identity is stamped by the server, and no app or browsing data is accepted. */
export function parseScreenTime(body: unknown): ScreenTimeReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !(KEYS as readonly string[]).includes(k)) || KEYS.some(k => !Object.hasOwn(b, k))) return null;
  if (b.version !== 1 || typeof b.build !== "string" || b.build.length > 64 || !iso(b.reported_at) ||
    !["approved", "denied", "notDetermined"].includes(b.authorization as string) ||
    typeof b.time_zone !== "string" || !knownZone(b.time_zone) ||
    MINUTES.some(k => !boundedInt(b[k], 1439)) || COUNTS.some(k => !boundedInt(b[k], 10000)) ||
    FLAGS.some(k => typeof b[k] !== "boolean") ||
    (b.scheduled_at !== null && !iso(b.scheduled_at)) || (b.adult_filter_unlock_until !== null && !iso(b.adult_filter_unlock_until))) return null;
  return Object.fromEntries(KEYS.map(k => [k, b[k]])) as ScreenTimeReport;
}

export function storeScreenTime(state: GateState, report: ScreenTimeReport, deviceId: string, now: number): void {
  state.screenTime = (state.screenTime ?? []).filter(r => r.device_id !== deviceId);
  state.screenTime.push({ ...report, device_id: deviceId, received_at: new Date(now).toISOString() });
}

export function screenTimeView(state: GateState, now: number) {
  const latest = state.screenTime?.at(-1);
  return latest ? { ...latest, stale: now - Date.parse(latest.received_at) > 24 * 60 * 60_000 } : null;
}

/** Rebuild the MCP view from known fields, even if another proxy version adds data later. */
export function summarizeScreenTime(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const s = input as Record<string, unknown>;
  const report = parseScreenTime(Object.fromEntries(KEYS.map(k => [k, s[k]])));
  if (!report || typeof s.device_id !== "string" || !iso(s.received_at) || typeof s.stale !== "boolean") return null;
  return { ...report, device_id: s.device_id, received_at: s.received_at, stale: s.stale };
}
