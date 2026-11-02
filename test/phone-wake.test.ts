import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zonedTime } from "../src/hygiene";
import { resetGateCache, setGateDeps, shieldSignature } from "../src/hygiene-gate";
import { phoneWakeStep, relaySender, retryAfterMs, startPhoneWake, type WakeAnswer } from "../src/phone-wake";

let directory = "";
let run = 0;
let path = "";
let clock = 1_000_000;
const now = () => clock;

/** A sender that answers from a script and counts calls. */
function scripted(...answers: WakeAnswer[]) {
  const sender = async () => {
    sender.calls++;
    return answers.shift() ?? { kind: "accepted" as const };
  };
  sender.calls = 0;
  return sender;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "phone-wake-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  run++;
  await mkdir(join(directory, `s-${run}`), { recursive: true });
  path = join(directory, `s-${run}`, "phone-wake.json");
  clock = 1_000_000;
});

describe("phoneWakeStep", () => {
  test("sends once per new signature", async () => {
    const send = scripted();
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("accepted");
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("unchanged");
    expect(send.calls).toBe(1);
    expect(await phoneWakeStep(path, "clear|", now, send)).toBe("accepted");
    expect(send.calls).toBe(2);
    expect(JSON.parse(await readFile(path, "utf8")).sent).toBe("clear|");
  });

  test("a 429 waits exactly Retry-After, then sends the newest state", async () => {
    const send = scripted({ kind: "accepted" }, { kind: "cooldown", retryAfterMs: 42_000 });
    await phoneWakeStep(path, "armed|", now, send);
    expect(await phoneWakeStep(path, "clear|", now, send)).toBe("cooldown");
    clock += 41_999;
    expect(await phoneWakeStep(path, "clear|", now, send)).toBe("waiting");
    expect(send.calls).toBe(2);
    clock += 1;
    // The state moved again meanwhile: the retry carries the newest one.
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("unchanged");
    expect(await phoneWakeStep(path, "bypassed|2026-11-05T14:00:00.000Z", now, send)).toBe("accepted");
    expect(send.calls).toBe(3);
  });

  test("failures back off 30 s, then 60 s; a success clears the backoff", async () => {
    const send = scripted({ kind: "failed", detail: "HTTP 502" }, { kind: "failed", detail: "timed out" });
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("failed");
    clock += 29_999;
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("waiting");
    clock += 1;
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("failed");
    clock += 59_999;
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("waiting");
    clock += 1;
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("accepted");
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file.failures).toBeUndefined();
    expect(file.nextAttemptAt).toBeUndefined();
  });

  test("a thrown sender counts as a failure, not a crash", async () => {
    const send = async (): Promise<WakeAnswer> => {
      throw new Error("boom");
    };
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("failed");
    expect(JSON.parse(await readFile(path, "utf8")).claimUntil).toBeUndefined();
  });

  test("a second copy does not send while the first is sending", async () => {
    let finish: (a: WakeAnswer) => void = () => {};
    let calls = 0;
    const slow = () => {
      calls++;
      return new Promise<WakeAnswer>((resolve) => {
        finish = resolve;
      });
    };
    const first = phoneWakeStep(path, "armed|", now, slow);
    await Bun.sleep(5);
    expect(await phoneWakeStep(path, "armed|", now, slow)).toBe("busy");
    finish({ kind: "accepted" });
    expect(await first).toBe("accepted");
    expect(calls).toBe(1);
  });

  test("a claim left by a copy that died expires", async () => {
    await writeFile(path, JSON.stringify({ claimUntil: clock + 15_000 }));
    const send = scripted();
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("busy");
    clock += 15_000;
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("accepted");
  });

  test("off (no token yet) retries later without counting failures", async () => {
    const send = scripted({ kind: "off" });
    expect(await phoneWakeStep(path, "armed|", now, send)).toBe("off");
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file.failures).toBeUndefined();
    expect(file.sent).toBeUndefined();
    expect(file.nextAttemptAt).toBe(clock + 10 * 60_000);
  });

  test("an unchanged or waiting poll leaves the file untouched", async () => {
    const compact = JSON.stringify({ sent: "armed|" });
    await writeFile(path, compact);
    expect(await phoneWakeStep(path, "armed|", now, scripted())).toBe("unchanged");
    expect(await readFile(path, "utf8")).toBe(compact);
    const waiting = JSON.stringify({ sent: "armed|", nextAttemptAt: clock + 1000 });
    await writeFile(path, waiting);
    expect(await phoneWakeStep(path, "clear|", now, scripted())).toBe("waiting");
    expect(await readFile(path, "utf8")).toBe(waiting);
  });

  test("a corrupt wake file costs one extra wake, nothing more", async () => {
    await writeFile(path, "{not json");
    expect(await phoneWakeStep(path, "armed|", now, scripted())).toBe("accepted");
  });
});

