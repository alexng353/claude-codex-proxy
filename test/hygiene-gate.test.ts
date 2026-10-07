import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { zonedTime } from "../src/hygiene";
import { gateRequest, gateStatus, resetGateCache, setGateDeps } from "../src/hygiene-gate";
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
  exif = {};
  hashes = {};
  setGateDeps({
    now: () => clock,
    baseUrl: "http://127.0.0.1:3456",
    classify: async () => {
      classified++;
      if (classifierDown) throw new Error("down");
      return verdicts.shift() ?? { kind: "none", confidence: 0.9, reason: "no person" };
    },
    dhash: async (bytes) => hashes[bytes.toString("utf8")] ?? null,
    captureTime: async (bytes) => exif[bytes.toString("utf8")] ?? null,
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
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const request = (input: ResponseInputItem[], trigger = "composer", extra: Partial<ResponsesRequest> = {}): ResponsesRequest =>
  ({ model: "opus", prompt_cache_key: THREAD, client_metadata: meta(trigger), input, ...extra }) as ResponsesRequest;

async function decide(req: ResponsesRequest) {
  return gateRequest(req);
}
const text = (d: Awaited<ReturnType<typeof gateRequest>>) => (d.action === "respond" ? d.text : null);

describe("gate decisions", () => {
  test("before 05:00 nothing is locked; at 05:00 the first human turn is", async () => {
    clock = at(DAY, "04:59");
    expect((await decide(request([env, user("hi")]))).action).toBe("forward");
    clock = at(DAY, "05:00");
    expect(text(await decide(request([env, user("hi")])))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS.",
    );
  });

  test("exempt turns and continuations pass a locked gate", async () => {
    expect((await decide(request([env, user("<heartbeat>\n<automation_id>x</automation_id>")], "automation_heartbeat_scheduled"))).action).toBe("forward");
    expect((await decide(request([env, user("prompt from another chat")], "app_tool_send_message"))).action).toBe("forward");
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
    const bypass = await decide(request([env, user("BYPASS")]));
    expect(text(bypass)).toBe("🚪 bypass #1: gate open until 07:00. Your next turn will ask why.");
    expect(gateStatus()).toMatchObject({ state: "bypassed", bypass: { count: 1 }, armed: false });
    clock = at(DAY, "06:05");
    const history = [env, user("BYPASS"), assistant("🚪 bypass #1"), user("now fix the bug")];
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
    expect(text(await decide(request([env, user("BYPASS")])))).toBe("✅ gate is already clear; no bypass used.");
    expect(gateStatus().bypass.count).toBe(0);
  });

  test("an unjustified ruling sets a penance that the classifier must match", async () => {
    await decide(request([env, user("BYPASS")]));
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
    await decide(request([env, user("BYPASS")]));
    const ruling = await handleRequest(
      new Request("http://localhost/hygiene/debt/2026-10-08-1/resolve", { method: "POST", body: JSON.stringify({ verdict: "justified", reason: "fire alarm" }) }),
    );
    expect(ruling.status).toBe(200);
    expect(gateStatus().openDebts).toEqual([]);
    clock = at(DAY, "06:10");
    const next = await decide(request([env, user("BYPASS"), assistant("ok"), user("go")]));
    expect(JSON.stringify(next)).not.toContain("hygiene-gate-note");
  });

  test("accepted photos are archived privately; the state file holds no image data", async () => {
    await decide(request([env, user("not a proof", { photo: "rejected-pixels" })]));
    verdicts.push({ kind: "teeth", confidence: 0.9, reason: "ok" });
    await decide(request([env, user({ photo: "secret-pixels" })]));
    await decide(request([env, user("BYPASS")]));
    const raw = readFileSync(process.env.HYGIENE_GATE_STATE!, "utf8");
    expect(raw).not.toContain(photo("secret-pixels"));
    expect(raw).not.toContain(Buffer.from("secret-pixels").toString("base64"));
    const state = JSON.parse(raw);
    const accepted = state.images.find((i: { verdict: string }) => i.verdict === "accepted");
    expect(accepted).toMatchObject({ slot: `${DAY}/morning-teeth`, kind: "teeth" });
    expect(Object.keys(accepted).sort()).toEqual(["at", "dhash", "file", "kind", "reason", "sha256", "slot", "source", "verdict"]);
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
      "DELAY only postpones the morning teeth photo (05:00 to 12:00). For anything else, send the photo or reply BYPASS.",
    );
    clock = at("2026-10-09", "00:30");
    expect(text(await decide(request([env, user("DELAY")])))).toStartWith("DELAY only postpones the morning teeth photo");
    // 06:00 with last night's teeth still overdue: DELAY can't open that lock.
    clock = at("2026-10-09", "06:00");
    expect(text(await decide(request([env, user("DELAY")])))).toStartWith("DELAY only postpones the morning teeth photo");
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
      "DELAY was already used this morning. Send the teeth photo, or reply BYPASS.",
    );
    expect(gateStatus()).toMatchObject({ state: "armed", delay: { active: false, count: 1 } });
    // BYPASS still works after an expired delay and counts as a bypass.
    expect(text(await decide(request([env, user("BYPASS")])))).toStartWith("🚪 bypass #1");
    expect(gateStatus()).toMatchObject({ bypass: { count: 1 }, delay: { count: 1 } });
  });

  test("every turn in the window carries a byte-stable nag note", async () => {
    await morningLocked();
    await decide(request([env, user("DELAY")]));
    const first = [env, user("DELAY"), assistant("⏰"), user("summarise the agenda")];
    const one = await decide(request(first));
    const nag = "Alex used DELAY to postpone his morning teeth photo until 09:45.";
    const firstInput = one.action === "forward" ? (one.request.input as ResponseInputItem[]) : [];
    expect(JSON.stringify(firstInput[3])).toContain(nag);
    expect(JSON.stringify(firstInput[3])).toContain("End your final reply to this message with one short line asking him to send the teeth photo.");
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
