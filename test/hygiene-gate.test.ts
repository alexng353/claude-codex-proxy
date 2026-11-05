import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { isWithheld, zonedTime } from "../src/hygiene";
import { setAuthenticator } from "../src/hygiene-api";
import { wakeCommand } from "../src/hygiene-wake";
import { flushWakes, gateRequest, gateStatus, resetGateCache, setGateDeps, submitProof } from "../src/hygiene-gate";
import { retryUnchecked } from "../src/hygiene-remote";
import type { Verdict } from "../src/hygiene-proof";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const DAY = "2026-10-08";
const THREAD = "01a10494-b499-7af3-986b-3c30d8c94b91";

let directory = "";
let run = 0;
let clock = at(DAY, "06:00");
let verdicts: Verdict[] = [];
let classified = 0;
let classifierDown = false;
let classifyBlock: Promise<void> | null = null;
let wakes: Array<{ id: string; thread: string; machine?: string; text: string }> = [];
let wakeResults: Array<"sent" | "retry" | "failed"> = [];
let exif: Record<string, number | null> = {};
let hashes: Record<string, string> = {};
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hygiene-gate-test-"));
  const mock = join(directory, "claude");
  // Forwarded turns reach this fake Claude; it records what it was sent.
  await writeFile(
    mock,
    `#!/bin/sh
while IFS= read -r input; do
  printf '%s\\n' "$input" >> '${directory}/inputs'
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"model-ran","tool_calls":[]}}'
done
`,
  );
  await chmod(mock, 0o755);
  for (const key of ["CLAUDE_BIN", "PROXY_STATE_DIR", "CLAUDE_CONFIG_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "PLATE_ACTIVITY_CONFIG", "HYGIENE_PHOTO_DIR"])
    saved[key] = process.env[key];
  process.env.CLAUDE_BIN = mock;
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude-config");
  process.env.PLATE_ACTIVITY_CONFIG = join(directory, "no-plate.json");
});

afterAll(async () => {
  closeIdleWorkers();
  setGateDeps({});
  resetGateCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  run++;
  process.env.PROXY_STATE_DIR = join(directory, `state-${run}`);
  process.env.HYGIENE_GATE_STATE = join(directory, `state-${run}`, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, `disabled-${run}`);
  process.env.HYGIENE_PHOTO_DIR = join(directory, `photos-${run}`);
  resetGateCache();
  clock = at(DAY, "06:00");
  verdicts = [];
  classified = 0;
  classifierDown = false;
  classifyBlock = null;
  issued = 0;
  wakes = [];
  wakeResults = [];
  exif = {};
  hashes = {};
  setGateDeps({
    now: () => clock,
    bypassWords,
    baseUrl: "http://127.0.0.1:3456",
    wake: async (wake) => {
      wakes.push(wake);
      return wakeResults.shift() ?? "sent";
    },
    classify: async () => {
      classified++;
      if (classifyBlock) await classifyBlock;
      if (classifierDown) throw new Error("down");
      return verdicts.shift() ?? { kind: "none", confidence: 0.9, reason: "no person" };
    },
    dhash: async (bytes) => hashes[bytes.toString("utf8")] ?? null,
    captureTime: async (bytes) => exif[bytes.toString("utf8")] ?? null,
    // Test photos are not real images; location stripping has its own tests.
    stripGps: async (image) => image,
  });
  // Shipped state: first arm Oct 8 05:00, Oct 7's night already proven.
  await mkdir(join(directory, `state-${run}`), { recursive: true });
  await writeFile(
    process.env.HYGIENE_GATE_STATE!,
    JSON.stringify({
      version: 1,
      startsAt: new Date(at(DAY, "05:00")).toISOString(),
      images: [],
      filled: {},
      bypass: { count: 0, until: null, history: [] },
      debts: [],
      notes: [],
      extraGatedTriggers: [],
    }),
  );
});

const photo = (name: string) => `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`;
const meta = (trigger: string) => ({
  "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", turn_trigger: trigger }),
});
const user = (...content: Array<string | { photo: string }>): ResponseInputItem =>
  ({
    type: "message",
    role: "user",
    content: content.map((c) =>
      typeof c === "string" ? { type: "input_text", text: c } : { type: "input_image", image_url: photo(c.photo), detail: "auto" },
    ),
  }) as ResponseInputItem;
const assistant = (text: string): ResponseInputItem =>
  ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }) as ResponseInputItem;
const developer = (text: string): ResponseInputItem =>
  ({ type: "message", role: "developer", content: [{ type: "input_text", text }] }) as ResponseInputItem;
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const request = (input: ResponseInputItem[], trigger = "composer", extra: Partial<ResponsesRequest> = {}): ResponsesRequest =>
  ({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta(trigger), input, ...extra }) as ResponsesRequest;

async function decide(req: ResponsesRequest) {
  return gateRequest(req);
}
const text = (d: Awaited<ReturnType<typeof gateRequest>>) => (d.action === "respond" ? d.text : null);

/** The tests' BYPASS words, in issue order: a test's first lock gets the first phrase. */
const PHRASES = ["maple river otter", "cedar comet tulip", "lemon kite swan"];
let issued = 0;
const bypassWords = () => PHRASES[issued++ % PHRASES.length];
const BYPASS = `BYPASS ${PHRASES[0]}`;

describe("gate decisions", () => {
  test("before 05:00 nothing is locked; at 05:00 the first human turn is", async () => {
    clock = at(DAY, "04:59");
    expect((await decide(request([env, user("hi")]))).action).toBe("forward");
    clock = at(DAY, "05:00");
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
  });

  test("exempt turns and continuations pass a locked gate", async () => {
    expect((await decide(request([env, user("<heartbeat>\n<automation_id>x</automation_id>")], "automation_heartbeat_scheduled"))).action).toBe("forward");
    const fromChat = user("<codex_delegation>\n<source_thread_id>01a1370e</source_thread_id>\n<input>prompt from another chat</input>\n</codex_delegation>");
    expect((await decide(request([env, fromChat], "app_tool_send_message"))).action).toBe("forward");
    // Alex steering into that turn is still Alex.
    expect((await decide(request([env, fromChat, user("fix the bug")], "app_tool_send_message"))).action).toBe("respond");
    expect((await decide(request([env, user("weekly report")], "automation_cron_scheduled"))).action).toBe("forward");
    const continuation = request([
      env,
      user("started at 04:50"),
      { type: "function_call", call_id: "c", name: "exec", arguments: "{}" } as ResponseInputItem,
      { type: "function_call_output", call_id: "c", output: "ok" } as ResponseInputItem,
    ]);
    expect((await decide(continuation)).action).toBe("forward");
    expect((await decide(request([env, user("x"), { type: "compaction_trigger" } as ResponseInputItem]))).action).toBe("forward");
  });

  // 2026-11-01 06:02 MST: a worker's delegation with 5 QA screenshots was
  // steered into the build chat's goal turn. The image parts made the envelope
  // read as Alex, so the gate classified all 5 and answered for the agent.
  test("envelopes carrying images are never classified, held or answered", async () => {
    const shot = (n: number) => [`<image name=[Image #${n}] path="/tmp/qa-${n}.png">`, { photo: `qa-${n}` }, "</image>"];
    const envelope = (source: string, input: string) =>
      user(
        `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <sent_at>06:02 MST Sun Nov 1</sent_at>\n  <input>${input}</input>\n</codex_delegation>`,
        ...[1, 2, 3, 4, 5].flatMap(shot),
      );
    const senders = [
      envelope("01a196af-1416-7283-a34e-e52835ae9bec", "Round-two fix receipt complete."),
      envelope("script:ship-arch", "[ship-arch.sh] installed"),
      user("[06:02 MST Sun Nov 1] " + (envelope("script:today-self-improve", "[timer daily 06:00] review").content as Array<{ text?: string }>)[0].text, ...shot(1)),
    ];
    for (const message of senders)
      for (const trigger of ["goal", "app_tool_send_message", "composer"]) {
        const turn = request([env, user("started at 04:50"), assistant("working"), message], trigger);
        const decision = await decide(turn);
        expect(decision.action).toBe("forward");
        // The screenshots reach the model untouched.
        expect(JSON.stringify(decision.action === "forward" && decision.request)).toContain(photo("qa-1"));
      }
    expect(classified).toBe(0);
    expect(JSON.parse(readFileSync(process.env.HYGIENE_GATE_STATE!, "utf8")).images).toEqual([]);
    expect(existsSync(join(dirname(process.env.HYGIENE_GATE_STATE!), "hygiene-held.json"))).toBe(false);
    expect(gateStatus()).toMatchObject({ armed: true });

    // Alex's own screenshot, alone or steered into that turn, is still his.
    expect(text(await decide(request([env, user(...shot(1))], "goal")))).toContain("gate armed");
    expect(classified).toBe(1);
    expect(text(await decide(request([env, senders[0], user("[06:03 MST Sun Nov 1] look", ...shot(6))], "goal")))).toContain(
      "gate armed",
    );
    expect(classified).toBe(2);
  });

  test("a valid photo unlocks immediately and the image never reaches the model", async () => {
    const locked = [env, user("fix the bug"), assistant("🪥 gate armed: morning teeth photo")];
    expect((await decide(request([env, user("fix the bug")]))).action).toBe("respond");
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "toothbrush in mouth" });
    const turn = request([...locked, user("# Files mentioned by the user:\n\n## Photo 1.jpg: /tmp/x.jpg", { photo: "teeth-1" })]);
    const decision = await decide(turn);
    expect(decision.action).toBe("forward");
    const forwarded = JSON.stringify(decision.action === "forward" && decision.request);
    expect(forwarded).not.toContain(photo("teeth-1"));
    expect(forwarded).toContain("[hygiene-gate: photo accepted as morning teeth (Oct 8) proof; image withheld]");
    expect(gateStatus()).toMatchObject({ state: "clear", armed: false });
    // Later turns pass and replay the marker byte-for-byte.
    const later = request([...turn.input as ResponseInputItem[], assistant("done"), user("next")]);
    const again = await decide(later);
    expect(again.action).toBe("forward");
    expect(JSON.stringify(again.action === "forward" && again.request.input.slice(0, 4))).toBe(
      JSON.stringify(decision.action === "forward" && decision.request.input),
    );
    expect(classified).toBe(1);
  });

  test("a retry of the same message reuses its verdict", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const turn = request([env, user({ photo: "teeth-1" })]);
    const first = await decide(turn);
    const retry = await decide(turn);
    expect(first.action).toBe("forward");
    expect(JSON.stringify(retry)).toBe(JSON.stringify(first));
    expect(classified).toBe(1);
  });

  test("exact and near copies of an accepted proof are rejected; a fresh photo passes", async () => {
    hashes = { a: "0".repeat(64), "a-recompressed": "0".repeat(62) + "ff", fresh: "f".repeat(64) };
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    await decide(request([env, user({ photo: "a" })]));
    clock = at(DAY, "18:00");
    const exact = await decide(request([env, user("again", { photo: "a" })]));
    expect(exact.action).toBe("forward"); // nothing locks at 18:00
    expect(gateStatus().dueToday.map((r) => r.slot)).toContain(`${DAY}/night-teeth`);
    clock = at("2026-10-09", "00:30");
    // A new message (not a replay of the 06:00 one) carrying the same photo.
    const copy = await decide(request([env, user("copy", { photo: "a" })]));
    expect(text(copy)).toStartWith("❌ photo rejected: it is a copy of an earlier proof photo.");
    const near = await decide(request([env, user("near", { photo: "a-recompressed" })]));
    expect(text(near)).toStartWith("❌ photo rejected: it is a near-copy of an earlier proof photo.");
    verdicts.push({ kind: "shower", confidence: 0.9, reason: "wet hair" });
    const fresh = await decide(request([env, user({ photo: "fresh" })]));
    expect(text(fresh)).toStartWith("✅ shower (Oct 8) photo accepted.\n🪥 gate armed: night teeth photo (overdue from Oct 8)");
  });

  test("an old EXIF timestamp is rejected; a missing one is fine", async () => {
    exif = { old: at(DAY, "05:00"), recent: at(DAY, "05:45") };
    const old = await decide(request([env, user({ photo: "old" })]));
    expect(text(old)).toStartWith("❌ photo rejected: its camera timestamp is 60 minutes old (limit 30).");
    expect(classified).toBe(0);
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" });
    expect((await decide(request([env, user({ photo: "recent" })]))).action).toBe("forward");
  });

  test("a non-proof photo stays locked and is not withheld", async () => {
    const decision = await decide(request([env, user("look", { photo: "screenshot" })]));
    expect(text(decision)).toStartWith("❌ photo not accepted: no person\n🪥 gate armed");
    verdicts.push({ kind: "teeth", confidence: 0.4, reason: "blurry" });
    expect(text(await decide(request([env, user({ photo: "blurry" })])))).toStartWith("❌ photo not clear enough to accept: blurry");
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" });
    const pass = await decide(request([env, user("look", { photo: "screenshot" }), assistant("locked"), user({ photo: "good" })]));
    expect(pass.action).toBe("forward");
    expect(JSON.stringify(pass)).toContain(photo("screenshot"));
  });

  test("a classifier failure keeps the gate locked and the photo can be retried", async () => {
    classifierDown = true;
    const turn = request([env, user({ photo: "p" })]);
    expect(text(await decide(turn))).toStartWith("⚠️ couldn't check the photo (classifier error).");
    classifierDown = false;
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" });
    expect((await decide(turn)).action).toBe("forward");
  });

  test("a shower photo sent during the day counts for tonight", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" }, { kind: "shower", confidence: 0.9, reason: "wet hair" });
    await decide(request([env, user({ photo: "morning" })]));
    clock = at(DAY, "13:00");
    const shower = await decide(request([env, user("post-gym", { photo: "shower" })]));
    expect(shower.action).toBe("forward");
    expect(JSON.stringify(shower)).toContain("accepted as shower (Oct 8) proof");
    clock = at("2026-10-09", "00:01");
    expect(gateStatus().outstanding.map((r) => r.label)).toEqual(["night teeth photo (overdue from Oct 8)"]);
  });
});