describe("relaySender", () => {
  const tokenFile = () => join(directory, `s-${run}`, "gate-wake.token");
  const reply = (status: number, headers: Record<string, string> = {}) => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response("{}", { status, headers });
    }) as unknown as typeof fetch;
    return { seen, fetcher };
  };

  test("no token file means off, and nothing is fetched", async () => {
    const { seen, fetcher } = reply(200);
    expect(await relaySender("https://relay/v1/gate/wake", tokenFile(), fetcher)()).toEqual({ kind: "off" });
    expect(seen.url).toBeUndefined();
  });

  test("HYGIENE_PHONE_WAKE=off sends nothing even with a token", async () => {
    await writeFile(tokenFile(), "t");
    const { seen, fetcher } = reply(200);
    const saved = process.env.HYGIENE_PHONE_WAKE;
    process.env.HYGIENE_PHONE_WAKE = "off";
    try {
      expect(await relaySender("u", tokenFile(), fetcher)()).toEqual({ kind: "off" });
      expect(seen.url).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.HYGIENE_PHONE_WAKE;
      else process.env.HYGIENE_PHONE_WAKE = saved;
    }
  });

  test("posts {} with the bearer from the file", async () => {
    await writeFile(tokenFile(), "gate-secret\n");
    const { seen, fetcher } = reply(200);
    expect(await relaySender("https://relay/v1/gate/wake", tokenFile(), fetcher)()).toEqual({ kind: "accepted" });
    expect(seen.url).toBe("https://relay/v1/gate/wake");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe("{}");
    expect((seen.init?.headers as Record<string, string>).authorization).toBe("Bearer gate-secret");
  });

  test("429 with Retry-After is a cooldown; without one it is a failure", async () => {
    await writeFile(tokenFile(), "t");
    expect(await relaySender("u", tokenFile(), reply(429, { "retry-after": "37" }).fetcher)()).toEqual({
      kind: "cooldown",
      retryAfterMs: 37_000,
    });
    expect((await relaySender("u", tokenFile(), reply(429).fetcher)()).kind).toBe("failed");
  });

  test("401, 5xx and network errors are failures", async () => {
    await writeFile(tokenFile(), "t");
    expect(await relaySender("u", tokenFile(), reply(401).fetcher)()).toEqual({ kind: "failed", detail: "HTTP 401" });
    expect(await relaySender("u", tokenFile(), reply(503).fetcher)()).toEqual({ kind: "failed", detail: "HTTP 503" });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await relaySender("u", tokenFile(), down)()).toEqual({ kind: "failed", detail: "ECONNREFUSED" });
  });

  test("retryAfterMs accepts whole seconds from 1 to 600 only", () => {
    expect(retryAfterMs("60")).toBe(60_000);
    expect(retryAfterMs(" 1 ")).toBe(1_000);
    expect(retryAfterMs("0")).toBeNull();
    expect(retryAfterMs("601")).toBeNull();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("startPhoneWake", () => {
  test("a follower (null signature) never sends", async () => {
    const send = scripted();
    const stop = startPhoneWake(() => path, () => null, now, send, 5);
    await Bun.sleep(40);
    await stop();
    expect(send.calls).toBe(0);
  });

  test("ticks never overlap, and nothing runs after stop", async () => {
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    let signature = 0;
    const slow = async (): Promise<WakeAnswer> => {
      calls++;
      inFlight++;
      most = Math.max(most, inFlight);
      // Past the cross-copy claim: only the in-process guard can stop a second send.
      clock += 20_000;
      await Bun.sleep(25);
      inFlight--;
      return { kind: "accepted" };
    };
    // A new signature every tick, so every tick wants to send.
    const stop = startPhoneWake(() => path, () => `s${signature++}`, now, slow, 5);
    await Bun.sleep(80);
    await stop();
    expect(most).toBe(1);
    expect(calls).toBeGreaterThan(0);
    const after = calls;
    await Bun.sleep(30);
    expect(calls).toBe(after);
  });
});

describe("shieldSignature", () => {
  const saved: Record<string, string | undefined> = {};
  const DAY = "2026-11-05";
  const at = (minutes: number) => zonedTime(DAY, minutes);
  beforeAll(() => {
    for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE"]) saved[key] = process.env[key];
    delete process.env.HYGIENE_GATE_REMOTE;
  });
  afterAll(() => {
    setGateDeps({});
    resetGateCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("follows the lock, a bypass's end and the kill switch", async () => {
    const dir = join(directory, `s-${run}`);
    process.env.PROXY_STATE_DIR = dir;
    process.env.HYGIENE_GATE_STATE = join(dir, "hygiene-gate.json");
    process.env.HYGIENE_GATE_DISABLED_FILE = join(dir, "disabled");
    const state = (bypassUntil: string | null) =>
      writeFile(
        process.env.HYGIENE_GATE_STATE!,
        JSON.stringify({
          version: 1,
          startsAt: new Date(at(5 * 60)).toISOString(),
          images: [],
          filled: {},
          bypass: { count: bypassUntil ? 1 : 0, until: bypassUntil, history: [] },
          debts: [],
          notes: [],
          extraGatedTriggers: [],
        }),
      );
    let t = at(4 * 60);
    setGateDeps({ now: () => t, wake: async () => "sent" });
    await state(null);
    resetGateCache();
    expect(shieldSignature()).toBe("clear|");
    t = at(7 * 60);
    expect(shieldSignature()).toBe("armed|");
    const until = new Date(at(8 * 60)).toISOString();
    await state(until);
    resetGateCache();
    expect(shieldSignature()).toBe(`bypassed|${until}`);
    t = at(8 * 60);
    expect(shieldSignature()).toBe("armed|");
    await writeFile(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    expect(shieldSignature()).toBe("disabled|");
  });
});
