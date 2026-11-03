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
import { captureTime, dhashFromGray, gpsFix, hammingDistance, parseCaptureTime, parseGpsFix, parseVerdict, parseWeightReading, stripGps, exiftoolBin } from "../src/hygiene-proof";
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
    // Expectations come from glibc reading the same tzdata (test/zone.test.ts
    // covers the transitions); no offset is written down here.
    const sys = (local: string) =>
      Number(Bun.spawnSync(["date", "-d", local, "+%s"], { env: { ...process.env, TZ: "America/Vancouver" } }).stdout.toString()) * 1000;
    expect(new Date(at("2026-10-08", "05:00")).toISOString()).toBe("2026-10-08T12:00:00.000Z");
    expect(at("2026-12-01", "05:00")).toBe(sys("2026-12-01 05:00"));
    expect(at("2026-03-08", "05:00")).toBe(sys("2026-03-08 05:00"));
    // 2026-11-01 is the day BC's clocks stopped changing; midnight is still PDT.
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

  test("weigh-in is off by default and arms at 05:00 once enabled", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(candidateSlots(s, "weight", at(DAY, "06:00"))).toEqual([]);
    s.weighInStartsAt = new Date(at(DAY, "05:00")).toISOString();
    expect(dueToday(s, at(DAY, "04:59")).map((r) => r.slot)).toContain(`${DAY}/morning-weight`);
    expect(slots(s, at(DAY, "04:59"))).toEqual([]);
    expect(slots(s, at(DAY, "05:00"))).toEqual([`${DAY}/morning-teeth`, `${DAY}/morning-weight`]);
    expect(wantedKinds(s, at(DAY, "05:00"))).toEqual(["teeth", "shower", "weight"]);
    s.filled[`${DAY}/morning-weight`] = "x";
    expect(candidateSlots(s, "weight", at(DAY, "06:00"))).toEqual([]);
    // A missed weigh-in does not carry past midnight.
    expect(slots(s, at("2026-10-09", "01:00"))).not.toContain(`${DAY}/morning-weight`);
  });

  test("creatine and the outdoor walk are off by default and arm at 05:00 once enabled", () => {
    const s = state();
    s.filled["2026-10-07/shower"] = "x";
    s.filled["2026-10-07/night-teeth"] = "x";
    expect(candidateSlots(s, "creatine", at(DAY, "06:00"))).toEqual([]);
    expect(candidateSlots(s, "walk", at(DAY, "06:00"))).toEqual([]);
    s.creatineStartsAt = new Date(at(DAY, "05:00")).toISOString();
    s.walkStartsAt = new Date(at(DAY, "05:00")).toISOString();
    expect(dueToday(s, at(DAY, "04:59")).map((r) => r.slot)).toEqual(
      expect.arrayContaining([`${DAY}/morning-creatine`, `${DAY}/morning-walk`]),
    );
    expect(slots(s, at(DAY, "04:59"))).toEqual([]);
    expect(slots(s, at(DAY, "05:00"))).toEqual([`${DAY}/morning-teeth`, `${DAY}/morning-creatine`, `${DAY}/morning-walk`]);
    expect(wantedKinds(s, at(DAY, "05:00"))).toEqual(["teeth", "shower", "creatine", "walk"]);
    // The first outdoor photo starts the walk; the next one may finish it.
    expect(candidateSlots(s, "walk", at(DAY, "06:00"))).toEqual([`${DAY}/morning-walk-start`]);
    s.filled[`${DAY}/morning-walk-start`] = new Date(at(DAY, "06:00")).toISOString();
    expect(candidateSlots(s, "walk", at(DAY, "06:05"))).toEqual([`${DAY}/morning-walk`]);
    expect(outstanding(s, at(DAY, "06:05")).find((r) => r.slot === `${DAY}/morning-walk`)?.label).toBe(
      "outdoor walk: second outdoor photo from 06:15",
    );
    s.filled[`${DAY}/morning-creatine`] = "x";
    expect(wantedKinds(s, at(DAY, "07:00"))).toEqual(["teeth", "shower", "walk"]);
    // Missed ones do not carry past midnight.
    expect(slots(s, at("2026-10-09", "01:00")).filter((name) => name.startsWith(DAY))).toEqual([
      `${DAY}/shower`,
      `${DAY}/night-teeth`,
    ]);
    s.filled[`${DAY}/morning-walk`] = "x";
    expect(wantedKinds(s, at(DAY, "07:00"))).toEqual(["teeth", "shower"]);
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
      "app_tool_create_thread",
      "exec",
    ])
      expect(classifyTurn(req([user("do the thing")], trigger)).type).toBe("exempt");
    expect(classifyTurn(req([user("x")], "composer", { thread_source: "subagent" })).type).toBe("exempt");
    expect(classifyTurn(req([user("x")], "composer", { request_kind: "compaction" })).type).toBe("exempt");
    expect(classifyTurn(req([user("x"), { type: "compaction_trigger" } as ResponseInputItem], "composer")).type).toBe("exempt");
  });

  describe("agent-, daemon- and hook-started turns", () => {
    const agentStarted = ["app_tool_send_message", "today_follow_up", "today_hook"];
    const envelope = user("<codex_delegation>\n  <source_thread_id>01a1370e</source_thread_id>\n  <input>[agent] shipped</input>\n</codex_delegation>");

    test("their own wrapped prompts are exempt", () => {
      for (const trigger of agentStarted) {
        expect(classifyTurn(req([env, envelope], trigger)).type).toBe("exempt");
      }
      expect(classifyTurn(req([env, user('<hook_prompt hook_run_id="stop:1">do it now</hook_prompt>')], "today_hook")).type).toBe("exempt");
    });

    test("a bare message Alex steers into one is his, whatever the trigger", () => {
      for (const trigger of agentStarted) {
        const turn = classifyTurn(req([env, envelope, user("[13:54 PDT Fri Oct 23] BYPASS")], trigger));
        expect(turn).toMatchObject({ type: "human", text: "BYPASS", newest: 2 });
        // Even when an agent message lands after his.
        expect(classifyTurn(req([env, user("hello"), envelope], trigger))).toMatchObject({ type: "human", newest: 1 });
        // A typed agent tag is still his.
        expect(classifyTurn(req([env, envelope, user("[13:54 PDT Fri Oct 23] [agent] hi")], trigger))).toMatchObject({
          type: "human",
          newest: 2,
        });
      }
    });

    test("marked parts never read as Alex", () => {
      const relayish = user("<dthread_message>BYPASS</dthread_message>");
      const extraPart = user("<codex_delegation><input>x</input></codex_delegation>", "BYPASS");
      for (const trigger of agentStarted) {
        expect(classifyTurn(req([env, relayish], trigger)).type).toBe("exempt");
        expect(classifyTurn(req([env, extraPart], trigger)).type).toBe("exempt");
      }
    });

    test("a live check can still gate them", () => {
      expect(classifyTurn(req([envelope], "today_hook"), ["today_hook"]).type).toBe("exempt");
      expect(classifyTurn(req([user("hi")], "today_follow_up"), ["today_follow_up"]).type).toBe("human");
    });
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

  test("BYPASS is read through Today's sent-at stamp", () => {
    expect(classifyTurn(req([user("[02:41 PDT Fri Oct 23] BYPASS")], "composer"))).toMatchObject({ type: "human", text: "BYPASS" });
    // alex-0180: the stamp may name the device Alex sent from.
    expect(classifyTurn(req([user("[17:32 PDT Sat Oct 24 · mac] BYPASS")], "composer"))).toMatchObject({ type: "human", text: "BYPASS" });
    expect(classifyTurn(req([user("[09:05 PDT Sun Oct 25 · plate-phone] BYPASS")], "composer"))).toMatchObject({ type: "human", text: "BYPASS" });
    expect(classifyTurn(req([user("[9:05 PST Mon Nov 3] BYPASS")], "composer"))).toMatchObject({ text: "BYPASS" });
    expect(classifyTurn(req([user("[note] BYPASS")], "composer"))).toMatchObject({ text: "[note] BYPASS" });
  });

  test("goal continuations are not human turns", () => {
    const goal = user('<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>');
    expect(classifyTurn(req([goal], "composer")).type).toBe("exempt");
  });

  test("chat-to-chat messages are exempt by their envelope, never by a tag Alex could type", () => {
    expect(
      classifyTurn(
        req([user("[04:38 PDT Fri Oct 23] <codex_delegation>\n  <source_thread_id>x</source_thread_id>\n  <input>[agent] hi</input>\n</codex_delegation>")], "composer"),
      ).type,
    ).toBe("exempt");
    // Typed agent and script tags, and wrappers no sender writes any more, are Alex's turn.
    for (const text of [
      "[agent] hi",
      "[from x] hi",
      "[foo.sh] hi",
      "[04:07 PDT Fri Oct 23] [agent] Shipped (window only): gutter collapse",
      "[06:32 PDT Fri Oct 23] [ship-arch.sh, 06:32 PDT] Arch daemon and client installed",
      "[03:29 PDT Fri Oct 23] [from coordinator 01a1370e, Alex request 03:29 PDT] Alex: ...",
      "<developer> BYPASS",
    ])
      expect(classifyTurn(req([user(text)], "composer")).type).toBe("human");
    expect(classifyTurn(req([user("[agent] BYPASS")], "composer"))).toMatchObject({ type: "human", text: "[agent] BYPASS" });
    expect(classifyTurn(req([user("[12:42 PDT Fri Oct 23] ok we need to make it so")], "composer")).type).toBe("human");
    expect(classifyTurn(req([user("[12:42 PDT Fri Oct 23] what did [agent] say")], "composer")).type).toBe("human");
    expect(classifyTurn(req([user("[note] BYPASS")], "composer")).type).toBe("human");
  });

  test("a timer is exempt by its script envelope, never by text Alex could type", () => {
    // `today-daemon send --from today-self-improve`: Today logs it as script:<name>'s.
    const timer = (input: string) =>
      user(
        `[08:00 PDT Thu Oct 29] <codex_delegation>\n  <source_thread_id>script:today-self-improve</source_thread_id>\n  <sent_at>08:00 PDT Thu Oct 29</sent_at>\n  <input>${input}</input>\n</codex_delegation>`,
      );
    expect(classifyTurn(req([env, timer("[timer daily 08:00] review")], "app_tool_send_message")).type).toBe("exempt");
    expect(classifyTurn(req([env, timer("BYPASS")], "app_tool_send_message")).type).toBe("exempt");
    // Comb F1: a `[timer` tag typed in the composer is Alex's turn.
    for (const text of ["[timer] do my work", "[timer-x] hi", "[08:00 PDT Thu Oct 29] [timer daily 08:00] review"])
      expect(classifyTurn(req([user(text)], "composer")).type).toBe("human");
  });

  describe("Today side prompts", () => {
    const MARK = "<today-side-call/>";
    const dev = (text: string) =>
      ({ type: "message", role: "developer", content: [{ type: "input_text", text }] }) as ResponseInputItem;
    const seed = "You are a side prompt of Alex's thread \"Today\": a short side conversation.";

    test("are exempt by Today's marker on the first line of their instructions, and can't unlock", () => {
      expect(classifyTurn(req([dev(`${MARK}\nbase\n\n${seed}`), env, user("BYPASS")], "composer")).type).toBe("exempt");
      expect(classifyTurn(req([dev(MARK), env, user("hi")], "composer")).type).toBe("exempt");
      expect(classifyTurn({ ...req([user("BYPASS")], "composer"), instructions: `${MARK}\n${seed}` }).type).toBe("exempt");
    });

    test("/btw, which Today leaves unmarked because it has tools, is Alex's turn", () => {
      expect(classifyTurn(req([dev(`base\n\n${seed}`), env, user("what is the builder doing?")], "composer")).type).toBe("human");
    });

    test("quoted history, seed text, a late marker or Alex's own text never exempt a turn", () => {
      for (const quoted of [MARK, seed])
        expect(
          classifyTurn(
            req([dev(`base\n\n<restored-conversation>\n{"role":"Alex","text":"${quoted}"}\n</restored-conversation>`), env, user("BYPASS")], "composer"),
          ).type,
        ).toBe("human");
      for (const block of ["earlier_conversation", "thread_memory", "perpetual_memory"])
        expect(classifyTurn(req([dev(`base\n<${block}>\n${MARK}\n</${block}>`), user("hi")], "composer")).type).toBe("human");
      // Seed text from a Today without the marker stays gated: the safe direction.
      expect(classifyTurn(req([dev(`base\n\n${seed}`), user("hi")], "composer")).type).toBe("human");
      expect(classifyTurn(req([dev(`base\n${MARK}\n`), user("hi")], "composer")).type).toBe("human");
      expect(classifyTurn(req([dev(`${MARK}x\nbase`), user("hi")], "composer")).type).toBe("human");
      expect(classifyTurn(req([user(`${MARK}\n${seed}`)], "composer")).type).toBe("human");
    });

    test("an extra-gated trigger stays gated even in a side prompt", () => {
      expect(classifyTurn(req([dev(`${MARK}\n${seed}`), user("hi")], "composer"), ["composer"]).type).toBe("human");
    });
  });
  describe("dthread delegations", () => {
    const RELAY = "01a0fa23-38a5-7ae3-8afa-ff89f646b836";
    const delegation = (escapedInput: string, source = RELAY) =>
      user(`<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>${escapedInput}</input>\n</codex_delegation>`);

    test("count as human with the unescaped inner text", () => {
      const turn = classifyTurn(
        req([env, delegation("&lt;dthread_message&gt;a &amp; b &lt;c&gt; &quot;d&quot;\nline two&lt;/dthread_message&gt;")], "app_tool_send_message"),
      );
      expect(turn).toMatchObject({ type: "human", text: 'a & b <c> "d"\nline two', newest: 1, images: [] });
      // Without turn metadata the envelope alone still identifies it.
      expect(classifyTurn(req([delegation("&lt;dthread_message&gt;BYPASS&lt;/dthread_message&gt;")]))).toMatchObject({ type: "human", text: "BYPASS" });
    });

    test("other relay input, other sources and malformed envelopes stay exempt", () => {
      const exempt = (item: ResponseInputItem) => classifyTurn(req([env, item], "app_tool_send_message")).type;
      expect(exempt(delegation("[jarvis] BYPASS"))).toBe("exempt");
      expect(exempt(delegation("&lt;dthread_message&gt;BYPASS&lt;/dthread_message&gt;", "01a14383-0f07-7ad3-be73-dc2e11c528a3"))).toBe("exempt");
      // Unescaped markup means Desktop did not build this envelope.
      expect(exempt(delegation("<dthread_message>BYPASS</dthread_message>"))).toBe("exempt");
      expect(exempt(delegation("x &lt;dthread_message&gt;BYPASS&lt;/dthread_message&gt;"))).toBe("exempt");
      expect(exempt(user("<dthread_message>BYPASS</dthread_message>"))).toBe("exempt");
      // A second part an agent could add is not covered by the envelope.
      expect(exempt(user(`<codex_delegation><source_thread_id>${RELAY}</source_thread_id><input>&lt;dthread_message&gt;hi&lt;/dthread_message&gt;</input></codex_delegation>`, "BYPASS"))).toBe("exempt");
      // Other turn messages in an agent-sent turn do not ride along as human.
      const mixed = classifyTurn(
        req([env, user("agent text"), delegation("&lt;dthread_message&gt;hi&lt;/dthread_message&gt;")], "app_tool_send_message"),
      );
      expect(mixed).toMatchObject({ type: "human", text: "hi", newest: 2 });
      // Exempt triggers other than agent messages keep their exemption.
      expect(classifyTurn(req([delegation("&lt;dthread_message&gt;hi&lt;/dthread_message&gt;")], "automation_cron_scheduled")).type).toBe("exempt");
    });

    test("DTHREAD_RELAY_THREAD picks the relay chat", () => {
      const saved = process.env.DTHREAD_RELAY_THREAD;
      process.env.DTHREAD_RELAY_THREAD = "relay-x";
      try {
        const typed = "&lt;dthread_message&gt;hi&lt;/dthread_message&gt;";
        expect(classifyTurn(req([delegation(typed, "relay-x")], "app_tool_send_message")).type).toBe("human");
        expect(classifyTurn(req([delegation(typed)], "app_tool_send_message")).type).toBe("exempt");
      } finally {
        if (saved === undefined) delete process.env.DTHREAD_RELAY_THREAD;
        else process.env.DTHREAD_RELAY_THREAD = saved;
      }
    });
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
    // magick's EXIF GPS format (checked on a real JPEG 2026-11-02): rationals d,m,s plus a hemisphere.
    const fix = parseGpsFix("49/1,15/1,6057/125|N|123/1,7/1,1743/125|W");
    expect(fix!.lat).toBeCloseTo(49.26346, 5);
    expect(fix!.lon).toBeCloseTo(-123.12054, 5);
    expect(parseGpsFix("|||")).toBeNull();
    expect(parseGpsFix("49/1,15/1,6057/125|X|123/1,7/1,1743/125|W")).toBeNull();
    expect(parseGpsFix("49/0,15/1,1/1|N|123/1,7/1,1/1|W")).toBeNull();
    expect(parseCaptureTime("2026:10:08 05:10:00|")).toBe(Date.parse("2026-10-08T12:10:00Z"));
    expect(parseCaptureTime("|")).toBeNull();
    expect(parseCaptureTime("")).toBeNull();
  });

  test.skipIf(!Bun.which("exiftool", { PATH: "/usr/bin/vendor_perl" }))("exiftool is found with a service PATH that lacks vendor_perl", () => {
    // Found without any PATH, and a stub in a user PATH entry never wins over the system copy.
    expect(exiftoolBin({ PATH: "/nonexistent" })).toBe("/usr/bin/vendor_perl/exiftool");
    const fs = require("node:fs") as typeof import("node:fs");
    const stubDir = fs.mkdtempSync(`${require("node:os").tmpdir()}/fake-exiftool-`);
    try {
      fs.writeFileSync(`${stubDir}/exiftool`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(exiftoolBin({ PATH: stubDir })).toBe("/usr/bin/vendor_perl/exiftool");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
    expect(exiftoolBin({ PATH: "/x", HYGIENE_EXIFTOOL_BIN: "/opt/et" })).toBe("/opt/et");
  });

  test.skipIf(!exiftoolBin() || !Bun.which("magick"))("stripGps removes EXIF and XMP GPS from a real JPEG and keeps the capture time", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/strip-gps-`);
    const file = `${dir}/a.jpg`;
    expect(Bun.spawnSync(["magick", "-size", "8x8", "xc:red", file]).exitCode).toBe(0);
    const tag = Bun.spawnSync([exiftoolBin()!, "-q", "-overwrite_original", "-GPSLatitude=49.26346", "-GPSLatitudeRef=N", "-GPSLongitude=123.12054", "-GPSLongitudeRef=W", "-XMP-exif:GPSLatitude=49.26346", "-XMP-exif:GPSLongitude=-123.12054", "-DateTimeOriginal=2026:11:05 18:05:00", "-OffsetTimeOriginal=-07:00", file]);
    expect(tag.exitCode).toBe(0);
    const bytes = await readFile(file);
    expect(await gpsFix(bytes)).not.toBeNull();
    const stripped = await stripGps({ mediaType: "image/jpeg", bytes });
    expect(stripped).not.toBeNull();
    // A perl planted ahead in PATH never runs: exiftool gets its own environment. Checked in a
    // fresh process, since Bun's default spawn environment is a snapshot taken at startup.
    const fakeDir = `${dir}/fakebin`;
    const marker = `${dir}/fake-perl-ran`;
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(fakeDir);
    fs.writeFileSync(`${fakeDir}/perl`, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    const proof = `${import.meta.dir}/../src/hygiene-proof.ts`;
    const script = `const { stripGps } = await import(${JSON.stringify(proof)}); const bytes = require("node:fs").readFileSync(${JSON.stringify(file)}); console.log((await stripGps({ mediaType: "image/jpeg", bytes })) ? "stripped" : "null");`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH}`, PERL5OPT: "-Mcomb_no_such_module" } });
    expect(run.stdout.toString().trim()).toBe("stripped");
    expect(fs.existsSync(marker)).toBe(false);
    expect(await gpsFix(stripped!.bytes)).toBeNull();
    // No GPS tag left in any group (EXIF or XMP).
    const left = Bun.spawnSync([exiftoolBin()!, "-q", "-q", "-a", "-s", "-G1", "-*GPS*", "-"], { stdin: stripped!.bytes });
    expect(left.stdout.toString().trim()).toBe("");
    expect(await captureTime(stripped!.bytes)).toBe(Date.parse("2026-11-05T18:05:00-07:00"));
    // An XMP-only location is removed too.
    const xmp = `${dir}/b.jpg`;
    expect(Bun.spawnSync(["magick", "-size", "8x8", "xc:blue", xmp]).exitCode).toBe(0);
    expect(Bun.spawnSync([exiftoolBin()!, "-q", "-overwrite_original", "-XMP-exif:GPSLatitude=49.26346", "-XMP-exif:GPSLongitude=-123.12054", xmp]).exitCode).toBe(0);
    const xmpOut = await stripGps({ mediaType: "image/jpeg", bytes: await readFile(xmp) });
    expect(xmpOut).not.toBeNull();
    expect(Bun.spawnSync([exiftoolBin()!, "-q", "-q", "-a", "-s", "-G1", "-*GPS*", "-"], { stdin: xmpOut!.bytes }).stdout.toString().trim()).toBe("");
    expect(await stripGps({ mediaType: "image/jpeg", bytes: Buffer.from("not an image") })).toBeNull();
    (require("node:fs") as typeof import("node:fs")).rmSync(dir, { recursive: true, force: true });
  });

  test("verdict parsing is strict about kind and clamps confidence", () => {
    expect(parseVerdict({ kind: "teeth", confidence: 3, reason: "brush" })).toEqual({ kind: "teeth", confidence: 1, reason: "brush" });
    expect(() => parseVerdict({ kind: "selfie", confidence: 1, reason: "" })).toThrow();
    expect(() => parseVerdict(null)).toThrow();
  });

  test("scale readings convert to pounds, rounded to 0.1", () => {
    expect(parseWeightReading("231.4 lb")).toBe(231.4);
    expect(parseWeightReading("231.4lbs")).toBe(231.4);
    expect(parseWeightReading("231 LB")).toBe(231);
    expect(parseWeightReading("104.9 kg")).toBe(231.3);
    expect(parseWeightReading("72,4 kg")).toBe(159.6);
    expect(parseWeightReading(" 72.4 Kg ")).toBe(159.6);
  });

  test("scale readings without a trustworthy number or unit are refused", () => {
    for (const reading of [
      undefined,
      "",
      "231.4",
      "16 st 7 lb",
      "16.5 st",
      "Err",
      "--.- kg",
      "231.4 lb (maybe 281.4 lb)",
      "59.9 lb",
      "600.1 lb",
      "20 kg",
      "300 kg",
    ])
      expect(parseWeightReading(reading)).toBeNull();
    expect(parseWeightReading("60 lb")).toBe(60);
    expect(parseWeightReading("600 lb")).toBe(600);
  });
});