describe("BYPASS, debt and penance", () => {
  test("BYPASS opens for an hour, counts, and the next turn carries a byte-stable note", async () => {
    const bypass = await decide(request([env, user(BYPASS)]));
    expect(text(bypass)).toBe("🚪 bypass #1: gate open until 07:00. Your next turn will ask why.");
    expect(gateStatus()).toMatchObject({ state: "bypassed", bypass: { count: 1 }, armed: false });
    clock = at(DAY, "06:05");
    const history = [env, user(BYPASS), assistant("🚪 bypass #1"), user("now fix the bug")];
    const next = await decide(request(history));
    expect(next.action).toBe("forward");
    const noted = next.action === "forward" ? next.request.input as ResponseInputItem[] : [];
    const note = JSON.stringify(noted[3]);
    expect(note).toContain("<hygiene-gate-note>");
    expect(note).toContain("At 06:00 on Oct 8 Alex replied BYPASS to skip: morning teeth photo.");
    expect(note).toContain("http://127.0.0.1:3456/hygiene/debt/2026-10-08-1/resolve");
    // Codex replays without our text; the note returns identically on the same message.
    clock = at(DAY, "06:30");
    const replay = await decide(request([...history, assistant("why?"), user("I overslept")]));
    const replayed = replay.action === "forward" ? replay.request.input as ResponseInputItem[] : [];
    expect(JSON.stringify(replayed[3])).toBe(note);
    expect(JSON.stringify(replayed[5])).not.toContain("hygiene-gate-note");
    // The bypass expires after an hour.
    clock = at(DAY, "07:00");
    expect(text(await decide(request([env, user("hi")])))).toStartWith("🪥 gate armed: morning teeth photo");
  });

  test("BYPASS on a clear gate does nothing", async () => {
    clock = at(DAY, "04:00");
    expect(text(await decide(request([env, user(BYPASS)])))).toBe("✅ gate is already clear; no bypass used.");
    expect(gateStatus().bypass.count).toBe(0);
  });

  test("an unjustified ruling sets a penance that the classifier must match", async () => {
    await decide(request([env, user(BYPASS)]));
    const ruling = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", {
        method: "POST",
        body: JSON.stringify({ verdict: "unjustified", reason: "just lazy", penance: "photo of you on a walk outside" }),
      }),
    );
    expect(ruling.status).toBe(200);
    const twice = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", { method: "POST", body: JSON.stringify({ verdict: "justified" }) }),
    );
    expect(twice.status).toBe(409);
    clock = at(DAY, "07:30");
    const locked = text(await decide(request([env, user("hi")])));
    expect(locked).toContain("penance photo: photo of you on a walk outside");
    let asked: unknown;
    setGateDeps({
      now: () => clock,
      bypassWords,
      dhash: async () => null,
      captureTime: async () => null,
      classify: async (_image, wanted) => {
        asked = wanted;
        return verdicts.shift()!;
      },
    });
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" }, { kind: "penance", confidence: 0.9, reason: "outdoors" });
    await decide(request([env, user({ photo: "teeth" })]));
    expect((await decide(request([env, user({ photo: "walk" })]))).action).toBe("forward");
    expect(asked).toEqual({ kinds: ["shower", "penance"], penance: "photo of you on a walk outside" });
    expect(gateStatus()).toMatchObject({ state: "clear", openDebts: [] });
  });

  test("a justified ruling closes the debt with no penance", async () => {
    await decide(request([env, user(BYPASS)]));
    const ruling = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", { method: "POST", body: JSON.stringify({ verdict: "justified", reason: "fire alarm" }) }),
    );
    expect(ruling.status).toBe(200);
    expect(gateStatus().openDebts).toEqual([]);
    clock = at(DAY, "06:10");
    const next = await decide(request([env, user(BYPASS), assistant("ok"), user("go")]));
    expect(JSON.stringify(next)).not.toContain("hygiene-gate-note");
  });

  const teethPenance = async () => {
    await decide(request([env, user(BYPASS)]));
    const ruling = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", {
        method: "POST",
        body: JSON.stringify({ verdict: "unjustified", reason: "reflex", penance: "Photo of you brushing your teeth before bed" }),
      }),
    );
    expect(ruling.status).toBe(200);
  };

  test("a penance that asks for teeth takes a teeth photo while the teeth slot isn't due (Nov 4 01:23)", async () => {
    await teethPenance();
    let asked: { kinds: string[]; penance?: string } | undefined;
    setGateDeps({
      now: () => clock,
      bypassWords,
      dhash: async () => null,
      captureTime: async () => null,
      classify: async (_image, wanted) => {
        asked = wanted;
        return verdicts.shift()!;
      },
    });
    // The first photo fills morning teeth; the second is classified as teeth again, the way the
    // classifier answered at 01:23 ("nothing visible shows it is before bed, so it is not penance").
    verdicts.push(
      { kind: "teeth", confidence: 0.95, reason: "brushing" },
      { kind: "teeth", confidence: 0.95, reason: "nothing shows it is before bed, so not penance" },
    );
    clock = at(DAY, "06:20");
    await decide(request([env, user({ photo: "teeth-1" })]));
    clock = at(DAY, "07:30");
    const second = await decide(request([env, user("done", { photo: "teeth-2" })]));
    // Teeth is not among the kinds asked for: only the penance can take this photo.
    expect(asked).toEqual({ kinds: ["shower", "penance"], penance: "Photo of you brushing your teeth before bed" });
    expect(second.action).toBe("forward");
    expect(gateStatus()).toMatchObject({ state: "clear", openDebts: [] });
    const state = JSON.parse(await readFile(process.env.HYGIENE_GATE_STATE!, "utf8"));
    expect(state.debts[0]).toMatchObject({ status: "paid" });
    expect(state.images.at(-1)).toMatchObject({ kind: "penance", verdict: "accepted", slot: "penance/2026-10-08-1" });
  });

  test("a photo the gate wrongly refused can be credited for the penance, once, from its stored verdict", async () => {
    await teethPenance();
    clock = at(DAY, "07:30");
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    const refused = (sha: string, kind: string, extra: Record<string, unknown> = {}) => ({
      sha256: sha.repeat(64),
      dhash: null,
      at: new Date(clock - 60_000).toISOString(),
      source: { thread: "cairn", key: sha },
      kind,
      verdict: "rejected",
      reason: "not penance",
      confidence: 0.95,
      ...extra,
    });
    raw.images.push(
      refused("a", "teeth"),
      refused("b", "shower"),
      refused("d", "teeth", { at: new Date(clock - 25 * 3_600_000).toISOString() }),
      refused("e", "teeth", { at: new Date(at(DAY, "05:30")).toISOString() }),
      refused("f", "teeth", { confidence: 0.3 }),
      refused("9", "teeth", { confidence: undefined }),
      refused("8", "teeth", { at: "not a time" }),
    );
    await writeFile(path, JSON.stringify(raw));
    resetGateCache();
    const credit = (sha: string, body: unknown) =>
      handleRequest(new Request(`http://localhost/hygiene/images/${sha.repeat(64)}/credit-penance`, { method: "POST", body: JSON.stringify(body) }));
    const reason = { by: "test", reason: "refused by the penance matcher bug" };
    expect((await credit("a", {})).status).toBe(400);
    expect((await credit("c", reason)).status).toBe(404);
    expect((await credit("b", reason)).status).toBe(409);
    // More than 24 h old, sent before the penance was set, not clear enough, no confidence kept, bad time.
    for (const sha of ["d", "e", "f", "9", "8"]) expect((await credit(sha, reason)).status).toBe(409);
    expect(gateStatus().openDebts).toHaveLength(1);
    const ok = await credit("a", reason);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, debt: "2026-10-08-1", slot: "penance/2026-10-08-1" });
    expect(gateStatus().openDebts).toEqual([]);
    const state = JSON.parse(await readFile(path, "utf8"));
    const record = state.images.find((r: { sha256: string }) => r.sha256 === "a".repeat(64));
    expect(record).toMatchObject({
      verdict: "accepted",
      slot: "penance/2026-10-08-1",
      credited: { by: "test", reason: "refused by the penance matcher bug", at: new Date(clock).toISOString() },
    });
    // A credited bathroom photo stays out of the chats it was sent in.
    expect(record.manual).toBeUndefined();
    expect(isWithheld(record)).toBe(true);
    // Paid now, not at the photo's time.
    expect(state.debts[0]).toMatchObject({ status: "paid", penance: { paidAt: new Date(clock).toISOString() } });
    expect((await credit("a", reason)).status).toBe(409);
  });

  test("a photo credited by 2583b55 (marked manual) is moved to credited on load, so it is withheld again", async () => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.images.push({
      sha256: "a".repeat(64),
      dhash: null,
      at: new Date(clock).toISOString(),
      source: { thread: THREAD, key: "k" },
      kind: "teeth",
      verdict: "accepted",
      slot: "penance/x",
      manual: { verifier: "gym-gate" },
      reason: "brushing [credited for the penance at 2026-10-08T13:00:00.000Z by gym-gate: matcher bug]",
    });
    await writeFile(path, JSON.stringify(raw));
    resetGateCache();
    const state = await (await handleRequest(new Request("http://localhost/hygiene/state"))).json();
    const record = state.images.at(-1);
    expect(record.manual).toBeUndefined();
    expect(record.credited).toEqual({ by: "gym-gate", reason: "matcher bug", at: "2026-10-08T13:00:00.000Z" });
    expect(isWithheld(record)).toBe(true);
  });

  test("a penance can be revised to justified within 12 h, with a reason; the old verdict is kept", async () => {
    const post = (path: string, body: unknown) =>
      handleRequest(new Request(`http://localhost/hygiene/debt/${path}`, { method: "POST", body: JSON.stringify(body) }));
    await decide(request([env, user(BYPASS)]));
    // Nothing to revise yet: an open debt is ruled with resolve.
    expect((await post("2026-10-08-1/revise", { verdict: "justified", reason: "x" })).status).toBe(409);
    expect((await post("2026-10-08-1/resolve", { verdict: "unjustified", reason: "too cold", penance: "photo outside on Broadway" })).status).toBe(200);
    clock = at(DAY, "07:30");
    expect(text(await decide(request([env, user("hi")])))).toContain("penance photo: photo outside on Broadway");

    // Leniency only, and a reason is required.
    expect((await post("2026-10-08-1/revise", { verdict: "unjustified", reason: "x", penance: "y" })).status).toBe(400);
    expect((await post("2026-10-08-1/revise", { verdict: "justified" })).status).toBe(400);
    expect((await post("2026-10-08-1/revise", { verdict: "justified", reason: "   " })).status).toBe(400);
    expect((await post("nope/revise", { verdict: "justified", reason: "x" })).status).toBe(404);

    const revised = await post("2026-10-08-1/revise", { verdict: "justified", reason: "sunrise 08:03, cough" });
    expect(revised.status).toBe(200);
    const debt = (await revised.json()).debt;
    expect(debt).toMatchObject({ status: "justified", reason: "sunrise 08:03, cough" });
    expect(debt.penance).toBeUndefined();
    expect(debt.history).toEqual([
      expect.objectContaining({ status: "penance", reason: "too cold", penance: expect.objectContaining({ description: "photo outside on Broadway" }) }),
    ]);
    expect(gateStatus().openDebts).toEqual([]);
    expect(text(await decide(request([env, user({ photo: "teeth" })])))).not.toContain("penance");
    // Once justified it can't be revised again.
    expect((await post("2026-10-08-1/revise", { verdict: "justified", reason: "again" })).status).toBe(409);
  });

  test("a ruling older than 12 h can't be revised", async () => {
    await decide(request([env, user(BYPASS)]));
    await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", {
        method: "POST",
        body: JSON.stringify({ verdict: "unjustified", reason: "lazy", penance: "walk photo" }),
      }),
    );
    clock += 12 * 3_600_000 + 60_000;
    const late = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/revise", { method: "POST", body: JSON.stringify({ verdict: "justified", reason: "late" }) }),
    );
    expect(late.status).toBe(409);
    expect(gateStatus().openDebts.map((d: { status: string }) => d.status)).toEqual(["penance"]);
  });

  test("accepted photos are archived privately; the state file holds no image data", async () => {
    await decide(request([env, user("not a proof", { photo: "rejected-pixels" })]));
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" });
    await decide(request([env, user({ photo: "secret-pixels" })]));
    await decide(request([env, user(BYPASS)]));
    const raw = readFileSync(process.env.HYGIENE_GATE_STATE!, "utf8");
    expect(raw).not.toContain(photo("secret-pixels"));
    expect(raw).not.toContain(Buffer.from("secret-pixels").toString("base64"));
    const state = JSON.parse(raw);
    const accepted = state.images.find((i: { verdict: string }) => i.verdict === "accepted");
    expect(accepted).toMatchObject({ slot: `${DAY}/morning-teeth`, kind: "teeth" });
    expect(Object.keys(accepted).sort()).toEqual(["at", "confidence", "dhash", "file", "kind", "locked", "reason", "sha256", "slot", "source", "verdict"]);
    expect(accepted.locked).toBe(true);
    const root = process.env.HYGIENE_PHOTO_DIR!;
    expect(accepted.file).toBe(join(root, "2026", "10", "08", `teeth-060000-${accepted.sha256.slice(0, 8)}.jpg`));
    expect(readFileSync(accepted.file, "utf8")).toBe("secret-pixels");
    expect(statSync(accepted.file).mode & 0o777).toBe(0o600);
    for (const dir of [root, join(root, "2026"), join(root, "2026", "10"), join(root, "2026", "10", "08")])
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Rejected photos are never saved.
    expect(readdirSync(join(root, "2026", "10", "08"))).toEqual([accepted.file.split("/").pop()]);
  });
});

