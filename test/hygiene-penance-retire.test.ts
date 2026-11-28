import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, noteText, zonedTime, type Debt, type GateState } from "../src/hygiene";
import { flushWakes, gateStatus, handleHygieneRoute, resetGateCache, setGateDeps } from "../src/hygiene-gate";

// Nov 28: the 00:43 phone unlock was ruled penance (a walk photo) in debt bedtime-...-52.
// Bubble then ruled bypasses #53 and #54 over that penance justified with skip, yet the
// penance stayed unpaid and the gate re-armed on it each time the bypass ended.

const DAY = "2026-11-28";
const at = (minute: number) => zonedTime(DAY, minute);
const iso = (ms: number) => new Date(ms).toISOString();
const P = "bedtime-1795801383756-52";
const B = `${DAY}-53`;
let dir: string;
let now = at(15 * 60 + 44);
const saved = process.env.HYGIENE_GATE_STATE;
const path = () => process.env.HYGIENE_GATE_STATE!;

const call = async (route: string, body: unknown) => {
  const url = new URL(`http://localhost/hygiene/${route}`);
  const res = (await handleHygieneRoute(new Request(url, { method: "POST", body: JSON.stringify(body) }), url)) ?? new Response(null, { status: 404 });
  return { status: res.status, body: (await res.json()) as any };
};
const read = (): GateState => JSON.parse(readFileSync(path(), "utf8"));
const debt = (id: string) => read().debts.find((d) => d.id === id)!;
const penanceDue = () => gateStatus().outstanding.filter((r: any) => r.kind === "penance").map((r: any) => r.slot);

function write(extra: (s: GateState) => void = () => {}) {
  const state = emptyState(iso(at(-2000)));
  const penanceDebt: Debt = {
    id: P,
    at: iso(at(43)),
    skipped: ["bedtime"],
    items: [],
    bedtime: true,
    status: "penance",
    reason: "00:43 unlock",
    reasonClass: "other",
    ruledAt: iso(at(15 * 60 + 30)),
    penance: { description: "photo of you outside on a short walk", setAt: iso(at(15 * 60 + 30)) },
  } as Debt;
  const bypassDebt: Debt = {
    id: B,
    at: iso(at(15 * 60 + 43)),
    skipped: ["penance photo: photo of you outside on a short walk"],
    items: [`penance/${P}`],
    status: "open",
  } as Debt;
  state.debts = [penanceDebt, bypassDebt];
  state.bypass = { count: 53, until: iso(at(16 * 60 + 43)), history: [iso(at(15 * 60 + 43))] } as GateState["bypass"];
  extra(state);
  writeFileSync(path(), JSON.stringify(state));
  resetGateCache();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-penance-retire-"));
  process.env.HYGIENE_GATE_STATE = join(dir, "state.json");
  now = at(15 * 60 + 44);
  setGateDeps({ now: () => now, wake: async () => "sent", fixStatus: () => "open" });
  write();
});
afterEach(async () => {
  await flushWakes();
  setGateDeps({});
  resetGateCache();
  if (saved === undefined) delete process.env.HYGIENE_GATE_STATE;
  else process.env.HYGIENE_GATE_STATE = saved;
  rmSync(dir, { recursive: true, force: true });
});

test("control: a justified ruling without skip leaves the covered penance due", async () => {
  expect((await call(`debt/${B}/resolve`, { verdict: "justified", reason: "work", reasonClass: "other" })).status).toBe(200);
  expect(debt(P).status).toBe("penance");
  expect(penanceDue()).toEqual([`penance/${P}`]);
});

test("skip:true on a justified bypass ruling retires the penance it covered (the Nov 28 bug)", async () => {
  const r = await call(`debt/${B}/resolve`, { verdict: "justified", reason: "work with the Futurity team", reasonClass: "other", skip: true });
  expect(r.status).toBe(200);
  expect(r.body.debt.retiredPenances).toEqual([`penance/${P}`]);
  const p = debt(P);
  expect(p.status).toBe("justified");
  expect(p.penance).toBeUndefined();
  expect(p.reason).toBe(`retired by justified ruling on ${B}: work with the Futurity team`);
  expect(p.history).toEqual([
    {
      status: "penance",
      reasonClass: "other",
      reason: "00:43 unlock",
      ruledAt: iso(at(15 * 60 + 30)),
      penance: { description: "photo of you outside on a short walk", setAt: iso(at(15 * 60 + 30)) },
      revisedAt: iso(now),
    },
  ]);
  expect(debt(B).retiredPenances).toEqual([`penance/${P}`]);
  // The bypass window ends: nothing re-arms on the penance.
  now = at(16 * 60 + 52);
  resetGateCache();
  expect(penanceDue()).toEqual([]);
});

test("a skip list naming the penance is accepted and retires it", async () => {
  const r = await call(`debt/${B}/resolve`, { verdict: "justified", reason: "work", reasonClass: "other", skip: [`penance/${P}`] });
  expect(r.status).toBe(200);
  expect(debt(P).status).toBe("justified");
  expect(penanceDue()).toEqual([]);
});

test("revising an unjustified bypass ruling with skip retires the penance it covered", async () => {
  expect((await call(`debt/${B}/resolve`, { verdict: "unjustified", reason: "no", reasonClass: "other", penance: "another walk" })).status).toBe(200);
  expect(debt(P).status).toBe("penance");
  const r = await call(`debt/${B}/revise`, { verdict: "justified", reason: "it was work after all", skip: true });
  expect(r.status).toBe(200);
  expect(debt(B).status).toBe("justified");
  expect(debt(P).status).toBe("justified");
  expect(debt(P).reason).toBe(`retired by revision of ${B}: it was work after all`);
  expect(penanceDue()).toEqual([]);
});

test("a shield debt's inferred penance item is not retired by a ruling", async () => {
  write((s) => {
    const b = s.debts.find((d) => d.id === B)!;
    b.itemsComplete = false;
  });
  expect((await call(`debt/${B}/resolve`, { verdict: "justified", reason: "stale", reasonClass: "other", skip: true })).status).toBe(200);
  expect(debt(P).status).toBe("penance");
  expect(debt(B).retiredPenances).toBeUndefined();
});

test("a paid penance is left as it is", async () => {
  write((s) => {
    const p = s.debts.find((d) => d.id === P)!;
    p.status = "paid";
    p.penance!.paidAt = iso(at(15 * 60 + 40));
  });
  expect((await call(`debt/${B}/resolve`, { verdict: "justified", reason: "work", reasonClass: "other", skip: true })).status).toBe(200);
  expect(debt(P).status).toBe("paid");
  expect(debt(P).history).toBeUndefined();
});

test("an unknown debt id says how a penance slot maps to its debt", async () => {
  const r = await call(`debt/${DAY}-52/resolve`, { verdict: "justified", reason: "x", reasonClass: "other" });
  expect(r.status).toBe(404);
  expect(r.body.error).toContain("a penance slot penance/<id> is debt <id>");
  expect((await call(`debt/${DAY}-52/revise`, { verdict: "justified", reason: "x" })).body.error).toContain("penance/<id> is debt <id>");
});

test("the ruling note for a bypass over a penance says skip retires it", () => {
  const text = noteText(read().debts.find((d) => d.id === B)!, "http://gate");
  expect(text).toContain(
    `This bypass covered penance/${P}: each is the unpaid penance of debt ${P}. A justified ruling with "skip":true (or a list naming it) retires that penance too; without skip it stays due and locks again when the bypass ends.`,
  );
});
