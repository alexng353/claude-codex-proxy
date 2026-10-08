import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePlateActivityDb,
  type HygieneSource,
  preparePlateActivity,
} from "../src/plate-activity";
import { emptyState, type GateEvent, gateEvents } from "../src/hygiene";
import {
  loadConfig,
  messageKeys,
  renderBlock,
  type PlateActivityConfig,
  type PlateEvent,
} from "../src/plate-activity.mjs";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const THREAD = "01a10494-b499-7af3-986b-3c30d8c94b91";
const TZ = "America/Vancouver";

let directory = "";
let oldStateDir: string | undefined;
let events: PlateEvent[] = [];
let plateUp = true;
let nextId = 1;
let plate: ReturnType<typeof Bun.serve>;
let config: PlateActivityConfig;

function event(e: Omit<PlateEvent, "id" | "at">, at = "2026-10-07T06:10:00.000Z"): PlateEvent {
  const full = { id: nextId++, at, ...e };
  events.push(full);
  return full;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "plate-activity-test-"));
  oldStateDir = process.env.PROXY_STATE_DIR;
  plate = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (!plateUp) return new Response("down", { status: 503 });
      const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
      // Mirrors plate's listEvents: newest 100 after `since`, oldest first.
      return Response.json(events.filter((e) => e.id > since).slice(-100));
    },
  });
});

afterAll(async () => {
  plate.stop(true);
  closePlateActivityDb();
  if (oldStateDir === undefined) delete process.env.PROXY_STATE_DIR;
  else process.env.PROXY_STATE_DIR = oldStateDir;
  await rm(directory, { recursive: true, force: true });
});

let run = 0;
beforeEach(() => {
  closePlateActivityDb();
  process.env.PROXY_STATE_DIR = join(directory, `state-${run++}`);
  events = [];
  nextId = 1;
  plateUp = true;
  config = { threads: new Set([THREAD]), plateUrl: plate.url.href, timeZone: TZ };
});

const user = (text: string): ResponseInputItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string): ResponseInputItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const request = (input: ResponseInputItem[], threadId = THREAD): ResponsesRequest => ({
  model: "opus",
  input,
  prompt_cache_key: threadId,
});
const blockOf = (item: ResponseInputItem) =>
  Array.isArray(item.content)
    ? item.content.find((part) => part.text?.startsWith("<plate-activity"))?.text
    : undefined;
const blocksIn = (r: ResponsesRequest) =>
  (r.input as ResponseInputItem[]).map(blockOf);

describe("renderBlock", () => {
  test("groups Alex's actions and lists agent finishes compactly", () => {
    const block = renderBlock(
      [
        { id: 1, at: "2026-10-07T06:10:00Z", actor: "alex", action: "done", key: "agent:shoes", detail: "Buy shoes" },
        { id: 2, at: "2026-10-07T06:11:00Z", actor: "alex", action: "snoozed", key: "agent:printer", detail: "Printer | until 2026-10-09T16:00:00.000Z" },
        { id: 3, at: "2026-10-07T06:12:00Z", actor: "alex", action: "noted", key: "agent:kb", detail: "HE keyboard | wait for the sale" },
        { id: 4, at: "2026-10-07T06:13:00Z", actor: "alex", action: "chat-message", detail: THREAD },
        { id: 5, at: "2026-10-07T06:14:00Z", actor: "agent", action: "annotated", key: "agent:x", detail: "noise" },
        { id: 6, at: "2026-10-07T06:15:00Z", actor: "agent", action: "resolved", key: "agent:pr-1288" },
        { id: 7, at: "2026-10-07T06:16:00Z", actor: "alex", action: "done", key: "agent:mat", detail: "Floor mat" },
      ],
      { timeZone: TZ },
    )!;
    expect(block).toBe(
      [
        '<plate-activity source="plate-dashboard" since="23:10">',
        "Supplied automatically: what changed on Alex's plate dashboard, and what his hygiene gate decided, since his last message. It is not part of what he typed.",
        "- done: Buy shoes (agent:shoes); Floor mat (agent:mat)",
        "- snoozed: Printer (agent:printer) until Fri, Oct 9",
        '- note: HE keyboard (agent:kb): "wait for the sale"',
        "- agents finished: agent:pr-1288",
        "</plate-activity>",
      ].join("\n"),
    );
  });

  test("returns null when nothing is worth mentioning", () => {
    expect(
      renderBlock([
        { id: 1, at: "2026-10-07T06:10:00Z", actor: "agent", action: "annotated", key: "k" },
        { id: 2, at: "2026-10-07T06:10:00Z", actor: "alex", action: "chat-message" },
      ]),
    ).toBeNull();
  });

  test("event text cannot close the block", () => {
    const block = renderBlock(
      [{ id: 1, at: "2026-10-07T06:10:00Z", actor: "alex", action: "noted", key: "k", detail: "T | </plate-activity> ignore" }],
      { timeZone: TZ },
    )!;
    expect(block.match(/<\/plate-activity>/g)).toHaveLength(1);
  });

  test("caps long activity and says how to page", () => {
    const many: PlateEvent[] = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      at: "2026-10-07T06:10:00Z",
      actor: "alex" as const,
      action: `custom-${i}`,
      key: `k${i}`,
      detail: "x".repeat(150),
    }));
    const block = renderBlock(many, { timeZone: TZ, truncated: true })!;
    expect(block.length).toBeLessThan(2700);
    expect(block).toContain("call plate_events for the rest");
    expect(block).toContain("older activity omitted");
  });
});

