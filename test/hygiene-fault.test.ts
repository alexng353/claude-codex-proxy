import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, zonedTime } from "../src/hygiene";
import {
  flushWakes,
  gateStatus,
  handleHygieneRoute,
  resetGateCache,
  setGateDeps,
} from "../src/hygiene-gate";
let dir: string;
let now = zonedTime("2026-11-04", 360);
let closed = false;
let wakes: unknown[];
const saved = process.env.HYGIENE_GATE_STATE;
const call = async (path: string, body: unknown) => {
  const url = new URL("http://localhost/hygiene/" + path);
  return (
    (await handleHygieneRoute(
      new Request(url, { method: "POST", body: JSON.stringify(body) }),
      url,
    )) ?? new Response(null, { status: 404 })
  );
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-fault-"));
  process.env.HYGIENE_GATE_STATE = join(dir, "state.json");
  now = zonedTime("2026-11-04", 360);
  closed = false;
  wakes = [];
  setGateDeps({
    now: () => now,
    wake: async (w) => {
      wakes.push(w);
      return "sent";
    },
    fixStatus: () => (closed ? "closed" : "open"),
  });
  const state = emptyState(
    new Date(zonedTime("2026-11-04", 300)).toISOString(),
  );
  state.walkStartsAt = state.startsAt;
  state.filled["2026-11-04/morning-teeth"] = new Date(now).toISOString();
  state.debts = ["a", "b", "c"].map((id) => ({
    id,
    at: new Date(now).toISOString(),
    skipped: ["15-min outdoor walk"],
    items: ["morning-walk"],
    status: "open",
  }));
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
});
afterEach(async () => {
  const { flushWakes } = await import("../src/hygiene-gate");
  await flushWakes();
  setGateDeps({});
  resetGateCache();
  if (saved === undefined) delete process.env.HYGIENE_GATE_STATE;
  else process.env.HYGIENE_GATE_STATE = saved;
  rmSync(dir, { recursive: true, force: true });
});
const fault = {
  verdict: "justified",
  reasonClass: "gate_fault",
  reason: "cancel did not stick",
  item: "morning-walk",
  fixRef: { kind: "q", id: "gate-fault-escalation" },
};
test("gate_fault requires an actionable fix reference", async () => {
  const r = await call("debt/a/resolve", { ...fault, fixRef: undefined });
  expect(r.status).toBe(422);
  expect((await r.json()).error).toContain("fixRef");
});
test("second fault suspends only its item and notifies once, until its fix closes", async () => {
  expect((await call("debt/a/resolve", fault)).status).toBe(200);
  expect(gateStatus().armed).toBe(true);
  expect((await call("debt/b/resolve", fault)).status).toBe(200);
  expect(gateStatus().armed).toBe(false);
  expect(gateStatus().suspensions[0].item).toBe("morning-walk");
  await flushWakes();
  expect(wakes.length).toBe(1);
  await call("debt/c/resolve", fault);
  await flushWakes();
  expect(wakes.length).toBe(1);
  closed = true;
  expect(gateStatus().armed).toBe(true);
});
test("recurring cancellation is immediate and leaves old debts resolvable", async () => {
  expect(gateStatus().armed).toBe(true);
  expect(
    (await call("items/morning-walk/cancel", { reason: "walk cancelled" }))
      .status,
  ).toBe(200);
  expect(gateStatus().armed).toBe(false);
  expect(JSON.stringify(gateStatus().outstanding)).not.toContain("walk");
  now += 86400000;
  expect(gateStatus().outstanding.some((x) => x.kind === "walk")).toBe(false);
  expect(
    (
      await call("debt/a/resolve", {
        verdict: "justified",
        reason: "cancelled",
      })
    ).status,
  ).toBe(200);
});

