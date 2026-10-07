import { describe, expect, test } from "bun:test";
import {
  addDays,
  candidateSlots,
  classifyTurn,
  dueToday,
  emptyState,
  localTime,
  lockedText,
  messageKeys,
  outstanding,
  wantedKinds,
  zonedTime,
  type GateState,
} from "../src/hygiene";
import { dhashFromGray, hammingDistance, parseCaptureTime, parseVerdict } from "../src/hygiene-proof";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

/** Vancouver wall time on a given day, e.g. at("2026-10-08", "05:00"). */
const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};
const DAY = "2026-10-08";
const state = (startsAt = at("2026-10-07", "05:00")): GateState => emptyState(new Date(startsAt).toISOString());
const slots = (s: GateState, now: number) => outstanding(s, now).map((r) => r.slot);

describe("clock", () => {
  test("zonedTime and localTime round-trip across DST", () => {
    expect(new Date(at("2026-10-08", "05:00")).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    expect(new Date(at("2026-12-01", "05:00")).toISOString()).toBe("2026-12-01T13:00:00.000Z");
    // 2026-11-01 is the fall-back day; midnight is still PDT.
    expect(localTime(at("2026-11-01", "00:00"))).toEqual({ day: "2026-11-01", minutes: 0 });
    expect(localTime(at("2026-11-01", "05:00"))).toEqual({ day: "2026-11-01", minutes: 300 });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("requirements", () => {
  test("morning teeth arms at 05:00, not before", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(slots(s, at(DAY, "04:59"))).toEqual([]);
    expect(slots(s, at(DAY, "05:00"))).toEqual([`${DAY}/morning-teeth`]);
    expect(outstanding(s, at(DAY, "05:00"))[0].label).toBe("morning teeth photo");
  });

  test("nothing before the first arm is enforced", () => {
    const s = state(at(DAY, "05:00"));
    // Oct 7's night requirements locked at Oct 8 00:00, before startsAt.
    expect(slots(s, at(DAY, "02:00"))).toEqual([]);
    expect(slots(s, at(DAY, "05:00"))).toEqual([`${DAY}/morning-teeth`]);
  });

  test("night teeth and shower lock at midnight, not before", () => {
    const s = state();
    s.filled[`${DAY}/morning-teeth`] = "x";
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(slots(s, at(DAY, "23:59"))).toEqual([]);
    expect(dueToday(s, at(DAY, "23:59")).map((r) => r.slot)).toEqual([`${DAY}/shower`, `${DAY}/night-teeth`]);
    const midnight = at("2026-10-09", "00:00");
    expect(slots(s, midnight)).toEqual([`${DAY}/shower`, `${DAY}/night-teeth`]);
    expect(outstanding(s, midnight)[0].label).toBe("shower photo (overdue from Oct 8)");
  });

  test("the midnight lock carries into the morning instead of replacing it", () => {
    const s = state();
    s.filled[`${DAY}/morning-teeth`] = "x";
    s.filled[`${DAY}/shower`] = "x";
    const next = "2026-10-09";
    // 02:00: one teeth photo clears the overdue night teeth...
    expect(candidateSlots(s, "teeth", at(next, "02:00"))).toEqual([`${DAY}/night-teeth`]);
    s.filled[`${DAY}/night-teeth`] = "x";
    expect(slots(s, at(next, "02:00"))).toEqual([]);
    // ...and the morning still needs its own photo.
    expect(slots(s, at(next, "05:00"))).toEqual([`${next}/morning-teeth`]);
  });

  test("still locked at 05:00: overdue and morning are separate photos", () => {
    const s = state();
    s.filled[`${DAY}/morning-teeth`] = "x";
    s.filled[`${DAY}/shower`] = "x";
    const next = "2026-10-09";
    expect(slots(s, at(next, "06:00"))).toEqual([`${DAY}/night-teeth`, `${next}/morning-teeth`]);
    expect(candidateSlots(s, "teeth", at(next, "06:00"))).toEqual([`${DAY}/night-teeth`, `${next}/morning-teeth`]);
  });

  test("night teeth only counts from 17:00; shower counts any time", () => {
    const s = state();
    s.filled[`${DAY}/morning-teeth`] = "x";
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(candidateSlots(s, "teeth", at(DAY, "16:59"))).toEqual([]);
    expect(candidateSlots(s, "teeth", at(DAY, "17:00"))).toEqual([`${DAY}/night-teeth`]);
    expect(candidateSlots(s, "shower", at(DAY, "09:00"))).toEqual([`${DAY}/shower`]);
    expect(wantedKinds(s, at(DAY, "16:59"))).toEqual(["shower"]);
  });

  test("a morning photo can't double as night teeth", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    // 18:00 with the morning still missing: the photo fills the morning slot.
    expect(candidateSlots(s, "teeth", at(DAY, "18:00"))[0]).toBe(`${DAY}/morning-teeth`);
    s.filled[`${DAY}/morning-teeth`] = "x";
    expect(candidateSlots(s, "teeth", at(DAY, "18:00"))).toEqual([`${DAY}/night-teeth`]);
  });

  test("penance locks until paid", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    s.debts.push({
      id: "d1",
      at: new Date(at(DAY, "01:00")).toISOString(),
      skipped: ["x"],
      status: "penance",
      penance: { description: "spoon balanced on your head", setAt: "x" },
    });
    expect(outstanding(s, at(DAY, "02:00")).map((r) => r.label)).toEqual(["penance photo: spoon balanced on your head"]);
    expect(wantedKinds(s, at(DAY, "02:00"))).toContain("penance");
  });

  test("locked text names what is needed", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(lockedText(outstanding(s, at(DAY, "06:00")))).toBe(
      "🪥 gate armed: morning teeth photo\nSend a fresh photo to unlock, or reply BYPASS.",
    );
  });
});

const meta = (fields: Record<string, string>) => ({
  "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_source: "user", ...fields }),
});
const user = (...content: unknown[]): ResponseInputItem =>
  ({ type: "message", role: "user", content: content.map((c) => (typeof c === "string" ? { type: "input_text", text: c } : c)) }) as ResponseInputItem;
const req = (input: ResponseInputItem[], trigger?: string, extra: Record<string, string> = {}): ResponsesRequest =>
  ({
    model: "opus",
    input,
    ...(trigger === undefined ? {} : { client_metadata: meta({ turn_trigger: trigger, ...extra }) }),
  }) as ResponsesRequest;
const env = user("<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>");
const image = { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "auto" };

describe("classifyTurn", () => {
  test("a composer turn is human; trailing developer context does not hide it", () => {
    const turn = classifyTurn(req([env, user("fix the bug"), { type: "message", role: "developer", content: [{ type: "input_text", text: "Current local time" }] }], "composer"));
    expect(turn).toMatchObject({ type: "human", text: "fix the bug", newest: 1 });
  });

  test("automations, heartbeats, schedules, agent messages and exec are exempt", () => {
    for (const trigger of [
      "automation_heartbeat_scheduled",
      "automation_cron_scheduled",
      "automation_cron_run_now",
      "app_tool_send_message",
      "app_tool_create_thread",
      "exec",
    ])
      expect(classifyTurn(req([user("do the thing")], trigger)).type).toBe("exempt");
    expect(classifyTurn(req([user("x")], "composer", { thread_source: "subagent" })).type).toBe("exempt");
    expect(classifyTurn(req([user("x")], "composer", { request_kind: "compaction" })).type).toBe("exempt");
    expect(classifyTurn(req([user("x"), { type: "compaction_trigger" } as ResponseInputItem], "composer")).type).toBe("exempt");
  });

  test("without metadata, wrappers still mark agent-written turns", () => {
    expect(classifyTurn(req([user("<heartbeat>\n  <automation_id>x</automation_id>")])).type).toBe("exempt");
    expect(classifyTurn(req([user("<codex_delegation>\n<input>go</input>")])).type).toBe("exempt");
    expect(classifyTurn(req([user("<subagent_notification>{}")])).type).toBe("exempt");
    expect(classifyTurn(req([user("hello")])).type).toBe("human");
  });

  test("an unknown trigger (e.g. a new mobile client) is gated", () => {
    expect(classifyTurn(req([user("hi")], "mobile_composer")).type).toBe("human");
  });

  test("extra gated triggers override an exemption for live checks", () => {
    expect(classifyTurn(req([user("hi")], "exec"), ["exec"]).type).toBe("human");
  });

  test("tool results after the user message are a continuation", () => {
    const input = [
      user("run it"),
      { type: "function_call", call_id: "c1", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ] as ResponseInputItem[];
    expect(classifyTurn(req(input, "composer")).type).toBe("continuation");
  });

  test("BYPASS is read through ambient context and attachment wrappers", () => {
    const turn = classifyTurn(
      req([user('<in-app-browser-context source="ambient-ui-state">\nstuff\n</in-app-browser-context>\nBYPASS')], "composer"),
    );
    expect(turn).toMatchObject({ type: "human", text: "BYPASS" });
    const notBypass = classifyTurn(req([user("BYPASS please")], "composer"));
    expect(notBypass).toMatchObject({ text: "BYPASS please" });
  });

  test("mobile photos in their own message are part of the turn", () => {
    const turn = classifyTurn(
      req(
        [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "locked" }] } as ResponseInputItem,
          user("# Files mentioned by the user:\n\n## Photo 1.jpg: /tmp/codex-remote-attachments/x/1-Photo-1.jpg", image),
          user("here"),
        ],
        "composer",
      ),
    );
    expect(turn).toMatchObject({ type: "human", text: "here", newest: 2 });
    expect(turn.type === "human" && turn.images.map((i) => [i.item, i.part])).toEqual([[1, 1]]);
  });

  test("message keys are stable and ignore the gate's own note", () => {
    const plain = [env, user("ok"), user("ok")];
    const keys = messageKeys(plain);
    expect(keys.get(1)).not.toBe(keys.get(2));
    const noted = [env, user("ok", "<hygiene-gate-note>\nx\n</hygiene-gate-note>"), user("ok")];
    expect(messageKeys(noted)).toEqual(keys);
  });
});

