/** Adult filtering has its own phrase and grant. There is deliberately no agent approval path. */
import { recordBypass, type GateState } from "./hygiene";
import { ensurePhrase, matchesPhrase, retire } from "./bypass-phrase";

export function adultFilterUnlockUntil(state: GateState, now: number): string | undefined {
  const until = state.adultFilter?.unlockUntil;
  return until && Date.parse(until) > now ? until : undefined;
}

export function bypassAdultFilter(state: GateState, phrase: unknown, now: number, words: () => string) {
  if (typeof phrase !== "string" || !phrase.trim() || phrase.length > 200)
    return { ok: false as const, statusCode: 400, error: "phrase must be 1-200 characters" };
  const active = adultFilterUnlockUntil(state, now);
  if (active) return { ok: true as const, granted: true, message: `Adult filter unlocked until ${active}.` };
  const filter = state.adultFilter ??= {};
  const challenge = ensurePhrase(filter, [`adult-filter/${new Date(now).toISOString().slice(0, 10)}`], now, words);
  if (!matchesPhrase(phrase, challenge.words))
    return { ok: true as const, granted: false, message: `Type BYPASS ${challenge.words} to unlock the adult filter for 15 minutes. This counts as a bypass.` };
  const at = new Date(now).toISOString();
  recordBypass(state, at, "adult-filter");
  state.debts.push({ id: `phone-bypass-${now}-${state.bypass.count}`, at, kind: "adult-filter", skipped: ["adult-filter"], items: [], status: "open" });
  filter.unlockUntil = new Date(now + 15 * 60_000).toISOString();
  retire(filter);
  return { ok: true as const, granted: true, message: `Adult filter unlocked until ${filter.unlockUntil}.` };
}
