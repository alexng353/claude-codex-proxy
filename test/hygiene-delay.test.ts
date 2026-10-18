import { expect, test } from "bun:test";
import { candidateSlots, dueToday, emptyState, outstanding } from "../src/hygiene";

test("delayed morning photos remain due, opt-in is honored, accepted photos disappear", () => {
  const state = emptyState("2026-10-01T00:00:00.000Z");
  const day = "2026-10-08";
  const now = Date.parse("2026-10-08T14:50:00.000Z");
  state.delay = { count: 1, until: "2026-10-08T16:45:00.000Z", day, history: [] };
  state.filled["2026-10-07/shower"] = "x";
  state.filled["2026-10-07/night-teeth"] = "x";
  expect(dueToday(state, now).some((r) => r.kind === "weight")).toBe(false);
  state.weighInStartsAt = "2026-10-01T00:00:00.000Z";
  expect(outstanding(state, now)).toEqual([]);
  expect(dueToday(state, now).map((r) => r.slot)).toContain(`${day}/morning-teeth`);
  expect(dueToday(state, now).map((r) => r.slot)).toContain(`${day}/morning-weight`);
  const expiry = Date.parse("2026-10-08T16:45:00.000Z");
  expect(dueToday(state, expiry).map((r) => r.slot)).not.toContain(`${day}/morning-weight`);
  expect(outstanding(state, expiry).map((r) => r.slot)).toContain(`${day}/morning-weight`);
  state.filled[`${day}/morning-teeth`] = "x";
  expect(dueToday(state, now).map((r) => r.slot)).not.toContain(`${day}/morning-teeth`);
  expect(dueToday(state, now).map((r) => r.slot)).toContain(`${day}/morning-weight`);
  expect(candidateSlots(state, "weight", now)).toEqual([`${day}/morning-weight`]);
  state.filled[`${day}/morning-weight`] = "x";
  expect(dueToday(state, now).some((r) => r.kind === "weight")).toBe(false);
});