describe("weigh-in", () => {
  const enable = async (from = at(DAY, "05:00")) => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, weighInStartsAt: new Date(from).toISOString() }));
    resetGateCache();
  };

  test("locks alongside morning teeth; each photo fills its own slot and the reading is kept", async () => {
    await enable();
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo, morning weigh-in photo (scale reading)\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    expect(text(await decide(request([env, user({ photo: "teeth" })])))).toBe(
      "✅ morning teeth (Oct 8) photo accepted.\n🏋️ gate armed: morning weigh-in photo (scale reading)\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    verdicts.push({ kind: "weight", confidence: 0.9, reason: "scale display", reading: "72.4 kg" });
    const unlocked = await decide(request([env, user({ photo: "teeth" }), assistant("🏋️"), user({ photo: "scale" })]));
    expect(unlocked.action).toBe("forward");
    expect(JSON.stringify(unlocked)).toContain("[hygiene-gate: photo accepted as morning weigh-in (Oct 8) proof; image withheld]");
    expect(gateStatus().lastProofs.at(-1)).toMatchObject({ kind: "weight", slot: `${DAY}/morning-weight`, reading: "72.4 kg" });
  });

  test("is off until weighInStartsAt, and only arms from 05:00", async () => {
    await enable(at("2026-10-09", "05:00"));
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    clock = at("2026-10-09", "04:00");
    expect(gateStatus().dueToday.map((r) => r.slot)).toContain("2026-10-09/morning-weight");
  });

  test("DELAY postpones both morning photos", async () => {
    await enable();
    clock = at(DAY, "07:45");
    expect(text(await decide(request([env, user("DELAY")])))).toBe(
      "⏰ delay: gate open until 09:45. Send the morning photos before then.",
    );
    // Teeth alone keeps the delay open while the weigh-in is missing.
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    expect((await decide(request([env, user("DELAY"), assistant("⏰"), user({ photo: "t" })]))).action).toBe("forward");
    expect(gateStatus().delay.active).toBe(true);
    clock = at(DAY, "09:46");
    expect(text(await decide(request([env, user("later")])))).toStartWith("🏋️ gate armed: morning weigh-in photo");
  });
});

describe("creatine and outdoor walk", () => {
  const enable = async (from = at(DAY, "05:00")) => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    const iso = new Date(from).toISOString();
    await writeFile(path, JSON.stringify({ ...raw, creatineStartsAt: iso, walkStartsAt: iso }));
    resetGateCache();
  };
  const send = async (name: string) => {
    hashes[name] = new Bun.CryptoHasher("sha256").update(name).digest("hex");
    return decide(request([env, user({ photo: name })]));
  };

  test("creatine is one photo; the walk is two outdoor photos 15 min apart by receipt time", async () => {
    await enable();
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo, morning creatine photo (scoop or glass), 15-min outdoor walk (an outdoor photo at the start, another 15+ min later)\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    expect(text(await send("teeth"))).toStartWith("✅ morning teeth (Oct 8) photo accepted.\n💊 gate armed");
    verdicts.push({ kind: "creatine", confidence: 0.9, reason: "scoop of powder" });
    expect(text(await send("scoop"))).toStartWith("✅ morning creatine (Oct 8) photo accepted.\n🚶 gate armed");
    clock = at(DAY, "06:05");
    verdicts.push({ kind: "walk", confidence: 0.9, reason: "street" });
    expect(text(await send("street"))).toBe(
      "🚶 walk started at 06:05. Send another outdoor photo from 06:20 to finish it.\n🚶 gate armed: outdoor walk: second outdoor photo from 06:20\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    clock = at(DAY, "06:12");
    verdicts.push({ kind: "walk", confidence: 0.9, reason: "park" });
    expect(text(await send("park-early"))).toStartWith(
      "❌ too soon: the walk started at 06:05; send the second outdoor photo from 06:20.",
    );
    clock = at(DAY, "06:21");
    // The same view again is a near copy of the start photo, not a walk.
    hashes["street-again"] = hashes.street;
    expect(text(await decide(request([env, user({ photo: "street-again" })])))).toStartWith("❌ photo rejected: it is a near-copy");
    verdicts.push({ kind: "walk", confidence: 0.9, reason: "park" });
    const done = await send("park");
    expect(done.action).toBe("forward");
    expect(gateStatus().lastProofs.map((p) => p.slot)).toEqual(
      expect.arrayContaining([`${DAY}/morning-creatine`, `${DAY}/morning-walk-start`, `${DAY}/morning-walk`]),
    );
  });

  test("an outdoor photo sent while the gate is open (BYPASS) neither starts the walk nor is withheld", async () => {
    await enable();
    expect(text(await decide(request([env, user(BYPASS)])))).toStartWith("🚪");
    verdicts.push({ kind: "walk", confidence: 0.9, reason: "street" });
    const passed = await send("listing");
    expect(passed.action).toBe("forward");
    expect(JSON.stringify(passed)).toContain(photo("listing"));
    expect(gateStatus().lastProofs.map((p) => p.slot)).not.toContain(`${DAY}/morning-walk-start`);
  });

  test("a creatine photo sent during BYPASS counts when sent again after it", async () => {
    await enable();
    expect(text(await decide(request([env, user(BYPASS)])))).toStartWith("🚪");
    verdicts.push({ kind: "creatine", confidence: 0.9, reason: "scoop" });
    expect((await send("scoop")).action).toBe("forward");
    clock = at(DAY, "07:05");
    verdicts.push({ kind: "creatine", confidence: 0.9, reason: "scoop" });
    const again = await decide(request([env, user({ photo: "scoop" }), assistant("💊"), user("again", { photo: "scoop" })]));
    expect(JSON.stringify(again)).toContain("morning creatine (Oct 8) photo accepted");
  });

  test("off until enabled; DELAY postpones them with the other morning photos", async () => {
    await enable(at("2026-10-09", "05:00"));
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    const x = new Date(at(DAY, "20:00")).toISOString();
    const filled = { [`${DAY}/shower`]: x, [`${DAY}/night-teeth`]: x };
    await writeFile(path, JSON.stringify({ ...raw, filled }));
    resetGateCache();
    clock = at("2026-10-09", "07:45");
    expect(text(await decide(request([env, user("hi")])))).toStartWith(
      "🪥 gate armed: morning teeth photo, morning creatine photo (scoop or glass), 15-min outdoor walk",
    );
    expect(text(await decide(request([env, user("DELAY")])))).toBe(
      "⏰ delay: gate open until 09:45. Send the morning photos before then.",
    );
    // Teeth and creatine alone keep the delay open while the walk is missing.
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" }, { kind: "creatine", confidence: 0.9, reason: "scoop" });
    await send("t");
    await send("c");
    expect(gateStatus().delay.active).toBe(true);
    clock = at("2026-10-09", "09:46");
    expect(text(await decide(request([env, user("later")])))).toStartWith("🚶 gate armed: 15-min outdoor walk");
  });
});

