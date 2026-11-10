import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, zonedTime, type GateState } from "../src/hygiene";
import { flushWakes, gateStatus, gymReport, handleHygieneRoute, resetGateCache, setGateDeps, shieldBypass } from "../src/hygiene-gate";

// Nov 10: gym plan 09:00 missed (Alex sick), bypass #30 at 14:41 ruled justified, and at
// 16:01 the gate re-armed on the same plan and forced bypass #31. A justified ruling must
// settle the plan; an agent must also be able to skip ahead of time.

const DAY = "2026-11-10";
const at = (minute: number) => zonedTime(DAY, minute);
let dir: string;
let now = at(14 * 60 + 41);
const saved = process.env.HYGIENE_GATE_STATE;
const path = () => process.env.HYGIENE_GATE_STATE!;
const iso = (ms: number) => new Date(ms).toISOString();

const call = async (route: string, body: unknown) => {
  const url = new URL(`http://localhost/hygiene/${route}`);
  const res = (await handleHygieneRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }), url)) ?? new Response(null, { status: 404 });
  return { status: res.status, body: (await res.json()) as any };
};
const read = (): GateState => JSON.parse(readFileSync(path(), "utf8"));
const due = () => gateStatus().outstanding.map((r: any) => r.slot);
/** Uplifting is read every 2 minutes; keep the read fresh so a miss can lock. */
const advance = (ms: number) => {
  now = ms;
  const state = read();
  state.gym!.syncedAt = iso(now);
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
};

function plan(id: string, startMinute: number, day = DAY) {
  const start = iso(zonedTime(day, startMinute));
  return { id, start, graceMin: 30, proof: "checkins" as const, tagPattern: "gold", status: "planned" as const, createdAt: iso(at(0)), log: [{ at: iso(at(0)), action: "add" as const, to: start }] };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-skip-"));
  process.env.HYGIENE_GATE_STATE = join(dir, "state.json");
  now = at(14 * 60 + 41);
  setGateDeps({ now: () => now, wake: async () => "sent", fixStatus: () => "open" });
  const state = emptyState(iso(at(-600)));
  for (const s of ["morning-teeth"]) state.filled[`${DAY}/${s}`] = iso(at(400));
  for (const s of ["shower", "night-teeth"]) state.filled[`2026-11-09/${s}`] = iso(at(-100));
  state.gym = { plans: [plan(`${DAY}-1`, 9 * 60), plan("2026-11-11-1", 9 * 60, "2026-11-11")], sessions: [], checkins: [], syncedAt: iso(now) };
  // Bypass #30, already over by the time the ruling's effect is checked.
  state.bypass = { count: 30, until: iso(at(15 * 60 + 41)), history: [iso(now)] } as GateState["bypass"];
  state.debts = [
    { id: `${DAY}-30`, at: iso(now), skipped: ["gym session planned Tue, Nov 10 09:00"], items: [`gym/${DAY}-1`], status: "open" },
    { id: `${DAY}-29`, at: iso(at(23)), skipped: ["night teeth photo (overdue from Nov 9)"], items: ["night-teeth"], status: "open" },
  ];
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
});
afterEach(async () => {
  await flushWakes();
  setGateDeps({});
  resetGateCache();
  if (saved === undefined) delete process.env.HYGIENE_GATE_STATE;
  else process.env.HYGIENE_GATE_STATE = saved;
  rmSync(dir, { recursive: true, force: true });
});

test("without a skip the missed plan re-arms when the bypass ends (the Nov 10 bug, as a control)", async () => {
  expect((await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "sick", reasonClass: "other", skip: false })).status).toBe(200);
  advance(at(16 * 60 + 1));
  expect(due()).toContain(`gym/${DAY}-1`);
});

test("a justified ruling skips the bypassed gym plan: it never re-arms that day or after", async () => {
  const r = await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "Alex is sick (cough)", reasonClass: "other" });
  expect(r.status).toBe(200);
  expect(r.body.debt.skippedItems).toEqual([`gym/${DAY}-1`]);
  const skipped = read().gym!.plans.find((p) => p.id === `${DAY}-1`)!.skipped!;
  expect(skipped).toMatchObject({ by: `ruling on ${DAY}-30`, reason: "Alex is sick (cough)", debtId: `${DAY}-30` });
  for (const minute of [16 * 60 + 1, 20 * 60, 23 * 60 + 59, 24 * 60 + 10 * 60]) {
    advance(at(minute));
    expect(due()).not.toContain(`gym/${DAY}-1`);
  }
  expect(gymReport().plans.find((p: any) => p.id === `${DAY}-1`)!.status).toBe("skipped");
  expect(gateStatus().skips.map((s: any) => s.target)).toEqual([`gym/${DAY}-1`]);
  // Tomorrow's plan is untouched.
  expect(read().gym!.plans.find((p) => p.id === "2026-11-11-1")!.skipped).toBeUndefined();
});

