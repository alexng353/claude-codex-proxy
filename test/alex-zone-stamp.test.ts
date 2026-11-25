import { expect, test } from "bun:test";
import { classifyTurn, isBareUserMessage, isSyntheticUserMessage, setZoneHistory, zoneAt } from "../src/hygiene";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";
const message = (text: string): ResponseInputItem => ({ role: "user", content: [{ type: "input_text", text }] });
const classify = (text: string) => classifyTurn({ model: "test", input: [message(text)], turn_trigger: "composer" } as ResponsesRequest);

test("old, device and Alex stamps strip identically and keep relay classification", () => {
  for (const stamp of [
    "[17:32 PDT Sat Oct 24]",
    "[17:32 PDT Sat Oct 24 · mac]",
    "[13:13 WIB Tue Nov 24 (23:13 MST) · mac]",
    "[13:13 WIB Tue Nov 24 (23:13 MST) · mac · Alex 14:13 WITA, Asia/Makassar]",
    "[23:13 MST Mon Nov 23 · Alex 14:13 WITA, Asia/Makassar]",
    "[23:13 MST Mon Nov 23 · Alex 11:58 UTC+5:45, Asia/Kathmandu]",
  ]) {
    expect(classify(`${stamp} BYPASS`)).toEqual(classify("BYPASS"));
    const relay = message(`${stamp} <heartbeat>wake</heartbeat>`);
    expect(isSyntheticUserMessage(relay)).toBe(true);
    expect(isBareUserMessage(relay)).toBe(false);
  }
});

test("phone history picks Makassar after Jakarta", () => {
  try {
    setZoneHistory([{zone:"Asia/Jakarta", from:"2026-11-17T00:00:00Z"}, {zone:"Asia/Makassar", from:"2026-11-18T04:17:00Z"}]);
    expect(zoneAt(Date.parse("2026-11-18T04:16:00Z"))).toBe("Asia/Jakarta");
    expect(zoneAt(Date.parse("2026-11-18T04:18:00Z"))).toBe("Asia/Makassar");
  } finally { setZoneHistory(undefined); }
});