describe("DELAY", () => {
  const morningLocked = async () => {
    clock = at(DAY, "07:45");
    expect(text(await decide(request([env, user("hi")])))).toStartWith("🪥 gate armed: morning teeth photo");
  };

  test("opens the morning lock for two hours, case-insensitively, with its own counter", async () => {
    await morningLocked();
    expect(text(await decide(request([env, user("  delay ")])))).toBe("⏰ delay: gate open until 09:45. Send the teeth photo before then.");
    expect(gateStatus()).toMatchObject({
      state: "clear",
      delay: { active: true, expires_at: new Date(at(DAY, "09:45")).toISOString(), count: 1 },
      bypass: { count: 0 },
    });
    expect(gateStatus().openDebts).toEqual([]);
    clock = at(DAY, "07:50");
    expect((await decide(request([env, user("hi"), assistant("⏰"), user("join the meeting notes")]))).action).toBe("forward");
  });

  test("is morning-only: refused after noon and against overdue night locks", async () => {
    clock = at(DAY, "12:00");
    expect(text(await decide(request([env, user("DELAY")])))).toBe(
      "DELAY only postpones the morning photos (05:00 to 12:00). For anything else, send the photo or reply BYPASS maple river otter.",
    );
    clock = at("2026-10-09", "00:30");
    expect(text(await decide(request([env, user("DELAY")])))).toStartWith("DELAY only postpones the morning photos");
    // 06:00 with last night's teeth still overdue: DELAY can't open that lock.
    clock = at("2026-10-09", "06:00");
    expect(text(await decide(request([env, user("DELAY")])))).toStartWith("DELAY only postpones the morning photos");
    expect(gateStatus().delay.count).toBe(0);
  });

  test("once per morning, and expiry relocks", async () => {
    await morningLocked();
    await decide(request([env, user("DELAY")]));
    clock = at(DAY, "09:44");
    expect((await decide(request([env, user("still in the meeting")]))).action).toBe("forward");
    clock = at(DAY, "09:45");
    expect(text(await decide(request([env, user("back")])))).toStartWith("🪥 gate armed: morning teeth photo");
    expect(text(await decide(request([env, user("DELAY"), assistant("x"), user("DELAY")])))).toBe(
      // The gate armed again when the delay ended: a new lock, new words.
      "DELAY was already used this morning. Send the teeth photo, or reply BYPASS cedar comet tulip.",
    );
    expect(gateStatus()).toMatchObject({ state: "armed", delay: { active: false, count: 1 } });
    expect(text(await decide(request([env, user(BYPASS)])))).toStartWith("🔑 That isn't this lock's BYPASS phrase.");
    // BYPASS still works after an expired delay and counts as a bypass.
    expect(text(await decide(request([env, user("BYPASS cedar comet tulip")])))).toStartWith("🚪 bypass #1");
    expect(gateStatus()).toMatchObject({ bypass: { count: 1 }, delay: { count: 1 } });
  });

  test("every turn in the window carries a byte-stable nag note", async () => {
    await morningLocked();
    await decide(request([env, user("DELAY")]));
    const first = [env, user("DELAY"), assistant("⏰"), user("summarise the agenda")];
    const one = await decide(request(first));
    const nag = "Alex used DELAY to postpone his morning photos (teeth, plus the weigh-in, creatine and outdoor walk when due) until 09:45.";
    const firstInput = one.action === "forward" ? (one.request.input as ResponseInputItem[]) : [];
    expect(JSON.stringify(firstInput[3])).toContain(nag);
    expect(JSON.stringify(firstInput[3])).toContain("End your final reply to this message with one short line asking him to send the missing morning photo.");
    clock = at(DAY, "08:10");
    const second = [...first, assistant("agenda... (send the teeth photo!)"), user("thanks, next item")];
    const two = await decide(request(second));
    const secondInput = two.action === "forward" ? (two.request.input as ResponseInputItem[]) : [];
    expect(JSON.stringify(secondInput[3])).toBe(JSON.stringify(firstInput[3]));
    expect(JSON.stringify(secondInput[5])).toContain(nag);
    // A tool-loop continuation carries the same notes and adds none.
    const loop = await decide(
      request([...second, { type: "function_call", call_id: "c", name: "exec", arguments: "{}" } as ResponseInputItem, { type: "function_call_output", call_id: "c", output: "ok" } as ResponseInputItem]),
    );
    const loopInput = loop.action === "forward" ? (loop.request.input as ResponseInputItem[]) : [];
    expect(JSON.stringify(loopInput.slice(0, 6))).toBe(JSON.stringify(secondInput));
  });

  test("a passing teeth photo clears the delay and the nag", async () => {
    await morningLocked();
    await decide(request([env, user("DELAY")]));
    clock = at(DAY, "08:30");
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    const photoTurn = await decide(request([env, user("DELAY"), assistant("⏰"), user({ photo: "after-meeting" })]));
    expect(photoTurn.action).toBe("forward");
    expect(JSON.stringify(photoTurn)).not.toContain("Alex used DELAY");
    expect(gateStatus()).toMatchObject({ state: "clear", delay: { active: false, expires_at: null, count: 1 } });
    clock = at(DAY, "10:00");
    const later = await decide(request([env, user("DELAY"), assistant("⏰"), user({ photo: "after-meeting" }), assistant("thanks"), user("next")]));
    expect(later.action).toBe("forward");
    expect(JSON.stringify(later)).not.toContain("Alex used DELAY");
  });
});

describe("dthread messages", () => {
  // dthread (~/code/alexng353/dthread) sends Alex's terminal input through
  // Plate's relay chat; Desktop delivers it as an escaped delegation.
  const RELAY = "01a0fa23-38a5-7ae3-8afa-ff89f646b836";
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const delegation = (input: string, source = RELAY) =>
    user(`<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>${escape(input)}</input>\n</codex_delegation>`);
  const dthread = (typed: string, source = RELAY) => delegation(`<dthread_message>${typed}</dthread_message>`, source);
  const sent = (item: ResponseInputItem) => request([env, item], "app_tool_send_message");

  test("a dthread BYPASS opens the gate", async () => {
    expect(text(await decide(sent(dthread(BYPASS))))).toBe("🚪 bypass #1: gate open until 07:00. Your next turn will ask why.");
    expect(gateStatus()).toMatchObject({ state: "bypassed", bypass: { count: 1 } });
  });

  test("an armed gate locks a dthread turn with its usual reply", async () => {
    expect(text(await decide(sent(dthread("fix the bug & ship it"))))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).",
    );
    clock = at(DAY, "04:59");
    expect((await decide(sent(dthread("hi")))).action).toBe("forward");
  });

  test("a dthread DELAY follows the normal DELAY rules", async () => {
    clock = at(DAY, "07:45");
    expect(text(await decide(sent(dthread("delay"))))).toBe("⏰ delay: gate open until 09:45. Send the teeth photo before then.");
    clock = at(DAY, "12:00");
    expect(text(await decide(sent(dthread("DELAY"))))).toStartWith("DELAY only postpones the morning photos");
  });

  test("a delegation from any other chat stays exempt and cannot spend a BYPASS", async () => {
    const other = await decide(sent(dthread("BYPASS", "01a14383-0f07-7ad3-be73-dc2e11c528a3")));
    expect(other.action).toBe("forward");
    // An agent's own text wrapped like dthread, without the relay envelope.
    expect((await decide(sent(user("<dthread_message>BYPASS</dthread_message>")))).action).toBe("forward");
    // The wrapper must be the whole input, not text an agent quotes inside it.
    expect((await decide(sent(delegation("note: <dthread_message>BYPASS</dthread_message>")))).action).toBe("forward");
    expect(gateStatus().bypass.count).toBe(0);
  });

  test("a jarvis voice request from the relay stays exempt", async () => {
    expect((await decide(sent(delegation("[jarvis] BYPASS")))).action).toBe("forward");
    expect((await decide(sent(delegation("[jarvis] pause the music")))).action).toBe("forward");
    expect(gateStatus().bypass.count).toBe(0);
  });
});

