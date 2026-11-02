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
  /** Saves under the gate's lock and releases held chats when the gate opens. */
  apply: (edit: (gym: GymState, now: number) => boolean) => Promise<void>;
};

let fetcher: FeedFetcher = httpFetcher;
let lastAttempt = 0;
let inflight: Promise<void> | null = null;

/** For tests. */
export function setGymFetcher(next: FeedFetcher = httpFetcher): void {
  fetcher = next;
  lastAttempt = 0;
  inflight = null;
}

/**
 * One read of Uplifting. `syncedAt` is when the read started, so it vouches
 * only for what Uplifting had by then. Failures are recorded, never thrown.
 */
export function syncGym(host: GymSyncHost, timeoutMs = 15_000): Promise<void> {
  if (inflight) return inflight;
  const started = host.now();
  lastAttempt = started;
  inflight = (async () => {
    let feed: UpliftingFeed | null = null;
    let error: string | null = null;
    try {
      feed = await fetcher(new Date(started - LOOKBACK_MS).toISOString(), AbortSignal.timeout(timeoutMs));
    } catch (e) {
      error = (e as Error).name === "TimeoutError" ? "Uplifting timed out" : (e as Error).message.slice(0, 200);
    }
    await host.apply((gym, now) => {
      if (!feed) {
        const changed = gym.syncError !== error;
        gym.syncError = error!;
        return changed;
      }
      mergeFeed(gym, feed, now);
      gym.syncedAt = new Date(started).toISOString();
      delete gym.syncError;
      return true;
    });
    if (error) console.error("gym-sync:", error);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Read now if a plan's deadline has passed and the last read is older than
 * `maxAgeMs`, so a turn is never locked on a stale copy. Bounded by `timeoutMs`.
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
  await syncGym(host, timeoutMs);
}

/** Polls while there are plans. Returns a stop function. */
export function startGymSync(host: GymSyncHost, intervalMs = 2 * 60_000): () => Promise<void> {
  const tick = () => {
    if (host.hasGym()) void syncGym(host);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inflight;
  };
}