test("faults more than 24 hours apart do not suspend", async () => {
  await call("debt/a/resolve", fault);
  now += 86400001;
  await call("debt/b/resolve", fault);
  expect(gateStatus().suspensions).toHaveLength(0);
  expect(wakes).toHaveLength(0);
});
test("a fault cannot suspend a different item from a modern debt", async () => {
  expect(
    (await call("debt/a/resolve", { ...fault, item: "morning-teeth" })).status,
  ).toBe(422);
});
test("chat references require a future ETA and an existing open ledger record", async () => {
  const ref = {
    kind: "chat",
    id: "1da90fc5-6b97-4945-9127-7e46e50c6a23",
    eta: new Date(now - 1).toISOString(),
  };
  expect((await call("debt/a/resolve", { ...fault, fixRef: ref })).status).toBe(
    422,
  );
  setGateDeps({ now: () => now, fixStatus: () => "missing" });
  const response = await call("debt/a/resolve", {
    ...fault,
    fixRef: { ...ref, eta: new Date(now + 3600000).toISOString() },
  });
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("task-ledger");
});
test("cancelled and suspended items are not offered as photo slots or upcoming work", async () => {
  const { candidateSlots, dueToday } = await import("../src/hygiene");
  const { loadState } = await import("../src/hygiene-gate");
  await call("items/night-teeth/cancel", { reason: "cancel" });
  expect(
    dueToday(loadState(), now).some((r) => r.slot.endsWith("/night-teeth")),
  ).toBe(false);
  now = zonedTime("2026-11-04", 1080);
  expect(
    candidateSlots(loadState(), "teeth", now).some((s) =>
      s.endsWith("/night-teeth"),
    ),
  ).toBe(false);
});
test("notification retry is durable and uses the same id; closed repairs stay closed", async () => {
  const { refreshFaults, flushWakes } = await import("../src/hygiene-gate");
  const attempts: string[] = [];
  setGateDeps({
    now: () => now,
    fixStatus: () => (closed ? "closed" : "open"),
    wake: async (w) => {
      attempts.push(w.id);
      return attempts.length === 1 ? "retry" : "sent";
    },
  });
  await call("debt/a/resolve", fault);
  await call("debt/b/resolve", fault);
  await flushWakes();
  resetGateCache();
  await flushWakes();
  expect(attempts).toHaveLength(1);
  now += 30000;
  await flushWakes();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  closed = true;
  await refreshFaults();
  closed = false;
  resetGateCache();
  expect(gateStatus().suspensions).toHaveLength(0);
});

test("recording a fault never waits for the owner notification", async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  setGateDeps({
    now: () => now,
    fixStatus: () => "open",
    wake: async () => {
      await blocked;
      return "sent";
    },
  });
  await call("debt/a/resolve", fault);
  const ruling = call("debt/b/resolve", fault);
  try {
    expect(
      await Promise.race([
        ruling.then(() => "recorded"),
        Bun.sleep(100).then(() => "waiting"),
      ]),
    ).toBe("recorded");
  } finally {
    finish();
    await ruling;
    const { flushWakes } = await import("../src/hygiene-gate");
    await flushWakes();
  }
});

test("a chat fix can select an older ledger record explicitly", async () => {
  setGateDeps({
    now: () => now,
    fixStatus: (ref) =>
      ref.kind === "chat" && ref.task === 42 ? "open" : "missing",
  });
  const response = await call("debt/a/resolve", {
    ...fault,
    fixRef: {
      kind: "chat",
      id: "1da90fc5-6b97-4945-9127-7e46e50c6a23",
      eta: new Date(now + 3600000).toISOString(),
      task: 42,
    },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).debt.fixRef.task).toBe(42);
});