describe("held messages wake their chat when the gate unlocks", () => {
  const OTHER = "01a15cc2-0000-7000-8000-000000000001";
  const teeth = { kind: "teeth", confidence: 0.95, reason: "brushing" } as Verdict;
  const cairnTeeth = (name: string) =>
    submitProof({ mediaType: "image/jpeg", bytes: Buffer.from(name) }, { kind: "teeth", slot: (s) => s.endsWith("/morning-teeth") });

  test("an unlock with held messages wakes each chat once, listing them", async () => {
    clock = at(DAY, "06:20");
    const held = await decide(request([env, user("what is this? https://x.com/a/status/1")], "composer", { prompt_cache_key: OTHER }));
    expect(text(held)).toContain("gate armed");
    clock = at(DAY, "06:40");
    verdicts.push(teeth);
    expect((await cairnTeeth("cairn-teeth")).result).toBe("pass");
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].thread).toBe(OTHER);
    expect(wakes[0].text).toContain("06:20");
    expect(wakes[0].text).toContain("what is this? https://x.com/a/status/1");
    expect(wakes[0].id).toMatch(/^hygiene-unlock-/);
    // A later flush or a retry of the same submission sends nothing more.
    await flushWakes();
    expect((await cairnTeeth("cairn-teeth")).result).toBe("pass");
    await flushWakes();
    expect(wakes).toHaveLength(1);
  });

  test("revising the penance that held a chat wakes it; a paid penance can't be revised", async () => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const s = JSON.parse(await readFile(path, "utf8"));
    s.filled = { ...(s.filled ?? {}), [`${DAY}/morning-teeth`]: new Date(at(DAY, "05:30")).toISOString() };
    const ruled = new Date(at(DAY, "06:00")).toISOString();
    s.debts = [
      { id: "d1", at: ruled, skipped: [], status: "penance", reason: "too cold", ruledAt: ruled, penance: { description: "walk photo", setAt: ruled } },
      { id: "d2", at: ruled, skipped: [], status: "paid", ruledAt: ruled, penance: { description: "x", setAt: ruled, paidAt: ruled } },
    ];
    await writeFile(path, JSON.stringify(s));
    resetGateCache();
    clock = at(DAY, "06:20");
    const held = await decide(request([env, user("plan my day")], "composer", { prompt_cache_key: OTHER }));
    expect(text(held)).toContain("penance photo: walk photo");
    clock = at(DAY, "06:40");
    const post = (id: string, body: string) =>
      handleRequest(new Request(`http://localhost/hygiene/debt/${id}/revise`, { method: "POST", body }));
    expect((await post("d2", JSON.stringify({ verdict: "justified", reason: "x" }))).status).toBe(409);
    expect((await post("d1", "null")).status).toBe(400);
    expect((await post("d1", JSON.stringify({ verdict: "justified", reason: "sunrise 08:03" }))).status).toBe(200);
    expect(gateStatus()).toMatchObject({ state: "clear", openDebts: [] });
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].thread).toBe(OTHER);
    expect(wakes[0].text).toContain("plan my day");
  });

  test("an unlock with nothing held posts nothing", async () => {
    verdicts.push(teeth);
    expect((await cairnTeeth("cairn-teeth")).result).toBe("pass");
    await flushWakes();
    expect(wakes).toHaveLength(0);
  });

  test("a message while a photo is being checked gets 'photo received, checking', not a re-arm", async () => {
    let release!: () => void;
    classifyBlock = new Promise((resolve) => (release = resolve));
    verdicts.push(teeth);
    const pending = cairnTeeth("cairn-teeth");
    while (classified === 0) await Bun.sleep(5);
    // Bounded: without the fast reply this message waits behind the check forever.
    const during = await Promise.race([decide(request([env, user("still there?")])), Bun.sleep(1000).then(() => null)]);
    release();
    expect(during).not.toBeNull();
    expect(text(during!)).toContain("photo received, checking");
    expect(text(during!)).not.toContain("gate armed");
    expect((await pending).result).toBe("pass");
    expect(classified).toBe(1);
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].thread).toBe(THREAD);
    expect(wakes[0].text).toContain("still there?");
    // Once the check is done, the next message is gated normally (here: clear).
    expect((await decide(request([env, user("still there?"), assistant("ok"), user("next")]))).action).toBe("forward");
  });

  test("a duplicate unlock never wakes twice, and a retried send reuses its id", async () => {
    expect(text(await decide(request([env, user("fix the bug")])))).toContain("gate armed");
    wakeResults = ["retry", "sent"];
    expect(text(await decide(request([env, user("fix the bug"), assistant("locked"), user(BYPASS)])))).toContain("bypass #1");
    await flushWakes();
    expect(wakes).toHaveLength(1);
    // A second BYPASS while open, and a proof after it, are not new unlocks of held messages.
    expect(
      text(await decide(request([env, user("fix the bug"), assistant("locked"), user(BYPASS), assistant("open"), user(BYPASS)]))),
    ).toContain("already open");
    verdicts.push(teeth);
    await cairnTeeth("cairn-teeth");
    clock += 31_000;
    await flushWakes();
    expect(wakes).toHaveLength(2);
    expect(wakes[1].id).toBe(wakes[0].id);
    expect(wakes[1].text).toBe(wakes[0].text);
    clock += 3_600_000;
    await flushWakes();
    expect(wakes).toHaveLength(2);
  });

  test("an unlocking photo in the same chat carries the held messages in a note instead of a wake", async () => {
    clock = at(DAY, "06:20");
    expect(text(await decide(request([env, user("look at this link")])))).toContain("gate armed");
    clock = at(DAY, "06:30");
    verdicts.push(teeth);
    const decision = await decide(request([env, user("look at this link"), assistant("locked"), user({ photo: "teeth-1" })]));
    expect(decision.action).toBe("forward");
    const forwarded = JSON.stringify(decision.action === "forward" && decision.request);
    expect(forwarded).toContain("hygiene-gate-note");
    expect(forwarded).toContain("06:20");
    expect(forwarded).toContain("look at this link");
    await flushWakes();
    expect(wakes).toHaveLength(0);
  });

  test("a chat id that is not a Codex thread id is never held", async () => {
    expect(text(await decide(request([env, user("hi")], "composer", { prompt_cache_key: "not-a-thread; rm -rf ~" })))).toContain("gate armed");
    verdicts.push(teeth);
    await cairnTeeth("cairn-teeth");
    await flushWakes();
    expect(wakes).toHaveLength(0);
  });

  test("held text is scrubbed before it is stored or sent", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(text(await decide(request([env, user(`use ${token} for the push`)], "composer", { prompt_cache_key: OTHER })))).toContain("gate armed");
    expect(await readFile(join(dirname(process.env.HYGIENE_GATE_STATE!), "hygiene-held.json"), "utf8")).not.toContain(token);
    verdicts.push(teeth);
    await cairnTeeth("cairn-teeth");
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).not.toContain(token);
    expect(wakes[0].text).toContain("[REDACTED:github-token]");
  });

  test("messages held more than 24 hours are dropped and counted in the wake", async () => {
    clock = at(DAY, "06:00");
    expect(text(await decide(request([env, user("old ask")], "composer", { prompt_cache_key: OTHER })))).toContain("gate armed");
    clock = at("2026-10-09", "07:00");
    expect(text(await decide(request([env, user("old ask"), assistant("locked"), user("new ask")], "composer", { prompt_cache_key: OTHER })))).toContain("gate armed");
    // Yesterday's morning lock aged out; today's is a new lock with new words.
    expect(text(await decide(request([env, user(`BYPASS ${PHRASES[1]}`)])))).toContain("bypass #1");
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("new ask");
    expect(wakes[0].text).not.toContain("old ask");
    expect(wakes[0].text).toContain("(1 older message dropped");
  });

  test("a hold that lands after another copy's check released is released behind the lock", async () => {
    // Another proxy copy (a handoff) is mid-check: it holds the gate's lock and the check mark.
    const statePath = process.env.HYGIENE_GATE_STATE!;
    const other = Bun.spawn(["flock", "-x", "-o", `${statePath}.lock`, "sleep", "10"], { stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 200 && !(await Bun.file(`${statePath}.lock`).exists()); i++) await Bun.sleep(5);
      await Bun.sleep(100);
      await writeFile(join(dirname(statePath), "hygiene-checking.json"), JSON.stringify({ pid: other.pid, until: Date.now() + 60_000 }));
      expect(text(await decide(request([env, user("are you there?")], "composer", { prompt_cache_key: OTHER })))).toContain("photo received, checking");
      // That copy's photo passed and it released before this hold was written.
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.filled[`${DAY}/morning-teeth`] = new Date(clock).toISOString();
      await writeFile(statePath, JSON.stringify(state));
      await rm(join(dirname(statePath), "hygiene-checking.json"));
    } finally {
      other.kill();
      await other.exited;
    }
    for (let i = 0; i < 100 && !wakes.length; i++) {
      await Bun.sleep(20);
      await flushWakes();
    }
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("are you there?");
  });

  test("the wake command validates its arguments and routes another machine's chat over ssh", () => {
    const id = "hygiene-unlock-1793522368049-0123456789ab";
    const local = wakeCommand({ id, thread: OTHER }, "forge")!;
    expect(local.slice(-4)).toEqual([id, "--", OTHER, "-"]);
    expect(local[0]).not.toBe("ssh");
    expect(wakeCommand({ id, thread: OTHER, machine: "forge" }, "forge")![0]).not.toBe("ssh");
    const remote = wakeCommand({ id, thread: OTHER, machine: "arch" }, "forge")!;
    expect(remote.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "arch"]);
    expect(remote[7]).toContain(`--from hygiene-gate --client-message-id ${id} -- ${OTHER} -`);
    expect(wakeCommand({ id, thread: "x; rm -rf ~" }, "forge")).toBeNull();
    expect(wakeCommand({ id: "x;y", thread: OTHER }, "forge")).toBeNull();
    expect(wakeCommand({ id, thread: OTHER, machine: "arch;id" }, "forge")).toBeNull();
  });

  test("an origin machine not in HYGIENE_GATE_MACHINES is treated as local and never ssh'd to", async () => {
    const id = "hygiene-unlock-1793522368049-0123456789ab";
    expect(wakeCommand({ id, thread: OTHER, machine: "evilbox" }, "forge")![0]).not.toBe("ssh");
    expect(text(await gateRequest(request([env, user("hi from elsewhere")], "composer", { prompt_cache_key: OTHER }), { machine: "evilbox" }))).toContain("gate armed");
    verdicts.push(teeth);
    await cairnTeeth("cairn-teeth");
    await flushWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].machine).toBeUndefined();
    expect(wakeCommand(wakes[0], "forge")![0]).not.toBe("ssh");
    // A listed machine still routes over ssh.
    const listedBefore = process.env.HYGIENE_GATE_MACHINES;
    process.env.HYGIENE_GATE_MACHINES = "arch, evilbox";
    try {
      expect(wakeCommand({ id, thread: OTHER, machine: "evilbox" }, "forge")![0]).toBe("ssh");
    } finally {
      if (listedBefore === undefined) delete process.env.HYGIENE_GATE_MACHINES;
      else process.env.HYGIENE_GATE_MACHINES = listedBefore;
    }
  });

  test("the unlocking chat's note counts its dropped messages", async () => {
    clock = at(DAY, "06:00");
    expect(text(await decide(request([env, user("old ask")])))).toContain("gate armed");
    // Oct 8's evening proofs were sent, so on Oct 9 only the morning teeth photo locks.
    const path = process.env.HYGIENE_GATE_STATE!;
    const state = JSON.parse(await readFile(path, "utf8"));
    state.filled[`${DAY}/morning-teeth`] = state.filled[`${DAY}/shower`] = state.filled[`${DAY}/night-teeth`] = new Date(at(DAY, "20:00")).toISOString();
    await writeFile(path, JSON.stringify(state));
    clock = at("2026-10-09", "07:00");
    const history = [env, user("old ask"), assistant("locked")];
    expect(text(await decide(request([...history, user("new ask")])))).toContain("gate armed");
    verdicts.push(teeth);
    const decision = await decide(request([...history, user("new ask"), assistant("locked"), user({ photo: "teeth-2" })]));
    expect(decision.action).toBe("forward");
    const forwarded = JSON.stringify(decision.action === "forward" && decision.request);
    expect(forwarded).toContain("new ask");
    expect(forwarded).toContain("(1 older message dropped");
  });

  test("a chat whose held messages all aged out is logged, not woken", async () => {
    clock = at(DAY, "06:00");
    expect(text(await decide(request([env, user("old ask")], "composer", { prompt_cache_key: OTHER })))).toContain("gate armed");
    clock = at("2026-10-09", "07:00");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(text(await decide(request([env, user(`BYPASS ${PHRASES[1]}`)])))).toContain("bypass #1");
      await flushWakes();
      expect(wakes).toHaveLength(0);
      expect(logged.mock.calls.map((c) => String(c[0])).some((line) => line.includes("dropped 1 held message") && line.includes(OTHER.slice(0, 8)))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("kill switch", () => {
  test("the disabled file turns the gate fully off", async () => {
    await writeFile(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    const turn = request([env, user("hi", { photo: "x" })]);
    const decision = await decide(turn);
    expect(decision).toEqual({ action: "forward", request: turn });
    expect(gateStatus()).toMatchObject({ enabled: false, state: "disabled", armed: false });
    expect(existsSync(process.env.HYGIENE_GATE_STATE!)).toBe(true);
    expect(classified).toBe(0);
  });
});

describe("locked responses through the proxy", () => {
  const post = (body: unknown) =>
    handleRequest(new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify(body) }));

  // 2026-10-29: Today's 08:00 timer and a /summary side prompt got the gate text
  // instead of running, and nothing ran them later.
  test("Claude path: a timer and Today side prompts run while the gate is armed", async () => {
    const ran = async (body: ResponsesRequest) => {
      const json = await (await post(body)).json();
      return json.output[0].content[0].text as string;
    };
    // `today-daemon send --from today-self-improve`, as Today delivers it.
    const timer = user(
      "[08:00 PDT Thu Oct 29] <codex_delegation>\n  <source_thread_id>script:today-self-improve</source_thread_id>\n  <sent_at>08:00 PDT Thu Oct 29</sent_at>\n  <input>[timer daily 08:00] Self-improvement review</input>\n</codex_delegation>",
    );
    expect(await ran(request([env, timer], "app_tool_send_message"))).toBe("model-ran");
    const { client_metadata: _, ...bare } = request([env, timer]) as ResponsesRequest & { client_metadata?: unknown };
    expect(await ran(bare)).toBe("model-ran");
    const side = (instructions: string, question: string) =>
      request([developer(instructions), env, user(`[06:54 PDT Thu Oct 29] ${question}`)]);
    const MARK = "<today-side-call/>";
    expect(
      await ran(side(`${MARK}\nYou produce a concise catch-up since Alex's last message.`, "Produce the catch-up summary from the supplied snapshot. Answer only; use no tools.")),
    ).toBe("model-ran");
    expect(
      await ran(side(`${MARK}\nBase instructions.\n\nYou produce a concise catch-up since 2h ago.`, "Produce the catch-up summary.")),
    ).toBe("model-ran");
    // /btw has tools, so Today leaves it unmarked and the gate answers it.
    expect(
      await ran(side("You are a side prompt of Alex's thread \"Today\": a short side conversation.", "what is the builder doing?")),
    ).toContain("🪥 gate armed");
    // Alex's own turn in the same chat is still answered by the gate, and so is a
    // timer tag he types, and a chat whose restored history quotes the marker.
    expect(await ran(request([env, timer, assistant("ok"), user("[08:05 PDT Thu Oct 29] hi")]))).toContain("🪥 gate armed");
    expect(await ran(request([env, user("[08:05 PDT Thu Oct 29] [timer] do my work")]))).toContain("🪥 gate armed");
    expect(
      await ran(side(`base\n\n<restored-conversation>\n{"role":"Alex","text":"${MARK}"}\n</restored-conversation>`, "hi")),
    ).toContain("🪥 gate armed");
  });

  // Typed agent tags were an exemption Alex could type past; every live sender
  // now arrives in the delegation envelope (checked 2026-10-30).
  test("Claude path: typed agent tags get the gate, envelopes still run", async () => {
    const ran = async (body: ResponsesRequest) => {
      const json = await (await post(body)).json();
      return json.output[0].content[0].text as string;
    };
    for (const typed of ["[agent] hi", "[from x] hi", "[foo.sh] hi", "[08:05 PDT Fri Oct 30] [agent] hi", "<developer> hi"])
      expect(await ran(request([env, user(typed)]))).toContain("🪥 gate armed");
    const delegation = user(
      "[08:05 PDT Fri Oct 30] <codex_delegation>\n  <source_thread_id>01a1370e</source_thread_id>\n  <sent_at>08:05 PDT Fri Oct 30</sent_at>\n  <input>[agent] shipped</input>\n</codex_delegation>",
    );
    expect(await ran(request([env, delegation], "app_tool_send_message"))).toBe("model-ran");
    expect(await ran(request([env, delegation]))).toBe("model-ran");
    const script = user(
      "[08:05 PDT Fri Oct 30] <codex_delegation>\n  <source_thread_id>script:ship-arch</source_thread_id>\n  <sent_at>08:05 PDT Fri Oct 30</sent_at>\n  <input>[ship-arch.sh] installed</input>\n</codex_delegation>",
    );
    expect(await ran(request([env, script], "app_tool_send_message"))).toBe("model-ran");
    expect(await ran(request([env, script]))).toBe("model-ran");
  });

  test("Claude path: locked turn streams a final answer and Claude never starts", async () => {
    const before = existsSync(join(directory, "inputs")) ? (await readFile(join(directory, "inputs"), "utf8")).length : 0;
    const response = await post({ ...request([env, user("hi")]), stream: true });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: response.completed");
    expect(body).toContain('"phase":"final_answer"');
    expect(body).toContain("🪥 gate armed: morning teeth photo");
    const after = existsSync(join(directory, "inputs")) ? (await readFile(join(directory, "inputs"), "utf8")).length : 0;
    expect(after).toBe(before);
    const plain = await (await post(request([env, user("hi")]))).json();
    expect(plain.output[0]).toMatchObject({ type: "message", role: "assistant", phase: "final_answer" });
  });

  test("Claude path: a valid photo unlocks and the forwarded turn reaches Claude without the image", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const response = await post(request([env, user("hi"), assistant("🪥 gate armed"), user({ photo: "brushing" })]));
    const json = await response.json();
    expect(json.output[0].content[0].text).toBe("model-ran");
    const inputs = await readFile(join(directory, "inputs"), "utf8");
    expect(inputs).toContain("accepted as morning teeth (Oct 8) proof");
    expect(inputs).not.toContain(Buffer.from("brushing").toString("base64"));
  });

  test("router path: /hygiene/gate answers respond or forward", async () => {
    const gate = (body: unknown) =>
      handleRequest(new Request("http://localhost/hygiene/gate", { method: "POST", body: JSON.stringify(body) }));
    const locked = await (await gate({ ...request([env, user("hi")]), model: "gpt-6-astra" })).json();
    expect(locked.action).toBe("respond");
    expect(locked.response.model).toBe("gpt-6-astra");
    expect(locked.response.output[0].content[0].text).toStartWith("🪥 gate armed");
    const exempt = await (await gate({ ...request([env, user("x")], "automation_cron_scheduled"), model: "gpt-6-astra" })).json();
    expect(exempt).toEqual({ action: "forward" });
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const unlocked = await (await gate({ ...request([env, user({ photo: "gpt-teeth" })]), model: "gpt-6-astra" })).json();
    expect(unlocked.action).toBe("forward");
    expect(JSON.stringify(unlocked.request)).toContain("image withheld");
    const status = await (await handleRequest(new Request("http://localhost/hygiene/status"))).json();
    expect(status).toMatchObject({ enabled: true, state: "clear", bypass: { count: 0 } });
  });
});

describe("Cairn API", () => {
  const tokens: Record<string, { id: string; name: string; role: string }> = {
    phone: { id: "phone-1", name: "iphone", role: "phone" },
    agent: { id: "agent-1", name: "codex", role: "agent" },
  };
  let relayDown = false;
  beforeEach(() =>
    setAuthenticator(async (token) => {
      if (relayDown) throw new Error("down");
      return tokens[token] ?? null;
    }),
  );
  afterAll(() => setAuthenticator());
  const api = (path: string, init: RequestInit & { token?: string; headers?: Record<string, string> } = {}) =>
    handleRequest(
      new Request(`http://localhost/hygiene/api/v1${path}`, {
        ...init,
        headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
      }),
    );
  const submit = (kind: string, name: string, token = "phone") =>
    api("/proofs", { method: "POST", token, body: JSON.stringify({ kind, image: Buffer.from(name).toString("base64") }) });

  test("accepted weight stores durable sync intent and EXIF without a Cairn connection", async () => {
    verdicts.push({ kind: "weight", confidence: 0.99, reason: "scale", reading: "226.9 lb" });
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, weighInStartsAt: new Date(at(DAY, "05:00")).toISOString() }));
    resetGateCache();
    exif["weight-sync"] = clock - 60_000;
    const reply = await submit("weight_morning", "weight-sync");
    expect((await reply.json() as any).result).toBe("pass");
    const state = JSON.parse(readFileSync(process.env.HYGIENE_GATE_STATE!, "utf8"));
    expect(state.images.at(-1)).toMatchObject({ verdict: "accepted", cairnWeightPending: true, capturedAt: new Date(clock - 60_000).toISOString() });
    expect((await api("/weight-reviews")).status).toBe(401);
    const reviews = await api("/weight-reviews", { token: "phone" });
    expect(reviews.status).toBe(200);
    expect(await reviews.json()).toMatchObject({ reviews: [], pending: 1 });
  });

  test("a penance photo sent from Cairn pays the penance; a revised one isn't due", async () => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    const ruled = new Date(clock - 3_600_000).toISOString();
    raw.debts = [
      { id: "d1", at: ruled, skipped: [], status: "penance", ruledAt: ruled, penance: { description: "walk photo outside", setAt: ruled } },
      { id: "d2", at: ruled, skipped: [], status: "penance", ruledAt: ruled, penance: { description: "ten pushups", setAt: ruled } },
    ];
    await writeFile(path, JSON.stringify(raw));
    resetGateCache();
    let asked: unknown;
    setGateDeps({
      now: () => clock,
      bypassWords,
      dhash: async () => null,
      captureTime: async (bytes) => exif[bytes.toString("utf8")] ?? null,
      classify: async (_image, wanted) => {
        asked = wanted;
        return verdicts.shift()!;
      },
    });
    exif["penance-photo"] = clock - 60_000;
    verdicts.push({ kind: "penance", confidence: 0.95, reason: "outdoors" });
    const paid = (await (await submit("penance", "penance-photo")).json()) as any;
    expect(paid).toMatchObject({ result: "pass", verdict: "accepted", slot: "penance/d1" });
    // Judged against the oldest open penance's own description, and nothing else filled.
    expect(asked).toEqual({ kinds: ["penance"], penance: "walk photo outside" });
    expect(paid.gate.open_debts.map((d: any) => d.id)).toEqual(["d2"]);
    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state.debts[0].penance.paidAt).toBeString();
    expect(Object.keys(state.filled).filter((s) => !s.startsWith("penance/"))).toEqual(
      Object.keys(raw.filled ?? {}).filter((s) => !s.startsWith("penance/")),
    );

    // Revised away: no penance is open, so another photo is not due.
    const revised = await handleRequest(
      new Request("http://localhost/hygiene/debt/d2/revise", { method: "POST", body: JSON.stringify({ verdict: "justified", reason: "new facts" }) }),
    );
    expect(revised.status).toBe(200);
    exif["penance-again"] = clock - 60_000;
    const again = (await (await submit("penance", "penance-again")).json()) as any;
    expect(again.result).toBe("fail");
    expect(again.verdict).toBe("not_due");
  });

  test("auth: no token, unknown token and agent devices are refused; a down relay is 503", async () => {
    expect((await api("/status")).status).toBe(401);
    expect((await api("/status", { token: "nope" })).status).toBe(401);
    expect((await api("/status", { token: "agent" })).status).toBe(403);
    relayDown = true;
    setAuthenticator(async () => {
      throw new Error("down");
    });
    expect((await api("/status", { token: "phone" })).status).toBe(503);
    relayDown = false;
  });

  test("status reports the gate, delay and bypass", async () => {
    const body = await (await api("/status", { token: "phone" })).json();
    expect(body).toMatchObject({
      enabled: true,
      state: "armed",
      today: DAY,
      outstanding: [{ slot: `${DAY}/morning-teeth`, kind: "teeth" }],
      bypass: { count: 0, active_until: null },
      delay: { active: false, expires_at: null, count: 0 },
    });
  });

  test("status keeps the requested weigh-in visible during DELAY", async () => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, weighInStartsAt: new Date(at(DAY, "05:00")).toISOString() }));
    resetGateCache();
    await decide(request([env, user("DELAY")]));
    const body = await (await api("/status", { token: "phone" })).json();
    expect(body).toMatchObject({ state: "clear", outstanding: [], delay: { active: true } });
    expect(body.due_today).toContainEqual({
      slot: `${DAY}/morning-weight`, kind: "weight", label: "morning weigh-in photo (from 05:00)",
    });
    verdicts.push({ kind: "weight", confidence: 0.9, reason: "scale", reading: "160.2 lb" });
    const accepted = await (await submit("weight_morning", "delayed-scale")).json();
    expect(accepted).toMatchObject({ result: "pass", slot: `${DAY}/morning-weight` });
    const after = await (await api("/status", { token: "phone" })).json();
    expect(after.due_today.map((r: { slot: string }) => r.slot)).not.toContain(`${DAY}/morning-weight`);
    expect(after.due_today.map((r: { slot: string }) => r.slot)).toContain(`${DAY}/morning-teeth`);
  });

  test("a passing morning proof unlocks the chat gate and appears in the daily photos", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    const body = await (await submit("teeth_morning", "cairn-teeth")).json();
    expect(body).toMatchObject({ result: "pass", verdict: "accepted", slot: `${DAY}/morning-teeth`, gate: { state: "clear" } });
    expect((await decide(request([env, user("hi")]))).action).toBe("forward");
    // Resending the same bytes returns the first verdict without a new check.
    const again = await (await submit("teeth_morning", "cairn-teeth")).json();
    expect(again).toMatchObject({ result: "pass", slot: `${DAY}/morning-teeth` });
    expect(classified).toBe(1);
    const list = await (await api(`/photos?from=${DAY}&to=${DAY}`, { token: "phone" })).json();
    expect(list.days).toHaveLength(1);
    expect(list.days[0]).toMatchObject({ day: DAY, photos: [{ kind: "teeth", slot: `${DAY}/morning-teeth`, manual: false }] });
    const file = await api(list.days[0].photos[0].url.replace("/hygiene/api/v1", ""), { token: "phone" });
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(await file.text()).toBe("cairn-teeth");
    expect((await api(`/photos/${"0".repeat(64)}`, { token: "phone" })).status).toBe(404);
  });

  test("Cairn can send the morning weigh-in once it is enabled", async () => {
    expect(await (await submit("weight_morning", "too-early")).json()).toMatchObject({ result: "fail", verdict: "not_due" });
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, weighInStartsAt: new Date(at(DAY, "05:00")).toISOString() }));
    resetGateCache();
    verdicts.push({ kind: "weight", confidence: 0.9, reason: "scale", reading: "160.2 lb" });
    expect(await (await submit("weight_morning", "cairn-scale")).json()).toMatchObject({
      result: "pass",
      slot: `${DAY}/morning-weight`,
      message: "✅ morning weigh-in (Oct 8) photo accepted (160.2 lb).",
      reading: "160.2 lb",
      weight_lb: 160.2,
    });
    // A resend returns the stored reading without another classifier call.
    const again = await (await submit("weight_morning", "cairn-scale")).json();
    expect(again).toMatchObject({ result: "pass", reading: "160.2 lb", weight_lb: 160.2 });
  });

  test("an accepted weigh-in with an unreadable number still passes, with weight_lb null", async () => {
    const path = process.env.HYGIENE_GATE_STATE!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...raw, weighInStartsAt: new Date(at(DAY, "05:00")).toISOString() }));
    resetGateCache();
    verdicts.push({ kind: "weight", confidence: 0.9, reason: "scale", reading: "11 st 6 lb" });
    const body = await (await submit("weight_morning", "stone-scale")).json();
    expect(body).toMatchObject({ result: "pass", reading: "11 st 6 lb", weight_lb: null });
  });

  test("non-weight and failed proofs carry no weight fields", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
    const teeth = await (await submit("teeth_morning", "plain-teeth")).json();
    expect(teeth.result).toBe("pass");
    expect(teeth).not.toHaveProperty("weight_lb");
    expect(teeth).not.toHaveProperty("reading");
    const early = await (await submit("weight_morning", "early-scale")).json();
    expect(early.result).toBe("fail");
    expect(early).not.toHaveProperty("weight_lb");
  });

  test("the stated kind limits which requirement a photo can fill", async () => {
    const notDue = await (await submit("teeth_night", "early")).json();
    expect(notDue).toMatchObject({ result: "fail", verdict: "not_due", slot: null });
    expect(classified).toBe(0);
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "brushing" });
    const wrong = await (await submit("shower", "is-teeth")).json();
    expect(wrong).toMatchObject({ result: "fail", verdict: "rejected" });
    expect(gateStatus().state).toBe("armed");
  });

  test("bad requests and the kill switch", async () => {
    expect((await api("/proofs", { method: "POST", token: "phone", body: "{" })).status).toBe(400);
    expect((await submit("selfie", "x")).status).toBe(400);
    expect((await api("/proofs", { method: "POST", token: "phone", body: JSON.stringify({ kind: "shower" }) })).status).toBe(400);
    expect((await api("/photos?from=yesterday", { token: "phone" })).status).toBe(400);
    await writeFile(process.env.HYGIENE_GATE_DISABLED_FILE!, "");
    expect((await submit("shower", "x")).status).toBe(503);
  });

  test("requests through Tailscale Serve reach only the hygiene API", async () => {
    const via = { "x-forwarded-for": "100.64.0.5" };
    expect((await api("/status", { token: "phone", headers: via })).status).toBe(200);
    for (const [path, method] of [
      ["/hygiene/status", "GET"],
      ["/hygiene/debt/x/resolve", "POST"],
      ["/hygiene/debt/x/revise", "POST"],
      ["/hygiene/gate", "POST"],
      ["/v1/responses", "POST"],
      ["/accounts", "GET"],
    ])
      expect((await handleRequest(new Request(`http://localhost${path}`, { method, headers: via, body: method === "POST" ? "{}" : undefined }))).status).toBe(403);
    expect((await handleRequest(new Request("http://localhost/hygiene/status", { headers: { "tailscale-user-login": "alex@" } }))).status).toBe(403);
  });
});