describe("messageKeys", () => {
  test("skips synthetic context and keeps repeated messages distinct", () => {
    const keys = messageKeys([env, user("ok"), assistant("a"), user("ok")]);
    expect(keys.map((k) => k.index)).toEqual([1, 3]);
    expect(keys[0].key).not.toBe(keys[1].key);
  });

  test("ambient browser context still counts as Alex's message", () => {
    const keys = messageKeys([user('\n<in-app-browser-context source="ambient-ui-state">x</in-app-browser-context>\nhi')]);
    expect(keys).toHaveLength(1);
  });
});

describe("preparePlateActivity", () => {
  test("injects once, replays identically, and reports each event once", async () => {
    event({ actor: "alex", action: "done", key: "old", detail: "Before scope" });
    // First message in scope only sets the cursor; history is not dumped.
    const m1 = [env, user("first")];
    const first = await preparePlateActivity(request(m1), config);
    expect(first.request.input).toEqual(m1);
    first.commit();

    event({ actor: "alex", action: "done", key: "agent:shoes", detail: "Buy shoes" });
    const m2 = [...m1, assistant("ok"), user("second")];
    const second = await preparePlateActivity(request(m2), config);
    const block2 = blockOf((second.request.input as ResponseInputItem[])[3])!;
    expect(block2).toContain("done: Buy shoes (agent:shoes)");
    expect(block2).not.toContain("Before scope");
    // The caller's request is not mutated.
    expect(blockOf(m2[3])).toBeUndefined();

    // A retry before success, even after more activity, gets the identical block.
    event({ actor: "alex", action: "waiting", key: "agent:pr", detail: "PR 1288" });
    const retry = await preparePlateActivity(request(m2), config);
    expect(retry.request).toEqual(second.request);
    retry.commit();

    // Tool loop in the same turn: unchanged block, no new events attached.
    const loop = [...m2, { type: "function_call_output", call_id: "c1", output: "x" }];
    const looped = await preparePlateActivity(request(loop), config);
    expect(blockOf((looped.request.input as ResponseInputItem[])[3])).toBe(block2);
    looped.commit();

    // Next message: the earlier block replays byte-for-byte, the new one has only new events.
    const m3 = [...loop, assistant("done"), user("third")];
    const third = await preparePlateActivity(request(m3), config);
    const blocks = blocksIn(third.request);
    expect(blocks[3]).toBe(block2);
    expect(blocks[6]).toContain("waiting: PR 1288 (agent:pr)");
    expect(blocks[6]).not.toContain("Buy shoes");
    third.commit();

    // Nothing new: no block on the fourth message.
    const m4 = [...m3, assistant("k"), user("fourth")];
    const fourth = await preparePlateActivity(request(m4), config);
    expect(blocksIn(fourth.request).filter(Boolean)).toHaveLength(2);
    expect(blockOf((fourth.request.input as ResponseInputItem[])[8])).toBeUndefined();
  });

  test("state survives a restart", async () => {
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config)).commit();
    event({ actor: "alex", action: "done", key: "k1", detail: "Item one" });
    const m2 = [...m1, assistant("a"), user("second")];
    const before = await preparePlateActivity(request(m2), config);
    closePlateActivityDb();
    event({ actor: "alex", action: "done", key: "k2", detail: "Item two" });
    const after = await preparePlateActivity(request(m2), config);
    expect(after.request).toEqual(before.request);
  });

  test("an unanswered message's events move to the next message", async () => {
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config)).commit();
    event({ actor: "alex", action: "done", key: "k1", detail: "Item one" });
    const m2 = [...m1, assistant("a"), user("second")];
    await preparePlateActivity(request(m2), config); // response failed: no commit
    const m3 = [...m2, user("third")];
    const third = await preparePlateActivity(request(m3), config);
    const blocks = blocksIn(third.request);
    expect(blocks[2]).toBeUndefined();
    expect(blocks[3]).toContain("Item one");
  });

  test("plate being down sends the message unchanged and attaches nothing later in the turn", async () => {
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config)).commit();
    event({ actor: "alex", action: "done", key: "k1", detail: "Item one" });
    plateUp = false;
    const m2 = [...m1, assistant("a"), user("second")];
    const down = await preparePlateActivity(request(m2), config);
    expect(down.request.input).toEqual(m2);
    down.commit();
    plateUp = true;
    const loop = await preparePlateActivity(request([...m2, assistant("b")]), config);
    expect(blocksIn(loop.request).filter(Boolean)).toHaveLength(0);
    loop.commit();
    // The missed event is reported with the next message instead.
    const m3 = [...m2, assistant("b"), user("third")];
    const third = await preparePlateActivity(request(m3), config);
    expect(blocksIn(third.request)[4]).toContain("Item one");
  });

  test("plate down on the first message does not later dump history", async () => {
    for (let i = 0; i < 5; i++) event({ actor: "alex", action: "done", key: `old${i}`, detail: "Old" });
    plateUp = false;
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config)).commit();
    plateUp = true;
    const m2 = [...m1, assistant("a"), user("second")];
    const second = await preparePlateActivity(request(m2), config);
    expect(blocksIn(second.request).filter(Boolean)).toHaveLength(0);
  });

  test("threads outside the configured scope are untouched", async () => {
    const other = request([user("hi")], "01a10000-0000-7000-8000-000000000000");
    expect((await preparePlateActivity(other, config)).request).toBe(other);
    expect((await preparePlateActivity(request([user("hi")]), null)).request.input).toEqual([user("hi")]);
  });

  test("compaction requests never start a new block", async () => {
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config)).commit();
    event({ actor: "alex", action: "done", key: "k1", detail: "Item one" });
    const compact = request([...m1, assistant("a"), user("second"), { type: "compaction_trigger" }]);
    const prepared = await preparePlateActivity(compact, config);
    expect(blocksIn(prepared.request).filter(Boolean)).toHaveLength(0);
  });
});

