import { describe, expect, test } from "bun:test";
import { classifyTurn, isBareUserMessage, isSyntheticUserMessage } from "../src/hygiene";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const message = (text: string): ResponseInputItem => ({
  type: "message", role: "user", content: [{ type: "input_text", text }],
});
const request = (text: string): ResponsesRequest => ({
  model: "opus", input: [message(text)],
  client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    request_kind: "turn", thread_source: "user", turn_trigger: "composer",
  }) },
} as ResponsesRequest);

const stamps = [
  "[02:41 PDT Fri Oct 23]",
  "[23:13 MST Mon Nov 23 · mac]",
  "[13:13 WIB Tue Nov 24 (23:13 MST) · mac]",
  "[13:13 WIB Tue Nov 24 (23:13 MST Mon Nov 23) · mac]",
  "[13:13 UTC+7 Tue Nov 24 (23:13 MST) · phone]",
  "[02:43 UTC-3:30 Tue Nov 24 (23:13 MST Mon Nov 23) · phone]",
  "[11:43 UTC+5:30 Tue Nov 24 (23:13 UTC-7) · arch]",
  "[13:13 WIB Tue Nov 24 (11:43 UTC+5:30 Tue Nov 24)]",
  "[13:13 UTC+7 Tue Nov 24 · phone]",
];

for (const stamp of stamps) {
  describe(stamp, () => {
    test("BYPASS and its challenge words reach the gate unchanged", () => {
      for (const body of ["BYPASS", "BYPASS apple birch cloud", "LATER 21:00", "reason: café · 日本語\nkeep  two spaces"]) {
        expect(classifyTurn(request(`${stamp} ${body}`))).toEqual({ type: "human", newest: 0, text: body, images: [] });
      }
    });
    test("a stamped synthetic wrapper remains synthetic", () => {
      const item = message(`${stamp} <codex_delegation>\n  <input>hi</input>\n</codex_delegation>`);
      expect(isSyntheticUserMessage(item)).toBe(true);
      expect(isBareUserMessage(item)).toBe(false);
    });
    test("a stamped heartbeat cannot become bare human input", () => {
      const item = message(`${stamp} <heartbeat>check</heartbeat>`);
      expect(isSyntheticUserMessage(item)).toBe(true);
      expect(isBareUserMessage(item)).toBe(false);
    });
  });
}

test("legacy stamps preserve the exact classified payload bytes", () => {
  const body = "BYPASS apple birch cloud\nkeep  two spaces · café 日本語";
  expect(classifyTurn(request(`[23:13 MST Mon Nov 23 · mac] ${body}`))).toEqual(classifyTurn(request(body)));
});

test("ordinary brackets and malformed new stamps stay in the text", () => {
  for (const prefix of [
    "[note]", "[13:13 WIB Tue Nov 24 (anything)]",
    "[13:13 UTC+ Tue Nov 24 · phone]", "[13:13 UTC+5:3 Tue Nov 24 · phone]",
    "[13:13 WIB Tue Nov 24 (23:13 MST Mon Nov) · mac]",
    "[13:13 WIB Tue Nov 24 (23:13 MST) · mac", 
    "before [13:13 WIB Tue Nov 24 (23:13 MST) · mac]",
  ]) {
    const text = `${prefix} BYPASS`;
    expect(classifyTurn(request(text))).toMatchObject({ type: "human", text });
  }
});