test("a delayed shield debt can identify a fault after the lock cleared", async () => {
  const { loadState, shieldBypass } = await import("../src/hygiene-gate");
  const state = structuredClone(loadState());
  const tapped = now;
  delete state.walkStartsAt;
  state.filled["2026-11-04/morning-teeth"] = new Date(
    now + 600000,
  ).toISOString();
  state.images.push({
    sha256: "old",
    dhash: null,
    at: new Date(now + 600000).toISOString(),
    kind: "teeth",
    verdict: "accepted",
    slot: "2026-11-04/morning-teeth",
    source: { thread: "test", key: "old" },
  });
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
  now += 1200000;
  const bypass = await shieldBypass({
    minutes: 1,
    source: "phone",
    at: new Date(tapped).toISOString(),
  });
  expect(
    loadState().debts.find((d) => d.id === (bypass.ok ? bypass.debt_id : null))
      ?.items,
  ).toContain("morning-teeth");
  expect(bypass.ok).toBe(true);
  if (!bypass.ok) throw new Error("bypass failed");
  expect(
    (
      await call(`debt/${bypass.debt_id}/resolve`, {
        ...fault,
        item: "morning-teeth",
      })
    ).status,
  ).toBe(200);
});

test("a suspended penance cannot supply the description for another debt photo", async () => {
  const { loadState, submitProof } = await import("../src/hygiene-gate");
  const state = structuredClone(loadState());
  state.debts = [
    {
      id: "p1",
      at: new Date(now).toISOString(),
      skipped: [],
      status: "penance",
      penance: {
        description: "photo of teeth",
        setAt: new Date(now).toISOString(),
      },
    },
    {
      id: "p2",
      at: new Date(now).toISOString(),
      skipped: [],
      status: "penance",
      penance: {
        description: "photo outdoors",
        setAt: new Date(now).toISOString(),
      },
    },
  ];
  state.suspensions = [
    {
      item: "penance/p1",
      at: new Date(now).toISOString(),
      debtId: "a",
      fixRef: { kind: "q", id: "repair" },
    },
  ];
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
  let description: string | undefined;
  setGateDeps({
    now: () => now,
    fixStatus: () => "open",
    classify: async (_image, context) => {
      description = context.penance;
      return { kind: "penance", confidence: 0.99, reason: "matches" };
    },
    dhash: async () => null,
    captureTime: async () => null,
    stripGps: async (image) => image,
    archive: () => join(dir, "photo.jpg"),
  });
  const result = await submitProof(
    { mediaType: "image/jpeg", bytes: Buffer.from("proof") },
    { kind: "penance", slot: () => true },
  );
  expect(description).toBe("photo outdoors");
  expect(result.slot).toBe("penance/p2");
});

test("phone status exposes suspensions and persists closure without sending under its lock", async () => {
  const { handleHygieneApi, setAuthenticator } =
    await import("../src/hygiene-api");
  setAuthenticator(async () => ({ id: "test", name: "phone", role: "phone" }));
  try {
    await call("debt/a/resolve", fault);
    await call("debt/b/resolve", fault);
    const url = new URL("http://localhost/hygiene/api/v1/status");
    const get = async () =>
      await (await handleHygieneApi(
        new Request(url, { headers: { authorization: "Bearer test" } }),
        url,
      ))!.json();
    expect((await get()).suspensions[0].item).toBe("morning-walk");
    closed = true;
    expect((await get()).suspensions).toHaveLength(0);
    closed = false;
    resetGateCache();
    expect(gateStatus().suspensions).toHaveLength(0);
    await call("items/morning-walk/cancel", { reason: "cancel" });
    expect((await get()).cancellations["morning-walk"].reason).toBe("cancel");
  } finally {
    setAuthenticator();
  }
});

test("permanent owner notification failure is not retried", async () => {
  const { flushWakes } = await import("../src/hygiene-gate");
  let attempts = 0;
  setGateDeps({
    now: () => now,
    fixStatus: () => "open",
    wake: async () => {
      attempts++;
      return "failed";
    },
  });
  await call("debt/a/resolve", fault);
  await call("debt/b/resolve", fault);
  await flushWakes();
  now += 60000;
  await flushWakes();
  expect(attempts).toBe(1);
});

