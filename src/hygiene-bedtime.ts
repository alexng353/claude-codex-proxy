/** Phone bedtime exceptions share the debt ledger, but never the hygiene unlock. */
import { recordBypass, zoneAt, type GateState } from "./hygiene";
import { dayKey } from "./zone";
import { ensurePhrase, matchesPhrase, retire } from "./bypass-phrase";

export const BEDTIME_OWNER = "0b7c3073-04a4-404f-87d1-50e7f6359ba1";
export const BEDTIME_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9._:-]{1,80}$/;
export type BedtimeResult = { ok: false; statusCode: number; error: string } | {
  ok: true; message: string; id?: string; status?: string; duplicate?: boolean; granted?: boolean;
};
const fail = (statusCode: number, error: string): BedtimeResult => ({ ok: false, statusCode, error });
const bedtimeState = (state: GateState) => state.bedtime ??= { requests: [] };
export function bedtimeUnlockUntil(state: GateState, now: number): string | undefined {
  const until = state.bedtime?.unlockUntil;
  return until && Date.parse(until) > now ? until : undefined;
}

/** Account even a late offline tap. No historical hygiene requirements are attributed to bedtime. */
export function chargeBedtime(state: GateState, anchor: number, until: number, now: number): string {
  const b = bedtimeState(state);
  recordBypass(state, new Date(anchor).toISOString(), "bedtime");
  const id = `bedtime-${anchor}-${state.bypass.count}`;
  state.debts.push({ id, at: new Date(anchor).toISOString(), skipped: ["bedtime"], items: [], bedtime: true, status: "open" });
  if (until > now) {
    b.unlockUntil = new Date(Math.min(now + BEDTIME_MS, Math.max(until, Date.parse(b.unlockUntil ?? "") || 0))).toISOString();
    retire(b);
  }
  return id;
}

export function requestBedtime(state: GateState, input: { id?: unknown; reason?: unknown }, by: string, now: number): BedtimeResult {
  if (typeof input?.id !== "string" || !ID.test(input.id)) return fail(400, "id must be 1-80 letters, digits, . _ : -");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 1000)
    return fail(400, "reason must be 1-1000 characters");
  const b = bedtimeState(state);
  const reason = input.reason.trim();
  let entry = b.requests.find(r => r.id === input.id);
  const duplicate = !!entry;
  if (entry && entry.reason !== reason) return fail(409, "id already used with a different reason");
  if (!entry) {
    entry = { id: input.id, reason, by, at: new Date(now).toISOString(), status: "pending" };
    b.requests.push(entry);
  }
  const status = entry.status === "pending" && Date.parse(entry.at) + BEDTIME_MS <= now ? "expired" : entry.status;
  return { ok: true, id: entry.id, status, duplicate, message: status === "pending" ? "Request sent to Bubble. Waiting for permission." : `Request ${status}.` };
}

export function bypassBedtime(state: GateState, phrase: unknown, now: number, words: () => string): BedtimeResult {
  if (typeof phrase !== "string" || !phrase.trim() || phrase.length > 200) return fail(400, "phrase must be 1-200 characters");
  const active = bedtimeUnlockUntil(state, now);
  if (active) return { ok: true, granted: true, message: `Bedtime unlocked until ${active}.` };
  const b = bedtimeState(state);
  // The phone owns the schedule. A new UTC day also retires an unused challenge.
  const challenge = ensurePhrase(b, [`bedtime/${new Date(now).toISOString().slice(0, 10)}`], now, words);
  if (!matchesPhrase(phrase, challenge.words))
    return { ok: true, granted: false, message: `Type BYPASS ${challenge.words} to unlock bedtime for 15 minutes. This counts as a bypass.` };
  chargeBedtime(state, now, now + BEDTIME_MS, now);
  return { ok: true, granted: true, message: `Bedtime unlocked until ${b.unlockUntil}.` };
}

export function decideBedtime(state: GateState, input: { id?: unknown; reason?: unknown; by?: unknown }, approve: boolean, now: number): BedtimeResult {
  if (input?.by !== `chat:${BEDTIME_OWNER}`) return fail(403, "only Bubble may decide a bedtime request");
  if (typeof input.id !== "string" || !ID.test(input.id) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 1000)
    return fail(400, "id and a reason (1-1000 characters) are required");
  const entry = state.bedtime?.requests.find(r => r.id === input.id);
  if (!entry) return fail(404, "bedtime request not found");
  const decision = approve ? "approved" : "denied";
  if (entry.status !== "pending") {
    if (entry.status !== decision) return fail(409, `request already ${entry.status}`);
    return { ok: true, id: entry.id, status: entry.status, duplicate: true, message: `Request ${entry.status}.` };
  }
  if (Date.parse(entry.at) + BEDTIME_MS <= now) return fail(409, "bedtime request expired; send a new request");
  entry.status = decision;
  entry.decidedAt = new Date(now).toISOString();
  entry.decidedBy = input.by;
  entry.decisionReason = input.reason.trim();
  if (approve) {
    entry.debtId = chargeBedtime(state, now, now + BEDTIME_MS, now);
    entry.unlockUntil = state.bedtime!.unlockUntil;
  }
  return { ok: true, id: entry.id, status: decision, duplicate: false, message: approve ? `Bedtime unlocked until ${entry.unlockUntil}.` : "Bedtime request denied." };
}

/** Travel never renews a receipt for the same date, or one within today's local interval. */
export function bedtimeFreeStatus(state: GateState, now: number) {
  const zone = zoneAt(now);
  const day = dayKey(now, zone);
  const used = state.bedtime?.freeUnlocks?.find(r => r.day === day || dayKey(Date.parse(r.at), zone) === day || dayKey(now, r.zone) === r.day);
  return { available: !used, day, zone, ...(used ? { used_at: used.at } : {}) };
}

/**
 * `gateArmed`: the hygiene gate shields the phone for owed checks. A free unlock lifts only the
 * bedtime lock, so it would open nothing then; it is refused without being spent.
 */
export function freeBedtime(state: GateState, input: { id?: unknown }, by: string, now: number, gateArmed = false): BedtimeResult {
  if (typeof input?.id !== "string" || !ID.test(input.id)) return fail(400, "id must be 1-80 letters, digits, . _ : -");
  const b = bedtimeState(state);
  const old = b.freeUnlocks?.find(r => r.id === input.id && r.by === by);
  if (old) return { ok: true, id: old.id, duplicate: true, granted: Date.parse(old.until) > now, message: "Free unlock already recorded." };
  if (gateArmed) return fail(409, "The hygiene gate is locked, so a free unlock would open nothing. Send the photo first; your free unlock is still available.");
  const today = bedtimeFreeStatus(state, now);
  if (!today.available) return fail(409, "Today's free unlock is used.");
  if (bedtimeUnlockUntil(state, now)) return fail(409, "Bedtime is already unlocked. Your free unlock is still available.");
  const at = new Date(now).toISOString();
  const until = new Date(now + BEDTIME_MS).toISOString();
  (b.freeUnlocks ??= []).push({ id: input.id, by, at, until, zone: today.zone, day: today.day });
  b.unlockUntil = until;
  retire(b);
  return { ok: true, id: input.id, granted: true, duplicate: false, message: "Bedtime unlocked for 15 minutes." };
}