describe("proof helpers", () => {
  test("dHash and Hamming distance", () => {
    const a = new Uint8Array(17 * 16).map((_, i) => (i * 7) % 251);
    const b = a.slice();
    b[0] = 255;
    expect(dhashFromGray(a)).toHaveLength(64);
    expect(hammingDistance(dhashFromGray(a), dhashFromGray(a))).toBe(0);
    expect(hammingDistance(dhashFromGray(a), dhashFromGray(b))).toBe(1);
  });

  test("EXIF capture time honours the offset, else Vancouver", () => {
    expect(parseCaptureTime("2026:10:08 05:10:00|-07:00")).toBe(Date.parse("2026-10-08T12:10:00Z"));
    expect(parseCaptureTime("2026:10:08 05:10:00|")).toBe(Date.parse("2026-10-08T12:10:00Z"));
    expect(parseCaptureTime("|")).toBeNull();
    expect(parseCaptureTime("")).toBeNull();
  });

  test("verdict parsing is strict about kind and clamps confidence", () => {
    expect(parseVerdict({ kind: "teeth", confidence: 3, reason: "brush" })).toEqual({ kind: "teeth", confidence: 1, reason: "brush" });
    expect(() => parseVerdict({ kind: "selfie", confidence: 1, reason: "" })).toThrow();
    expect(() => parseVerdict(null)).toThrow();
  });
});