/**
 * Oct 21: Today on Forge ran its own gate. Proofs reached only arch's, so
 * Forge's locked Today all afternoon and answered Alex with the lock text. Now
 * one machine holds the gate and the other follows it (HYGIENE_GATE_REMOTE).
 * The authority here is a real server running this same proxy on its own state.
 */
describe("following another machine's gate", () => {
  let authority: ReturnType<typeof Bun.serve> | null = null;
  let authorityState = "";
  let followerState = "";
  const remoteBefore = process.env.HYGIENE_GATE_REMOTE;

  /** Run the authority's side as its own proxy: its state, no remote. */
  async function asAuthority<T>(work: () => Promise<T>): Promise<T> {
    const env = { remote: process.env.HYGIENE_GATE_REMOTE, state: process.env.HYGIENE_GATE_STATE, directory: process.env.PROXY_STATE_DIR, machine: process.env.HYGIENE_GATE_MACHINE };
    delete process.env.HYGIENE_GATE_REMOTE;
    process.env.HYGIENE_GATE_MACHINE = "forge";
    process.env.HYGIENE_GATE_STATE = authorityState;
    process.env.PROXY_STATE_DIR = join(dirname(authorityState), "authority-proxy");
    try {
      return await work();
    } finally {
      process.env.HYGIENE_GATE_REMOTE = env.remote;
      process.env.HYGIENE_GATE_STATE = env.state;
      process.env.PROXY_STATE_DIR = env.directory;
      if (env.machine === undefined) delete process.env.HYGIENE_GATE_MACHINE;
      else process.env.HYGIENE_GATE_MACHINE = env.machine;
    }
  }

  const serve = () => {
    authority = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => asAuthority(() => handleRequest(req)) });
    process.env.HYGIENE_GATE_REMOTE = `http://127.0.0.1:${authority.port}/`;
  };
  /** The follower's own gate file, with nothing due before startsAt. */
  const writeFollower = async (startsAt: number) => {
    const own = JSON.parse(await readFile(authorityState, "utf8"));
    await writeFile(followerState, JSON.stringify({ ...own, startsAt: new Date(startsAt).toISOString() }));
  };

  beforeEach(async () => {
    authorityState = process.env.HYGIENE_GATE_STATE!;
    // The follower's own file says nothing is due for a month: any lock it shows came from the authority.
    followerState = join(directory, `state-${run}`, "follower.json");
    await writeFollower(at(DAY, "05:00") + 30 * 86_400_000);
    serve();
    process.env.HYGIENE_GATE_STATE = followerState;
    setAuthenticator(async (token) => (token === "phone" ? { id: "phone-1", name: "iphone", role: "phone" } : null));
  });
  const stop = () => {
    authority?.stop(true);
    authority = null;
  };
  afterEach(stop);
  afterAll(() => {
    if (remoteBefore === undefined) delete process.env.HYGIENE_GATE_REMOTE;
    else process.env.HYGIENE_GATE_REMOTE = remoteBefore;
    setAuthenticator();
  });

  const reply = async (input: ResponseInputItem[]) => {
    const response = await handleRequest(
      new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify(request(input)) }),
    );
    const body = (await response.json()) as { output: Array<{ content?: Array<{ text?: string }> }> };
    return body.output.flatMap((o) => o.content ?? []).map((c) => c.text).join("");
  };

  test("the authority's lock and bypass apply here, and only its state changes", async () => {
    expect(await reply([env, user("hi")])).toContain("gate armed: morning teeth photo");
    expect(await reply([env, user("hi"), assistant("locked"), user(BYPASS)])).toContain("bypass #1");
    expect(JSON.parse(await readFile(authorityState, "utf8")).bypass.count).toBe(1);
    expect(JSON.parse(await readFile(followerState, "utf8")).bypass.count).toBe(0);
    // Bypassed: the turn reaches the model.
    expect(await reply([env, user("hi"), assistant("locked"), user(BYPASS), assistant("open"), user("now answer")])).toBe("model-ran");
  });

  test("a follower chat's held message is woken on the follower's machine", async () => {
    const machineBefore = process.env.HYGIENE_GATE_MACHINE;
    process.env.HYGIENE_GATE_MACHINE = "arch";
    try {
      expect(await reply([env, user("arch link")])).toContain("gate armed");
      await asAuthority(async () => {
        process.env.HYGIENE_GATE_MACHINE = "forge";
        verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" });
        const proof = await submitProof({ mediaType: "image/jpeg", bytes: Buffer.from("cairn-teeth") }, { kind: "teeth", slot: (s) => s.endsWith("/morning-teeth") });
        expect(proof.result).toBe("pass");
        await flushWakes();
      });
    } finally {
      if (machineBefore === undefined) delete process.env.HYGIENE_GATE_MACHINE;
      else process.env.HYGIENE_GATE_MACHINE = machineBefore;
    }
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ thread: THREAD, machine: "arch" });
    expect(wakes[0].text).toContain("arch link");
  });

  test("status, rulings and Cairn's API are the authority's", async () => {
    const status = await (await handleRequest(new Request("http://localhost/hygiene/status"))).json();
    expect(status).toMatchObject({ state: "armed", startsAt: new Date(at(DAY, "05:00")).toISOString() });
    expect((await handleRequest(new Request("http://localhost/hygiene/debt/nope/resolve", { method: "POST", body: "{}" }))).status).toBe(404);
    // Cairn reaches the follower through Tailscale Serve; the authority checks the token.
    const cairn = (token?: string) =>
      handleRequest(
        new Request("http://localhost/hygiene/api/v1/status", {
          headers: { "x-forwarded-for": "100.64.0.5", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        }),
      );
    expect(await (await cairn("phone")).json()).toMatchObject({ state: "armed", today: DAY });
    expect((await cairn()).status).toBe(401);
    // Its whole state is for local callers only.
    expect(
      (await handleRequest(new Request("http://localhost/hygiene/state", { headers: { "x-forwarded-for": "100.64.0.5" } }))).status,
    ).toBe(403);
  });

  test("the router's GPT question is answered by the authority too", async () => {
    const ask = await handleRequest(
      new Request("http://localhost/hygiene/gate", { method: "POST", body: JSON.stringify(request([env, user("hi")])) }),
    );
    const answer = (await ask.json()) as { action: string; response: { output: Array<{ content: Array<{ text: string }> }> } };
    expect(answer.action).toBe("respond");
    expect(answer.response.output[0].content[0].text).toContain("gate armed: morning teeth photo");
  });

  test("the authority's whole state is readable by a local caller", async () => {
    const reply = await handleRequest(new Request("http://localhost/hygiene/state"));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ startsAt: new Date(at(DAY, "05:00")).toISOString() });
  });

  test("a follower asked by another follower refuses instead of looping", async () => {
    const hop = { "x-hygiene-gate-hop": "1" };
    const gate = await handleRequest(
      new Request("http://localhost/hygiene/gate", { method: "POST", headers: hop, body: JSON.stringify(request([env, user("hi")])) }),
    );
    expect(gate.status).toBe(508);
    expect((await handleRequest(new Request("http://localhost/hygiene/status", { headers: hop }))).status).toBe(508);
  });

  test("with the authority unreachable, photos and a not-checked note reach the model", async () => {
    // Even an armed gate file here must not lock: this machine follows, it doesn't decide.
    await writeFollower(at(DAY, "05:00"));
    stop();
    expect(await reply([env, user("hi")])).toBe("model-ran");
    expect((await handleRequest(new Request("http://localhost/hygiene/status"))).status).toBe(502);

    const bytes = Buffer.from("unchecked-bathroom").toString("base64");
    const withPhoto = [env, user("hi"), assistant("model-ran"), user("look", { photo: "unchecked-bathroom" })];
    expect(await reply(withPhoto)).toBe("model-ran");
    let inputs = await readFile(join(directory, "inputs"), "utf8");
    expect(inputs).toContain("photo not checked yet (gate unreachable)");
    expect(inputs).toContain(bytes);

    // Forge is back; the previously delivered photo remains visible in history.
    serve();
    await writeFile(authorityState, JSON.stringify({ ...JSON.parse(await readFile(authorityState, "utf8")), startsAt: new Date(at(DAY, "05:00") + 30 * 86_400_000).toISOString() }));
    expect(await reply([...withPhoto, assistant("model-ran"), user("and now?")])).toBe("model-ran");
    inputs = await readFile(join(directory, "inputs"), "utf8");
    expect(inputs).toContain(bytes);
  });

  /** What the model got since `before` bytes into the fake Claude's log. */
  const sentSince = async (before: number) =>
    existsSync(join(directory, "inputs")) ? (await readFile(join(directory, "inputs"), "utf8")).slice(before) : "";
  const logLength = async () =>
    existsSync(join(directory, "inputs")) ? (await readFile(join(directory, "inputs"), "utf8")).length : 0;

  test("a proof the authority accepted stays withheld from the cached verdict during an outage", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const proof = [env, user("hi"), assistant("locked"), user({ photo: "accepted-teeth" })];
    expect(await reply(proof)).toBe("model-ran");
    stop();
    const before = await logLength();
    expect(await reply([...proof, assistant("model-ran"), user("later")])).toBe("model-ran");
    const sent = await sentSince(before);
    expect(sent).toContain("later");
    expect(sent).not.toContain(Buffer.from("accepted-teeth").toString("base64"));
  });

  test("a photo by URL is delivered while the authority is down", async () => {
    stop();
    const before = await logLength();
    const byUrl = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "see this" },
        { type: "input_image", image_url: "http://127.0.0.1:9/bathroom.jpg", detail: "auto" },
      ],
    } as ResponseInputItem;
    const decision = await decide(request([env, byUrl]));
    expect(decision.action).toBe("forward");
    const sent = JSON.stringify(decision);
    expect(sent).toContain("photo not checked yet (gate unreachable)");
    expect(sent).toContain("bathroom.jpg");
  });

  test("a photo is delivered even when the unchecked list cannot be saved", async () => {
    stop();
    // The state directory is under a regular file: every save fails.
    process.env.PROXY_STATE_DIR = join(directory, "inputs-blocker", "state");
    await writeFile(join(directory, "inputs-blocker"), "not a directory");
    // The gate's own decision (the rest of the proxy needs that directory too).
    const decision = await decide(request([env, user("look", { photo: "unsaved-bathroom" })]));
    expect(decision.action).toBe("forward");
    const forwarded = JSON.stringify(decision.action === "forward" ? decision.request : null);
    expect(forwarded).toContain("look");
    expect(forwarded).toContain(Buffer.from("unsaved-bathroom").toString("base64"));
  });
  test("an unreadable unchecked store does not hide images", async () => {
    await writeFile(join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json"), "broken json");
    stop();
    const decision = await decide(request([env, user("see", { photo: "unreadable" })]));
    expect(decision.action).toBe("forward");
    expect(JSON.stringify(decision)).toContain(photo("unreadable"));
  });

  test("recovery checks durable queued photos once and never withholds delivered history", async () => {
    stop();
    const history = [env, user("see", { photo: "offline-proof" })];
    await decide(request(history));
    const stored = await readFile(join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json"), "utf8");
    expect(stored).toContain(photo("offline-proof"));
    serve();
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!);
    for (let i = 0; i < 2; i++) {
      const decision = await decide(request([...history, assistant("seen"), user("later")]));
      expect(decision.action).toBe("forward");
      expect(JSON.stringify(decision)).toContain(photo("offline-proof"));
    }
    expect(classified).toBe(1);
    const state = JSON.parse(await readFile(authorityState, "utf8"));
    expect(state.images).toHaveLength(1);
    expect(state.images[0].verdict).toBe("accepted");
  });

  test("a reachable authority still withholds a newly judged proof", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const decision = await decide(request([env, user({ photo: "online-proof" })]));
    expect(decision.action).toBe("forward");
    expect(JSON.stringify(decision)).not.toContain(photo("online-proof"));
  });

  test("an unreadable authority state delivers the photo and queues it at the follower", async () => {
    await writeFile(authorityState, "broken JSON");
    const decision = await decide(request([env, user("look", { photo: "state-unreadable" })]));
    expect(decision.action).toBe("forward");
    expect(JSON.stringify(decision)).toContain(photo("state-unreadable"));
    expect(JSON.stringify(decision)).toContain("photo not checked yet (gate unreachable)");
    expect(await readFile(join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json"), "utf8")).toContain(photo("state-unreadable"));
  });

  test("a restart retries persisted bytes and a lost acknowledgement cannot count them twice", async () => {
    stop();
    await decide(request([env, user({ photo: "restart-proof" })]));
    const path = join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json");
    const queued = await readFile(path, "utf8");
    serve();
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const child = Bun.spawn([process.execPath, "-e", `import { retryUnchecked } from "./src/hygiene-remote.ts"; await retryUnchecked(process.argv[1], process.argv[2]);`, process.env.HYGIENE_GATE_REMOTE!, path], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual({});
    // The authority committed, but imagine the follower died before recording its ACK.
    await writeFile(path, queued);
    await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!);
    expect(classified).toBe(1);
    expect(JSON.parse(await readFile(authorityState, "utf8")).images).toHaveLength(1);
  });

  test("classifier failure retains the queue for recovery", async () => {
    stop();
    await decide(request([env, user({ photo: "checker-down" })]));
    serve();
    classifierDown = true;
    await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!);
    const path = join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json");
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).pending)).toHaveLength(1);
    classifierDown = false;
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!, path, Date.now() + 30_001);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual({});
  });

  test("legacy unchecked hashes are delivered and their bytes are queued when seen again", async () => {
    const key = new Bun.CryptoHasher("sha256").update(Buffer.from("legacy-proof")).digest("hex");
    const path = join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json");
    await writeFile(path, JSON.stringify({ keys: [key] }));
    stop();
    const decision = await decide(request([env, user({ photo: "legacy-proof" })]));
    expect(JSON.stringify(decision)).toContain(photo("legacy-proof"));
    expect(JSON.parse(await readFile(path, "utf8")).pending[key]?.url).toBe(photo("legacy-proof"));
  });

  test("chat delivery does not drain the recovery queue inline", async () => {
    stop();
    await decide(request([env, user({ photo: "slow-check" })]));
    let rechecks = 0;
    authority = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
      if (new URL(req.url).pathname === "/hygiene/recheck") {
        rechecks++;
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ action: "forward" });
    } });
    process.env.HYGIENE_GATE_REMOTE = `http://127.0.0.1:${authority.port}`;
    expect((await decide(request([env, user("continue")]))).action).toBe("forward");
    expect(rechecks).toBe(0);
  });

  test("a user quoting the outage note does not override an authority verdict", async () => {
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    const decision = await decide(request([env, user("[hygiene-gate: photo not checked yet (gate unreachable)]", { photo: "quoted-note" })]));
    expect(decision.action).toBe("forward");
    expect(JSON.stringify(decision)).not.toContain(photo("quoted-note"));
  });

  test("a failed write to an existing store retains pending photos in memory", async () => {
    const path = join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json");
    await writeFile(path, JSON.stringify({ keys: [] }));
    const blocker = `${path}.${process.pid}.tmp`;
    await mkdir(blocker);
    stop();
    await decide(request([env, user({ photo: "write-failed" })]));
    await rm(blocker, { recursive: true });
    serve();
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!);
    expect(classified).toBe(1);
  });

  test("backdated receipts cannot credit an obsolete slot or make stale EXIF fresh", async () => {
    clock = at("2026-10-11", "06:00");
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    exif["backdated"] = at(DAY, "06:00");
    const response = await asAuthority(() => handleRequest(new Request("http://localhost/hygiene/recheck", {
      method: "POST", body: JSON.stringify({ url: photo("backdated"), at: at(DAY, "06:00") }),
    })));
    expect(response.ok).toBe(true);
    const state = JSON.parse(await readFile(authorityState, "utf8"));
    expect(Object.keys(state.filled)).toHaveLength(0);
    expect(state.images[0].verdict).toBe("stale");
    expect(state.images[0].at).toBe(new Date(clock).toISOString());
  });

  test("history photos remain delivered but only trailing user photos are rechecked", async () => {
    stop();
    const decision = await decide(request([env, user({ photo: "old-history" }), assistant("seen"), user({ photo: "fresh-outage" })]));
    expect(JSON.stringify(decision)).toContain(photo("old-history"));
    const store = JSON.parse(await readFile(join(process.env.PROXY_STATE_DIR!, "hygiene-unchecked.json"), "utf8"));
    expect(Object.values(store.pending).map((p: any) => p.url)).toEqual([photo("fresh-outage")]);
  });

  test("configured proxy auth is sent on queued checks and gate decisions", async () => {
    stop();
    await decide(request([env, user({ photo: "authenticated" })]));
    serve();
    const previous = process.env.PROXY_API_KEY;
    process.env.PROXY_API_KEY = "test-only-proxy-key";
    try {
      const unauthenticated = await asAuthority(() => handleRequest(new Request("http://localhost/hygiene/recheck", {
        method: "POST", body: JSON.stringify({ url: photo("authenticated"), at: clock }),
      })));
      expect(unauthenticated.status).toBe(401);
      expect((await decide(request([env, user("still locked")]))).action).toBe("respond");
      verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
      await retryUnchecked(process.env.HYGIENE_GATE_REMOTE!);
      expect(classified).toBe(1);
      expect((await decide(request([env, user("now answer")]))).action).toBe("forward");
    } finally {
      if (previous === undefined) delete process.env.PROXY_API_KEY;
      else process.env.PROXY_API_KEY = previous;
    }
  });

  test("a forged receipt cannot choose a past slot even without EXIF", async () => {
    clock = at("2026-10-11", "06:00");
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "ok" });
    await asAuthority(() => handleRequest(new Request("http://localhost/hygiene/recheck", {
      method: "POST", body: JSON.stringify({ url: photo("forged-receipt"), at: at(DAY, "06:00") }),
    })));
    const state = JSON.parse(await readFile(authorityState, "utf8"));
    expect(state.images[0].at).toBe(new Date(clock).toISOString());
    expect(state.images[0].slot).not.toContain(DAY);
    expect(state.images[0].receivedAt).toBeUndefined();
  });

});