test("a gate_fault justification on the gym plan skips it", async () => {
  const r = await call(`debt/${DAY}-30/resolve`, {
    verdict: "justified",
    reason: "re-armed",
    reasonClass: "gate_fault",
    fixRef: { kind: "q", id: "gate-skip" },
  });
  expect(r.status).toBe(200);
  advance(at(16 * 60 + 1));
  expect(due()).not.toContain(`gym/${DAY}-1`);
});

test("a gate_fault ruling on another item excuses no gym plan by default", async () => {
  const state = read();
  delete state.filled["2026-11-09/night-teeth"];
  state.debts[0].items = ["night-teeth", `gym/${DAY}-1`];
  writeFileSync(path(), JSON.stringify(state));
  advance(at(14 * 60 + 41));
  const r = await call(`debt/${DAY}-30/resolve`, {
    verdict: "justified",
    reason: "teeth slot broken",
    reasonClass: "gate_fault",
    item: "night-teeth",
    fixRef: { kind: "q", id: "gate-skip" },
  });
  expect(r.status).toBe(200);
  expect(r.body.debt.skippedItems).toBeUndefined();
  advance(at(16 * 60 + 1));
  expect(due()).toContain(`gym/${DAY}-1`);
});

test("a ruling on an Emergency-tap debt skips nothing: its items are inferred (a stale tap)", async () => {
  const state = read();
  state.debts[0].at = iso(at(8 * 60)); // before the 09:30 start-by: the plan wasn't missed yet
  state.debts[0].itemsComplete = false;
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
  const r = await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "the shield was stale" });
  expect(r.status).toBe(200);
  expect(r.body.notSkipped).toEqual([`gym/${DAY}-1`]);
  advance(at(16 * 60 + 1));
  expect(due()).toContain(`gym/${DAY}-1`);
});

test("a BYPASS debt's captured gym item is skipped even if the gate's view of that moment changed since", async () => {
  // A Start received later, dated before the bypass, would make a replay call the plan in progress.
  const state = read();
  state.gym!.checkins.push({ clientId: "late", kind: "start", at: iso(at(9 * 60 + 15)), distanceM: 10, accuracyM: 5, receivedAt: iso(at(14 * 60 + 40)) });
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
  const r = await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "sick" });
  expect(r.body.debt.skippedItems).toEqual([`gym/${DAY}-1`]);
});

test("a move debt's ruling skips its own slot, never the next day's", async () => {
  const state = read();
  // A morning photo moved to the evening and charged at midnight: no morning slot locks at
  // 00:00, so only the debt's own moveSlot can name it.
  delete state.filled[`${DAY}/morning-teeth`];
  state.debts.push({ id: `${DAY}-m1`, at: iso(at(0)), skipped: ["morning teeth photo"], items: ["morning-teeth"], status: "open", source: "move", moveSlot: "2026-11-09/morning-teeth" } as any);
  writeFileSync(path(), JSON.stringify(state));
  advance(at(10 * 60));
  const r = await call(`debt/${DAY}-m1/resolve`, { verdict: "justified", reason: "sick", skip: true });
  expect(r.status).toBe(200);
  expect(r.body.debt.skippedItems).toEqual(["2026-11-09/morning-teeth"]);
  expect(read().skips!.map((s) => `${s.day}/${s.item}`)).toEqual(["2026-11-09/morning-teeth"]);
  expect(due()).toContain(`${DAY}/morning-teeth`);
});

test("a ruling on a plan an agent already skipped records it as skipped", async () => {
  expect((await call("skip", { target: `gym/${DAY}-1`, by: "Bubble", reason: "sick" })).status).toBe(200);
  const r = await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "sick" });
  expect(r.body.debt.skippedItems).toEqual([`gym/${DAY}-1`]);
  expect(r.body.notSkipped).toBeUndefined();
});

test("a skip after an Emergency tap still charges the tap", async () => {
  const state = read();
  delete state.filled[`${DAY}/morning-teeth`];
  writeFileSync(path(), JSON.stringify(state));
  advance(at(6 * 60 + 30));
  expect((await call("skip", { target: `${DAY}/morning-teeth`, by: "Bubble", reason: "dentist said no brushing" })).status).toBe(200);
  advance(at(7 * 60));
  const r = await shieldBypass({ minutes: 10, source: "cairn-test", at: iso(at(6 * 60)) });
  expect(r.ok && r.debt_id).toBeTruthy();
});

test("photos stay due after a justified ruling unless it says skip", async () => {
  now = at(23);
  const state = read();
  delete state.filled["2026-11-09/night-teeth"];
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
  advance(at(23));
  expect(due()).toContain("2026-11-09/night-teeth");
  expect((await call(`debt/${DAY}-29/resolve`, { verdict: "justified", reason: "mid-snack, brushing after" })).status).toBe(200);
  expect(due()).toContain("2026-11-09/night-teeth");
});

