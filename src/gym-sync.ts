/**
 * Reads Alex's sessions and Start/Finish locations from Uplifting into the
 * gate (gym.ts). Runs only on the gate's authority. The token is Uplifting's
 * read-only gate token: env UPLIFTING_GATE_TOKEN, else the file
 * $PROXY_STATE_DIR/uplifting-gate.token (mode 600). It is never logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGym, mergeFeed, type GymState, type UpliftingFeed } from "./gym";
import { stateDir } from "./sessions";

export const DEFAULT_UPLIFTING_URL = "https://uplifting-api-mobile-production.up.railway.app";
const LOOKBACK_MS = 14 * 86_400_000;
/** Uplifting's feed answers at most this far back (uplifting apps/api/src/routes/gate.ts). */
const MAX_LOOKBACK_MS = 60 * 86_400_000;

export type FeedFetcher = (fromIso: string, signal: AbortSignal) => Promise<UpliftingFeed>;

export function upliftingToken(): string | null {
  const fromEnv = process.env.UPLIFTING_GATE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.UPLIFTING_GATE_TOKEN_FILE ?? join(stateDir(), "uplifting-gate.token");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").trim() || null;
}

export const httpFetcher: FeedFetcher = async (fromIso, signal) => {
  const token = upliftingToken();
  if (!token) throw new Error("no Uplifting gate token configured");
  const base = (process.env.UPLIFTING_GATE_URL ?? DEFAULT_UPLIFTING_URL).replace(/\/+$/, "");
  const reply = await fetch(`${base}/api/v1/gate/feed?from=${encodeURIComponent(fromIso)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!reply.ok) throw new Error(`Uplifting answered ${reply.status}`);
  const body = (await reply.json()) as UpliftingFeed;
  if (!body || !Array.isArray(body.checkins) || !Array.isArray(body.workouts)) throw new Error("Uplifting feed has the wrong shape");
  return body;
};

/** The gate-side hooks, injected so this file doesn't import hygiene-gate (which imports it). */
export type GymSyncHost = {
  now: () => number;
  hasGym: () => boolean;
  /** Start of the oldest window a still-unresolved plan needs, or null. */
  neededSince: () => number | null;
  /** Saves under the gate's lock and releases held chats when the gate opens. */
  apply: (edit: (gym: GymState, now: number) => boolean) => Promise<void>;
};

let fetcher: FeedFetcher = httpFetcher;
let lastAttempt = 0;
let inflight: Promise<void> | null = null;
let inflightSince = 0;
/** Every read still running, abandoned ones included, so a drain can wait for them. */
const running = new Set<Promise<void>>();
/** A read still pending after this long (a fetcher that ignored its abort, a stuck lock) is abandoned. */
const INFLIGHT_MAX_MS = 30_000;

/** For tests. */
export function setGymFetcher(next: FeedFetcher = httpFetcher): void {
  fetcher = next;
  lastAttempt = 0;
  inflight = null;
  inflightSince = 0;
}

/**
 * One read of Uplifting. `syncedAt` is when the read started, so it vouches
 * only for what Uplifting had by then. Failures are recorded, never thrown.
 */
export function syncGym(host: GymSyncHost, timeoutMs = 15_000): Promise<void> {
  const started = host.now();
  if (inflight && started - inflightSince < INFLIGHT_MAX_MS) return inflight;
  lastAttempt = started;
  inflightSince = started;
  // Reach back to the oldest unresolved plan, so a long outage can't turn a
  // session outside the default window into a miss.
  const needed = host.neededSince();
  const from = Math.max(started - MAX_LOOKBACK_MS, Math.min(started - LOOKBACK_MS, needed ?? Infinity));
  const run: Promise<void> = (async () => {
    let feed: UpliftingFeed | null = null;
    let error: string | null = null;
    try {
      feed = await fetcher(new Date(from).toISOString(), AbortSignal.timeout(timeoutMs));
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? "Uplifting timed out" : (e as Error).message.slice(0, 200);
    }
    await host.apply((gym, now) => {
      // A read that finishes after a newer one was applied (success or failure)
      // only adds what it saw; it never clears a newer error or moves times back.
      if (gym.readAt && Date.parse(gym.readAt) > started) return feed ? mergeFeed(gym, feed, now) : false;
      gym.readAt = new Date(started).toISOString();
      if (!feed) {
        gym.syncError = error!;
        return true;
      }
      mergeFeed(gym, feed, now);
      gym.syncedAt = new Date(started).toISOString();
      delete gym.syncError;
      return true;
    });
    if (error) console.error("gym-sync:", error);
  })().finally(() => {
    running.delete(run);
    if (inflight === run) inflight = null;
  });
  running.add(run);
  inflight = run;
  return run;
}

/**
 * Read now if a plan's deadline has passed and the last read is older than
 * `maxAgeMs`. The whole wait, including the gate's lock, is bounded by
 * `timeoutMs`; after that the turn is decided on what the gate has, and a
 * stale copy can't lock (gym.ts FRESH_READ_MS). Never throws.
 */
export async function refreshIfDeciding(
  host: GymSyncHost,
  gym: GymState | undefined,
  maxAgeMs = 60_000,
  timeoutMs = 5_000,
): Promise<void> {
  const now = host.now();
  if (!gym) return;
  const pending = evaluateGym(gym, now).some(
    (r) => (r.status === "missed" || r.status === "upcoming" || r.status === "in-progress") && r.deadline <= now,
  );
  const fresh = gym.syncedAt && now - Date.parse(gym.syncedAt) < maxAgeMs;
  if (!pending || fresh || now - lastAttempt < maxAgeMs / 4) return;
  lastAttempt = now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    // The read keeps its own 15 s limit and finishes in the background; only the wait is capped.
    syncGym(host).catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/** Polls while there are plans. Never throws: the gate fails open. Returns a stop function. */
export function startGymSync(host: GymSyncHost, intervalMs = 2 * 60_000): () => Promise<void> {
  const tick = () => {
    try {
      if (host.hasGym()) syncGym(host).catch((e) => console.error("gym-sync: poll failed:", (e as Error).message));
    } catch (e) {
      console.error("gym-sync: poll failed:", (e as Error).message);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    // Wait for every read, abandoned ones too, but never hold a drain for long.
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, 20_000);
      }),
    ]);
    clearTimeout(wait);
  };
}