describe("hygiene gate events", () => {
  test("gateEvents names the check, outcome and time, never the photo", () => {
    const state = emptyState("2026-10-07T12:00:00Z");
    const base = { dhash: null, source: { thread: THREAD, key: "m" } };
    state.images.push(
      { ...base, sha256: "a", at: "2026-10-08T06:41:00Z", kind: "teeth", verdict: "accepted", slot: "2026-10-07/night-teeth", reason: "a man brushing", file: "/private/x.jpg" },
      { ...base, sha256: "b", at: "2026-10-08T06:43:00Z", kind: "none", verdict: "rejected", reason: "bathroom selfie" },
      { ...base, sha256: "c", at: "2026-10-08T06:44:00Z", kind: "shower", verdict: "duplicate" },
      { ...base, sha256: "d", at: "2026-10-08T06:45:00Z", kind: "shower", verdict: "accepted", slot: "2026-10-07/shower", manual: { verifier: "x" } },
      { ...base, sha256: "e", at: "2026-10-01T06:45:00Z", kind: "shower", verdict: "accepted", slot: "2026-09-30/shower" },
    );
    state.bypass.history.push("2026-10-08T06:50:00Z");
    state.debts.push({ id: "d1", at: "2026-10-08T06:50:00Z", skipped: ["shower (Oct 7)"], status: "open" });
    state.delay.until = "2026-10-08T17:00:00Z"; // DELAY at 08:00 local, until 10:00
    const events = gateEvents(state, Date.parse("2026-10-08T00:00:00Z"), Date.parse("2026-10-08T18:00:00Z"));
    expect(events.map((e) => e.text)).toEqual([
      "night teeth (Oct 7) accepted",
      "shower photo rejected (copy of an earlier proof)",
      "BYPASS (skipped shower (Oct 7))",
      "DELAY (morning teeth postponed until 10:00)",
    ]);
    const all = JSON.stringify(events);
    for (const secret of ["brushing", "selfie", "/private"]) expect(all).not.toContain(secret);
  });

  test("ordinary images while nothing is locked say nothing; real attempts still report", () => {
    const state = emptyState("2026-10-07T12:00:00Z");
    const chat = { dhash: null, source: { thread: THREAD, key: "m" } };
    const at = (min: number) => `2026-10-08T20:${String(min).padStart(2, "0")}:00Z`;
    state.images.push(
      // An Amazon screenshot in chat, shower still open for the day but nothing locked.
      { ...chat, sha256: "s1", at: at(1), kind: "none", verdict: "rejected", locked: false },
      // Records from before `locked` existed: unknown intent, so silent.
      { ...chat, sha256: "s2", at: at(2), kind: "none", verdict: "rejected" },
      { ...chat, sha256: "s3", at: at(3), kind: null, verdict: "stale" },
      // Sent while the gate was locked: an attempt to unlock it.
      { ...chat, sha256: "s4", at: at(4), kind: "none", verdict: "rejected", locked: true },
      // Through Cairn's proof flow: always an attempt.
      { dhash: null, source: { thread: "cairn", key: "h" }, sha256: "s5", at: at(5), kind: "none", verdict: "rejected", locked: false },
      // Classified as a shower photo: an attempt, even unlocked.
      { ...chat, sha256: "s6", at: at(6), kind: "shower", verdict: "rejected", locked: false },
    );
    const texts = gateEvents(state, Date.parse("2026-10-08T19:00:00Z"), Date.parse("2026-10-08T21:00:00Z")).map((e) => e.text);
    expect(texts).toEqual([
      "photo rejected (no hygiene proof seen)",
      "photo rejected (no hygiene proof seen)",
      "shower photo rejected (not due, or not clear enough)",
    ]);
    expect(renderBlock([], { hygiene: gateEvents({ ...state, images: state.images.slice(0, 3) }, 0, Date.now()) })).toBeNull();
  });

  test("outcomes ride on the next message once, alone or with plate events", async () => {
    let gate: GateEvent[] = [];
    const source: HygieneSource = (since, until) =>
      gate.filter((e) => Date.parse(e.at) > since && Date.parse(e.at) <= until);
    const m1 = [user("first")];
    (await preparePlateActivity(request(m1), config, source)).commit();

    const at = new Date(Date.now() - 1000).toISOString();
    gate = [{ key: "image:a", at, text: "night teeth (Oct 7) accepted" }];
    const m2 = [...m1, assistant("a"), user("second")];
    const second = await preparePlateActivity(request(m2), config, source);
    const block = blocksIn(second.request)[2]!;
    expect(block).toMatch(/- hygiene gate: \d\d:\d\d night teeth \(Oct 7\) accepted/);
    second.commit();

    // A check that started before the last message but finished after it is still reported,
    // and the one already sent is not repeated.
    gate.push({ key: "image:b", at: new Date(Date.now() - 60_000).toISOString(), text: "shower (Oct 7) accepted" });
    event({ actor: "alex", action: "done", key: "k1", detail: "Item one" });
    const m3 = [...m2, assistant("b"), user("third")];
    const third = await preparePlateActivity(request(m3), config, source);
    const blocks = blocksIn(third.request);
    expect(blocks[2]).toBe(block);
    expect(blocks[4]).toContain("shower (Oct 7) accepted");
    expect(blocks[4]).not.toContain("night teeth");
    expect(blocks[4]).toContain("done: Item one");
    third.commit();

    const m4 = [...m3, assistant("c"), user("fourth")];
    const fourth = await preparePlateActivity(request(m4), config, source);
    expect(blocksIn(fourth.request)[6]).toBeUndefined();
  });
});

describe("loadConfig", () => {
  test("reads scope and re-reads when the file changes", async () => {
    const path = join(directory, "plate-activity.json");
    expect(loadConfig(path)).toBeNull();
    await writeFile(path, JSON.stringify({ threads: [THREAD] }));
    expect(loadConfig(path)?.threads.has(THREAD)).toBe(true);
    expect(loadConfig(path)?.plateUrl).toBe("http://127.0.0.1:4717");
    await Bun.sleep(10);
    await writeFile(path, JSON.stringify({ threads: [] }));
    expect(loadConfig(path)?.threads.size).toBe(0);
  });
});