test("a committed ruling succeeds even when the notification store is temporarily unwritable", async () => {
  const { mkdirSync } = await import("node:fs");
  const { loadState, flushWakes } = await import("../src/hygiene-gate");
  const bad = join(dir, "hygiene-held.json");
  mkdirSync(bad);
  try {
    await call("debt/a/resolve", fault);
    expect((await call("debt/b/resolve", fault)).status).toBe(200);
    expect(loadState().debts.find((d) => d.id === "b")?.status).toBe(
      "justified",
    );
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  await flushWakes();
  expect(wakes).toHaveLength(1);
});

test("incomplete delayed shield attribution permits identifying a revised penance", async () => {
  const { loadState, reviseDebt, shieldBypass } =
    await import("../src/hygiene-gate");
  const state = structuredClone(loadState());
  const tap = now;
  state.debts.push({
    id: "p1",
    at: new Date(now - 1000).toISOString(),
    status: "penance",
    skipped: [],
    ruledAt: new Date(now - 1000).toISOString(),
    penance: {
      description: "photo outside",
      setAt: new Date(now - 1000).toISOString(),
    },
  });
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
  now += 60000;
  await reviseDebt("p1", { verdict: "justified", reason: "new facts" });
  now += 60000;
  const b = await shieldBypass({
    minutes: 1,
    source: "phone",
    at: new Date(tap).toISOString(),
  });
  if (!b.ok) throw new Error("bypass failed");
  expect(
    (await call(`debt/${b.debt_id}/resolve`, { ...fault, item: "penance/p1" }))
      .status,
  ).toBe(200);
});

test("a leniency revision cannot inherit an untracked gate_fault classification", async () => {
  const { reviseDebt, loadState } = await import("../src/hygiene-gate");
  await call("debt/a/resolve", {
    verdict: "unjustified",
    reasonClass: "gate_fault",
    reason: "wrong judgement",
    penance: "photo outside",
  });
  expect(
    (await reviseDebt("a", { verdict: "justified", reason: "new facts" }))
      .status,
  ).toBe(200);
  const debt = loadState().debts.find((d) => d.id === "a")!;
  expect(debt.reasonClass).toBe("other");
  expect(debt.history?.[0].reasonClass).toBe("gate_fault");
});

test("a slot first armed during suspension does not return as overdue after repair", async () => {
  const { loadState } = await import("../src/hygiene-gate");
  const state = structuredClone(loadState());
  state.suspensions = [
    {
      item: "night-teeth",
      at: new Date(now).toISOString(),
      debtId: "a",
      fixRef: { kind: "q", id: "repair" },
    },
  ];
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
  now = zonedTime("2026-11-05", 400);
  closed = true;
  expect(gateStatus().suspensions).toHaveLength(0);
  expect(
    gateStatus().outstanding.some((r) => r.slot === "2026-11-04/night-teeth"),
  ).toBe(false);
});

test("awaiting_receipt repairs are rejected for new rulings", async () => {
  setGateDeps({ now: () => now, fixStatus: () => "awaiting_receipt" });
  expect((await call("debt/a/resolve", fault)).status).toBe(422);
});

test("a done repair missing its receipt is visible and queues one additional owner notice", async () => {
  const { flushWakes } = await import("../src/hygiene-gate");
  await call("debt/a/resolve", fault);
  await call("debt/b/resolve", fault);
  await flushWakes();
  expect(wakes).toHaveLength(1);
  setGateDeps({
    now: () => now,
    fixStatus: () => "awaiting_receipt",
    wake: async (w) => {
      wakes.push(w);
      return "sent";
    },
  });
  await flushWakes();
  resetGateCache();
  await flushWakes();
  expect(gateStatus().suspensions[0].repairStatus).toBe("awaiting_receipt");
  expect(wakes).toHaveLength(2);
  expect(wakes[1]).toEqual(
    expect.objectContaining({
      thread: "1da90fc5-6b97-4945-9127-7e46e50c6a23",
      text: expect.stringContaining("receipt"),
    }),
  );
});

test("fault items must name real gym plans or penance debts", async () => {
  const { loadState } = await import("../src/hygiene-gate");
  const state = structuredClone(loadState());
  delete state.debts[0].items;
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(state));
  resetGateCache();
  for (const item of ["gym/absent", "penance/absent"])
    expect((await call("debt/a/resolve", { ...fault, item })).status).toBe(422);
});