test("skip:true on a photo ruling excuses the slot the bypass covered, logged with the debt", async () => {
  const state = read();
  delete state.filled["2026-11-09/night-teeth"];
  writeFileSync(path(), JSON.stringify(state));
  advance(at(23));
  const r = await call(`debt/${DAY}-29/resolve`, { verdict: "justified", reason: "sick", skip: true });
  expect(r.status).toBe(200);
  expect(r.body.debt.skippedItems).toEqual(["2026-11-09/night-teeth"]);
  expect(due()).not.toContain("2026-11-09/night-teeth");
  expect(read().skips).toEqual([expect.objectContaining({ day: "2026-11-09", item: "night-teeth", debtId: `${DAY}-29` })]);
});

test("a skip list must name the debt's own items", async () => {
  const r = await call(`debt/${DAY}-30/resolve`, { verdict: "justified", reason: "x", skip: ["shower"] });
  expect(r.status).toBe(422);
  expect(read().debts.find((d) => d.id === `${DAY}-30`)!.status).toBe("open");
});

test("an unjustified ruling skips nothing; revising it to justified does", async () => {
  expect((await call(`debt/${DAY}-30/resolve`, { verdict: "unjustified", reason: "x", penance: "photo of a walk" })).status).toBe(200);
  expect(read().gym!.plans[0].skipped).toBeUndefined();
  expect((await call(`debt/${DAY}-30/revise`, { verdict: "justified", reason: "turns out he has a fever" })).status).toBe(200);
  expect(read().gym!.plans[0].skipped).toMatchObject({ debtId: `${DAY}-30` });
  advance(at(16 * 60 + 1));
  expect(due()).toEqual([]);
});

test("an agent skips a plan ahead of time: never due, logged with who and why, undoable", async () => {
  now = at(7 * 60);
  const r = await call("skip", { target: "gym/2026-11-11-1", by: "Bubble 0b7c3073", reason: "Alex is sick, skip gym tomorrow" });
  expect(r.status).toBe(200);
  expect(r.body.skips.find((s: any) => s.target === "gym/2026-11-11-1")).toMatchObject({ by: "Bubble 0b7c3073", reason: "Alex is sick, skip gym tomorrow" });
  advance(zonedTime("2026-11-11", 14 * 60));
  expect(due()).not.toContain("gym/2026-11-11-1");
  expect(gateStatus().dueToday.map((r: any) => r.slot)).not.toContain("gym/2026-11-11-1");
  expect((await call("unskip", { target: "gym/2026-11-11-1", by: "test" })).status).toBe(200);
  expect(due()).toContain("gym/2026-11-11-1");
});

test("an agent skips a photo for a day; other days and items are unaffected", async () => {
  now = at(4 * 60);
  const r = await call("skip", { target: `${DAY}/morning-weight`, by: "Bubble", reason: "scale broken" });
  expect(r.status).toBe(200);
  const state = read();
  state.weighInStartsAt = iso(at(-600));
  delete state.filled[`${DAY}/morning-teeth`];
  writeFileSync(path(), JSON.stringify(state));
  advance(at(10 * 60));
  expect(due()).not.toContain(`${DAY}/morning-weight`);
  expect(due()).toContain(`${DAY}/morning-teeth`);
  advance(zonedTime("2026-11-11", 10 * 60));
  expect(due()).toContain("2026-11-11/morning-weight");
});

test("skip routes require by and reason, a known target, and refuse penances and the past", async () => {
  expect((await call("skip", { target: "gym/2026-11-11-1", by: "Bubble" })).status).toBe(422);
  expect((await call("skip", { target: "gym/2026-11-11-1", reason: "sick" })).status).toBe(422);
  expect((await call("skip", { target: "gym/nope", by: "b", reason: "r" })).status).toBe(400);
  expect((await call("skip", { target: `${DAY}/sauna`, by: "b", reason: "r" })).status).toBe(400);
  expect((await call("skip", { target: "2026-11-01/shower", by: "b", reason: "r" })).status).toBe(400);
  expect((await call("skip", { target: "penance/x", by: "b", reason: "r" })).status).toBe(400);
  expect((await call("skip", { target: `${DAY}/morning-teeth`, by: "b", reason: "r" })).status).toBe(400); // already done
});

test("the gym route skips with a reason, and a skipped plan can't move", async () => {
  now = at(7 * 60);
  const url = (p: string) => `gym/plans/2026-11-11-1/${p}`;
  expect((await call(url("skip"), { by: "mcp" })).status).toBe(400);
  const r = await call(url("skip"), { by: "mcp", reason: "sick" });
  expect(r.status).toBe(200);
  expect(r.body.message).toContain("skipped");
  expect((await call(url("move"), { by: "mcp", start: "2026-11-11T20:00:00-08:00" })).body.error).toContain("skipped");
});