describe("BYPASS phrase (Alex, 2026-11-04: three random words, new every lock)", () => {
  const held = () => {
    const path = join(dirname(process.env.HYGIENE_GATE_STATE!), "hygiene-held.json");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };

  test("the lock shows the phrase; bare, wrong and stale phrases are refused; the right one opens; the next lock rotates", async () => {
    clock = at(DAY, "06:00");
    const lock = text(await decide(request([env, user("hi")])))!;
    expect(lock).toBe("🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS maple river otter.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).");
    // The same lock keeps its words.
    expect(text(await decide(request([env, user("hi"), assistant(lock), user("again")])))).toBe(lock);

    const bare = text(await decide(request([env, user("BYPASS")])))!;
    expect(bare).toBe(`🔑 BYPASS needs this lock's three words.\n${lock}`);
    expect(text(await decide(request([env, user("Bypass")])))).toBe(bare);
    for (const wrong of ["BYPASS cedar comet tulip", "BYPASS maple river", "BYPASS maple river otter now", "bypass river maple otter"])
      expect(text(await decide(request([env, user(wrong)])))).toBe(`🔑 That isn't this lock's BYPASS phrase.\n${lock}`);
    expect(gateStatus()).toMatchObject({ state: "armed", bypass: { count: 0 } });
    // Attempts answer at once; they are not held for the chat like a message.
    expect(held()).not.toContain("BYPASS");

    // Case, spacing and a trailing full stop don't matter; Today's sent-at stamp is stripped first.
    expect(text(await decide(request([env, user("[06:01 PDT Thu Oct 8]   bypass  Maple RIVER otter.")])))).toBe(
      "🚪 bypass #1: gate open until 07:00. Your next turn will ask why.",
    );
    expect(gateStatus()).toMatchObject({ state: "bypassed", bypass: { count: 1 } });

    // The bypass ends with the photo still due: the gate arms again with new words.
    clock = at(DAY, "07:01");
    const next = text(await decide(request([env, user("hi")])))!;
    expect(next).toBe("🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS cedar comet tulip.\nDoing it later today? Reply LATER 18:30 (any time before midnight; not a bypass).");
    expect(text(await decide(request([env, user("BYPASS maple river otter")])))).toBe(`🔑 That isn't this lock's BYPASS phrase.\n${next}`);
    expect(text(await decide(request([env, user("BYPASS cedar comet tulip")])))).toStartWith("🚪 bypass #2");
    expect(gateStatus().bypass.count).toBe(2);
  });

  test("a lock that clears and arms again later never reuses its words", async () => {
    clock = at(DAY, "06:00");
    expect(text(await decide(request([env, user("hi")])))).toContain("BYPASS maple river otter.");
    verdicts.push({ kind: "teeth", confidence: 0.95, reason: "brushing" } as Verdict);
    clock = at(DAY, "06:05");
    exif.fresh = clock - 60_000;
    expect((await decide(request([env, user("done", { photo: "fresh" })]))).action).toBe("forward");
    // That night: a new lock, and the morning's words are refused.
    clock = at("2026-10-09", "00:30");
    const night = text(await decide(request([env, user("hi")])))!;
    expect(night).toContain("or reply BYPASS cedar comet tulip.");
    expect(text(await decide(request([env, user("BYPASS maple river otter")])))).toStartWith("🔑 That isn't this lock's BYPASS phrase.");
  });

  test("ordinary text that starts with 'bypass' is a message, not an attempt", async () => {
    clock = at(DAY, "06:00");
    const reply = text(await decide(request([env, user("bypass the cache in foo.ts")])))!;
    expect(reply).toStartWith("🪥 gate armed");
    expect(held()).toContain("bypass the cache in foo.ts");
    expect(text(await decide(request([env, user(BYPASS)])))).toStartWith("🚪 bypass #1");
    // With a bypass open, or nothing locked, text that only looks like an attempt goes to the model.
    for (const message of ["BYPASS phrase is annoying, change it", "bypass cookie"])
      expect((await decide(request([env, user(message)]))).action).toBe("forward");
    expect(text(await decide(request([env, user("BYPASS")])))).toBe("🚪 bypass already open until 07:00.");
    expect(text(await decide(request([env, user(BYPASS)])))).toBe("🚪 bypass already open until 07:00.");
  });

  test("on a clear gate only a bare BYPASS or a full phrase is answered; anything else goes to the model", async () => {
    clock = at(DAY, "04:00");
    for (const message of ["bypass the cache in foo.ts", "BYPASS phrase is annoying, change it", "bypass cookie"])
      expect((await decide(request([env, user(message)]))).action).toBe("forward");
    for (const attempt of ["BYPASS", "BYPASS cedar comet tulip"])
      expect(text(await decide(request([env, user(attempt)])))).toBe("✅ gate is already clear; no bypass used.");
    expect(gateStatus().bypass.count).toBe(0);
  });

  test("a typo'd phrase is refused as an attempt, not held as a message", async () => {
    clock = at(DAY, "06:00");
    const lock = text(await decide(request([env, user("hi")])))!;
    expect(text(await decide(request([env, user("Bypass mapel river otter")])))).toBe(`🔑 That isn't this lock's BYPASS phrase.\n${lock}`);
    expect(held()).not.toContain("mapel");
  });

  test("a DELAY opens the gate, so the relock after it has new words even with no turn in between", async () => {
    clock = at(DAY, "07:45");
    expect(text(await decide(request([env, user("hi")])))).toContain("BYPASS maple river otter.");
    expect(text(await decide(request([env, user("DELAY")])))).toStartWith("⏰ delay");
    clock = at(DAY, "09:46");
    expect(text(await decide(request([env, user("back")])))).toContain("BYPASS cedar comet tulip.");
  });
});
