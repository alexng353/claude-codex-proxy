/**
 * Wakes Cairn on Alex's iPhone when the gate's shield state changes, so the
 * Screen Time shield goes up on a lock and comes down on a clear without him
 * opening the app (gym gate design, D5-D7).
 *
 * The push carries nothing: the relay (Cairn's POST /v1/gate/wake) sends a
 * silent APNs push and the phone reads /hygiene/api/v1/status itself. So this
 * module only decides *when* to ask, and asks again until the relay has
 * accepted the newest state:
 *
 * - A poller compares the gate's shield signature (armed/clear/bypassed/
 *   disabled, plus a bypass's end) with the last one the relay accepted.
 *   Polling, not hooks, because many changes are time-driven (a gym deadline
 *   passing, a bypass ending) and no code path "transitions" at that moment.
 * - The accepted signature lives in a file beside the gate state, under a lock,
 *   so the two copies that run during a handoff agree and don't both send.
 * - 2xx: accepted. 429: the relay's 60 s cooldown; wait Retry-After. Anything
 *   else, or no answer: back off 30 s doubling to 10 min, and keep trying.
 * - No token file: wake is off (the relay isn't deployed yet). Logged once.
 *
 * Failing to wake never touches the gate itself: the phone also refreshes on
 * open and on its own DeviceActivity schedule.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withLock } from "./filelock";

export const DEFAULT_WAKE_URL = "https://truenas-scale.taildf19.ts.net:8787/v1/gate/wake";
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** A Retry-After outside 1 s..10 min is not trusted. */
const RETRY_AFTER_MAX_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A copy that claimed a send and then died frees the claim after this long. */
const CLAIM_MS = REQUEST_TIMEOUT_MS + 5_000;

export type WakeAnswer =
  | { kind: "accepted" }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "failed"; detail: string }
  | { kind: "off" };

export type PhoneWakeSender = () => Promise<WakeAnswer>;

type WakeFile = {
  /** The signature the relay last accepted. */
  sent?: string;
  sentAt?: string;
  /** No attempt before this (ms since epoch). */
  nextAttemptAt?: number;
  failures?: number;
  /** A copy is sending until this time (ms since epoch). */
  claimUntil?: number;
  lastError?: string;
};

export const wakeFilePath = (statePath: string) => join(dirname(statePath), "phone-wake.json");

function readWake(path: string): WakeFile {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as WakeFile) : {};
  } catch {
    // A corrupt file only costs one extra wake.
    return {};
  }
}

function updateWake<T>(path: string, edit: (file: WakeFile) => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(`${path}.lock`, () => {
    const file = readWake(path);
    const result = edit(file);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  });
}

export type StepResult = "unchanged" | "waiting" | "busy" | "accepted" | "cooldown" | "failed" | "off";

/**
 * One poll: sends a wake when `signature` differs from the accepted one and
 * no backoff or other copy's send is in the way. Never throws.
 */
export async function phoneWakeStep(
  path: string,
  signature: string,
  now: () => number,
  send: PhoneWakeSender,
): Promise<StepResult> {
  let claimed: StepResult | null;
  try {
    claimed = updateWake(path, (file) => {
      const t = now();
      if (file.sent === signature) return "unchanged";
      if ((file.claimUntil ?? 0) > t) return "busy";
      if ((file.nextAttemptAt ?? 0) > t) return "waiting";
      file.claimUntil = t + CLAIM_MS;
      return null;
    });
  } catch (error) {
    console.error("phone-wake: could not read the wake file:", (error as Error).message);
    return "busy";
  }
  if (claimed) return claimed;

  let answer: WakeAnswer;
  try {
    answer = await send();
  } catch (error) {
    answer = { kind: "failed", detail: (error as Error).message };
  }

  try {
    updateWake(path, (file) => {
      const t = now();
      delete file.claimUntil;
      if (answer.kind === "accepted") {
        file.sent = signature;
        file.sentAt = new Date(t).toISOString();
        delete file.nextAttemptAt;
        delete file.failures;
        delete file.lastError;
      } else if (answer.kind === "cooldown") {
        file.nextAttemptAt = t + answer.retryAfterMs;
      } else if (answer.kind === "failed") {
        file.failures = Math.min((file.failures ?? 0) + 1, 10);
        file.nextAttemptAt = t + Math.min(BACKOFF_FIRST_MS * 2 ** (file.failures - 1), BACKOFF_MAX_MS);
        file.lastError = answer.detail.slice(0, 200);
      } else {
        // Off: look again later without counting a failure.
        file.nextAttemptAt = t + BACKOFF_MAX_MS;
      }
    });
  } catch (error) {
    // The claim expires on its own; the next poll after it resends, which the phone tolerates.
    console.error("phone-wake: could not record a wake result:", (error as Error).message);
  }
  if (answer.kind === "failed") console.error(`phone-wake: wake failed: ${answer.detail.slice(0, 200)}`);
  return answer.kind;
}

/** Retry-After in whole seconds (what the relay sends); null when absent or out of range. */
export function retryAfterMs(header: string | null): number | null {
  if (!header || !/^\d+$/.test(header.trim())) return null;
  const ms = Number(header.trim()) * 1000;
  return ms >= 1000 && ms <= RETRY_AFTER_MAX_MS ? ms : null;
}

export const wakeTokenPath = () =>
  process.env.CAIRN_GATE_WAKE_TOKEN_FILE ?? join(homedir(), ".config", "cairn", "gate-wake.token");

let offLogged = false;

/**
 * POST {} to the relay with the gate bearer. The token is read at call time,
 * so deploying the relay needs no proxy restart.
 */
export function relaySender(
  url = process.env.CAIRN_GATE_WAKE_URL ?? DEFAULT_WAKE_URL,
  tokenPath = wakeTokenPath(),
  fetcher: typeof fetch = fetch,
): PhoneWakeSender {
  return async () => {
    if (process.env.HYGIENE_PHONE_WAKE === "off") return { kind: "off" };
    let token = "";
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {}
    if (!token) {
      if (!offLogged) console.error(`phone-wake: no token at ${tokenPath}; Cairn phone wakes are off`);
      offLogged = true;
      return { kind: "off" };
    }
    offLogged = false;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: "failed", detail: (error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message };
    }
    // The body is never needed; drain it so the connection can be reused.
    await response.arrayBuffer().catch(() => {});
    if (response.ok) return { kind: "accepted" };
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      return wait === null ? { kind: "failed", detail: "429 without a usable Retry-After" } : { kind: "cooldown", retryAfterMs: wait };
    }
    return { kind: "failed", detail: `HTTP ${response.status}` };
  };
}

/**
 * Polls every `intervalMs`. `signature` returns null when this copy must not
 * wake (a follower). Steps never overlap within a copy.
 */
export function startPhoneWake(
  path: () => string,
  signature: () => string | null,
  now: () => number,
  send: PhoneWakeSender,
  intervalMs = 15_000,
): () => Promise<void> {
  let running: Promise<unknown> = Promise.resolve();
  let busy = false;
  let stopped = false;
  const tick = () => {
    if (busy || stopped) return;
    let current: string | null;
    try {
      current = signature();
    } catch (error) {
      console.error("phone-wake: could not read the gate:", (error as Error).message);
      return;
    }
    if (current === null) return;
    busy = true;
    running = phoneWakeStep(path(), current, now, send).finally(() => {
      busy = false;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running.catch(() => {});
  };
}
