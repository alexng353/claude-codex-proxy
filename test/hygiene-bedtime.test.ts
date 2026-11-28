import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { setAuthenticator } from "../src/hygiene-api";
import { emptyState, noteText } from "../src/hygiene";
import { flushWakes, gateStatus, loadState, resetGateCache, setGateDeps, shieldSignature } from "../src/hygiene-gate";
import { callHygieneTool, setHygieneFetcher, ROUTES } from "../src/hygiene-mcp";

const BUBBLE = "0b7c3073-04a4-404f-87d1-50e7f6359ba1";
const START = Date.parse("2026-11-24T17:05:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
let clock = START;
let dir: string;
let saved: Record<string, string | undefined>;
let wakes: Array<{ id: string; thread: string; text: string }>;
beforeEach(() => {
  saved = Object.fromEntries(["HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE", "PROXY_STATE_DIR", "PROXY_API_KEY"].map(k => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "bedtime-test-"));
  process.env.PROXY_STATE_DIR = dir;
  process.env.HYGIENE_GATE_STATE = join(dir, "gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(dir, "disabled");
  process.env.PROXY_API_KEY = "local-test-key";
  delete process.env.HYGIENE_GATE_REMOTE;
  clock = START;
  wakes = [];
  resetGateCache();
  setGateDeps({ now: () => clock, bypassWords: () => "apple birch cloud", wake: async w => { wakes.push(w); return "sent"; } });
  writeFileSync(process.env.HYGIENE_GATE_STATE, JSON.stringify(emptyState(iso(START + 86400_000))));
  setAuthenticator(async token => token === "phone" ? { id: "phone", name: "phone", role: "phone" } : token === "agent" ? { id: "agent", name: "agent", role: "agent" } : null);
  setHygieneFetcher(async (route, body) => {
    const r = ROUTES[route];
    const reply = await http(r.path, body, "local-test-key", false, r.method);
    return { status: reply.code, body: reply.body };
  });
});
afterEach(async () => {
  await flushWakes();
  setAuthenticator();
  setHygieneFetcher();
  setGateDeps({});
  resetGateCache();
  for (const [k,v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});
async function http(path: string, body?: unknown, token = "phone", forwarded = true, method = "POST") {
  const r = await handleRequest(new Request(`http://localhost${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(forwarded ? { "x-forwarded-for": "100.64.1.1" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  }), "127.0.0.1");
  return { code: r.status, body: await r.json() as any };
}
const api = (path: string, body?: unknown, token = "phone") => http(`/hygiene/api/v1${path}`, body, token);
const request = (id = "request-1", reason = "I need to call a taxi") => api("/bedtime/request", { id, reason });
const decide = (approve = true, id = "request-1", meta: unknown = { threadId: BUBBLE }) => callHygieneTool(approve ? "bedtime_unlock_approve" : "bedtime_unlock_deny", { id, reason: "Travel emergency" }, meta);
const status = () => http("/hygiene/api/v1/status", undefined, "phone", true, "GET");
const tap = (at = clock, minutes = 15) => api("/bypass", { source: "cairn-bedtime", at: iso(at), minutes });

test("request persists, wakes Bubble once, never unlocks, and rejects changed replay", async () => {
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  const first = await request();
  expect(first.code).toBe(200);
  expect(first.body).toMatchObject({ ok: true, id: "request-1", status: "pending", duplicate: false });
  await flushWakes();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ thread: BUBBLE });
  expect(wakes[0].text).toContain("request-1");
  expect(wakes[0].text).toContain("I need to call a taxi");
  resetGateCache();
  expect((await request()).body.duplicate).toBe(true);
  await flushWakes();
  expect(wakes).toHaveLength(1);
  expect((await request("request-1", "changed")).code).toBe(409);
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
});

test("request validates id, reason, JSON and role before changing state", async () => {
  for (const body of [null, {}, { id: "a", reason: " " }, { id: "bad/id", reason: "x" }, { id: "a", reason: "x".repeat(1001) }])
    expect((await api("/bedtime/request", body)).code).toBe(400);
  for (const path of ["/bedtime/request", "/bedtime/bypass"]) {
    expect((await api(path, { id: "a", reason: "x", phrase: "BYPASS" }, "invalid")).code).toBe(401);
    expect((await api(path, { id: "a", reason: "x", phrase: "BYPASS" }, "agent")).code).toBe(403);
  }
  expect(wakes).toHaveLength(0);
});

test("challenge works while hygiene is clear, logs a debt, expires and never extends on retry", async () => {
  const before = shieldSignature();
  const challenge = await api("/bedtime/bypass", { phrase: "BYPASS" });
  expect(challenge.code).toBe(200);
  expect(challenge.body).toMatchObject({ ok: true, granted: false });
  expect(challenge.body.message).toContain("BYPASS apple birch cloud");
  expect((await api("/bedtime/bypass", { phrase: "BYPASS wrong words here" })).body.granted).toBe(false);
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  expect(shieldSignature()).toBe(before);
  const grant = await api("/bedtime/bypass", { phrase: "BYPASS apple birch cloud" });
  expect(grant.body.granted).toBe(true);
  expect(grant.body.gate.bedtime_unlock_until).toBe(iso(START + 15 * MIN));
  expect(grant.body.gate.state).toBe("clear");
  expect(shieldSignature()).not.toBe(before);
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().bypass.until).toBeNull();
  expect(loadState().debts).toMatchObject([{ status: "open", skipped: ["bedtime"], items: [] }]);
  clock += 2 * MIN;
  expect((await api("/bedtime/bypass", { phrase: "BYPASS apple birch cloud" })).body.gate.bedtime_unlock_until).toBe(iso(START + 15 * MIN));
  expect(loadState().bypass.count).toBe(1);
  clock = START + 15 * MIN;
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  expect(shieldSignature()).toBe(before);
});

test("Bubble approval is idempotent, counted, and lasts fifteen minutes from approval", async () => {
  await request();
  clock += 4 * MIN;
  const r = await decide();
  expect(r.isError).toBe(false);
  expect((await status()).body.bedtime_unlock_until).toBe(iso(clock + 15 * MIN));
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().debts[0]).toMatchObject({ status: "open", skipped: ["bedtime"], items: [] });
  expect(JSON.stringify(loadState())).toContain("Travel emergency");
  clock += MIN;
  expect((await decide()).isError).toBe(false);
  expect((await status()).body.bedtime_unlock_until).toBe(iso(START + 19 * MIN));
  expect(loadState().bypass.count).toBe(1);
  expect((await request()).body.status).toBe("approved");
  expect((await decide(false)).isError).toBe(true);
  await request("request-2");
  expect((await decide(true, "request-2")).isError).toBe(false);
  expect((await status()).body.bedtime_unlock_until).toBe(iso(clock + 15 * MIN));
});

test("denial, missing request and stale request grant nothing", async () => {
  expect((await decide()).isError).toBe(true);
  await request();
  expect((await decide(false)).isError).toBe(false);
  expect((await decide(false)).isError).toBe(false);
  expect((await decide()).isError).toBe(true);
  await request("old");
  clock += 15 * MIN;
  expect((await decide(true, "old")).isError).toBe(true);
  expect((await request("old")).body.status).toBe("expired");
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  expect(loadState().bypass.count).toBe(0);
});

test("Cairn cannot approve; only Bubble's stamped MCP identity may decide", async () => {
  await request();
  for (const meta of [undefined, null, { threadId: "another-chat" }]) {
    const r = await callHygieneTool("bedtime_unlock_approve", { id: "request-1", reason: "x", by: `chat:${BUBBLE}`, threadId: BUBBLE }, meta);
    expect(r.isError).toBe(true);
  }
  for (const action of ["approve", "deny"]) {
    expect((await api(`/bedtime/${action}`, { id: "request-1", by: `chat:${BUBBLE}` })).code).toBe(404);
    expect((await http(`/hygiene/bedtime/${action}`, { id: "request-1", by: `chat:${BUBBLE}` })).code).toBe(403);
    expect((await http(`/hygiene/bedtime/${action}`, { id: "request-1", by: `chat:${BUBBLE}` }, "phone", false)).code).toBe(401);
    expect((await http(`/hygiene/bedtime/${action}`, { id: "request-1", reason: "x", by: "chat:other" }, "local-test-key", false)).code).toBe(403);
  }
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
});

test("bedtime emergency is counted while hygiene clear, anchored, capped and idempotent", async () => {
  const r = await tap(clock - 3 * MIN, 60);
  expect(r.code).toBe(200);
  expect(r.body).toMatchObject({ applied: true, duplicate: false, until: iso(START + 12 * MIN) });
  expect(r.body.gate.bedtime_unlock_until).toBe(iso(START + 12 * MIN));
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().bypass.history).toEqual([iso(START - 3 * MIN)]);
  expect(loadState().bypass.until).toBeNull();
  expect(loadState().debts[0].skipped).toEqual(["bedtime"]);
  clock += MIN;
  expect((await tap(START - 3 * MIN, 60)).body.duplicate).toBe(true);
  expect(loadState().bypass.count).toBe(1);
});

test("late emergency is still counted but never creates fresh time or replaces a newer grant", async () => {
  const r = await tap(clock - 20 * MIN);
  expect(r.body).toMatchObject({ applied: false, until: null });
  expect(r.body.debt_id).toBeString();
  expect(loadState().bypass.count).toBe(1);
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  await request();
  await decide();
  await tap(clock - 19 * MIN);
  expect((await status()).body.bedtime_unlock_until).toBe(iso(clock + 15 * MIN));
  expect(loadState().bypass.count).toBe(3);
});

test("bedtime grants do not clear outstanding hygiene requirements", async () => {
  const s = emptyState(iso(START - 86400_000));
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
  expect(gateStatus().state).toBe("armed");
  await tap();
  expect(gateStatus().state).toBe("armed");
  expect((await status()).body.bedtime_unlock_until).toBe(iso(clock + 15 * MIN));
});

test("invalid phrases and disabled mutations do not create grants", async () => {
  for (const phrase of [undefined, null, 42, " ", "x".repeat(201)])
    expect((await api("/bedtime/bypass", { phrase })).code).toBe(400);
  const malformed = await handleRequest(new Request("http://localhost/hygiene/api/v1/bedtime/request", { method: "POST", headers: { authorization: "Bearer phone" }, body: "{" }));
  expect(malformed.status).toBe(400);
  await request();
  writeFileSync(process.env.HYGIENE_GATE_DISABLED_FILE!, "disabled");
  expect((await request("another")).code).toBe(503);
  expect((await api("/bedtime/bypass", { phrase: "BYPASS" })).code).toBe(503);
  expect((await tap()).code).toBe(503);
  expect((await decide()).isError).toBe(true);
  expect(loadState().bypass.count).toBe(0);
});

test("approval replay after expiry never opens a new window; denial preserves other grants", async () => {
  await request();
  await decide();
  await request("second");
  await decide(false, "second");
  expect((await status()).body.bedtime_unlock_until).toBe(iso(START + 15 * MIN));
  clock += 16 * MIN;
  expect((await decide()).isError).toBe(false);
  expect((await request()).body.status).toBe("approved");
  expect((await status()).body).not.toHaveProperty("bedtime_unlock_until");
  expect(loadState().bypass.count).toBe(1);
});

test("concurrent requests and approvals commit only one debt and wake", async () => {
  const requests = await Promise.all([request(), request()]);
  expect(requests.map(r => r.body.duplicate).sort()).toEqual([false, true]);
  await flushWakes();
  expect(wakes).toHaveLength(1);
  const decisions = await Promise.all([decide(), decide()]);
  expect(decisions.every(r => !r.isError)).toBe(true);
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().debts).toHaveLength(1);
});

test("wake failure persists for retry after a restart", async () => {
  setGateDeps({ now: () => clock, wake: async () => "retry" });
  await request();
  await flushWakes();
  resetGateCache();
  clock += 2 * MIN;
  setGateDeps({ now: () => clock, wake: async w => { wakes.push(w); return "sent"; } });
  await flushWakes();
  expect(wakes).toHaveLength(1);
  expect(wakes[0].text).toContain("request-1");
});

test("offline reports keep the newer grant and charge even under a hygiene bypass", async () => {
  const s = loadState();
  s.bypass.until = iso(clock + 60 * MIN);
  s.bypass.history = [iso(clock - MIN)];
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
  await request();
  await decide();
  clock += MIN;
  const r = await tap(START - 2 * MIN);
  expect(r.body.until).toBe(iso(START + 15 * MIN));
  expect(r.body.gate.bedtime_unlock_until).toBe(iso(START + 15 * MIN));
  expect(loadState().bypass.count).toBe(2);
  expect(loadState().bypass.until).toBe(iso(START + 60 * MIN));
});

test("bedtime tap clock skew and age use the existing journal bounds", async () => {
  expect((await tap(clock - 25 * 60 * MIN)).code).toBe(400);
  expect((await tap(clock + 6 * MIN)).code).toBe(400);
  expect((await tap(clock + 3 * MIN)).body.until).toBe(iso(START + 15 * MIN));
  expect(loadState().bypass.count).toBe(1);
});

test("bedtime challenge and approvals never consume the hygiene phrase", async () => {
  const s = loadState();
  s.bypass.phrase = { words: "birch apple cloud", slots: ["test/hygiene"], issuedAt: iso(clock) };
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
  await api("/bedtime/bypass", { phrase: "BYPASS" });
  expect((await api("/bedtime/bypass", { phrase: "BYPASS birch apple cloud" })).body.granted).toBe(false);
  await request();
  await decide();
  expect(loadState().bypass.phrase?.words).toBe("birch apple cloud");
  expect(loadState().bedtime?.phrase).toBeUndefined();
});


test("non-Bubble MCP callers never reach even a permissive local proxy", async () => {
  let calls = 0;
  setHygieneFetcher(async () => { calls++; return { status: 200, body: { ok: true } }; });
  for (const meta of [undefined, { threadId: "other-chat" }]) {
    for (const name of ["bedtime_unlock_approve", "bedtime_unlock_deny"])
      expect((await callHygieneTool(name, { id: "request-1", reason: "x", by: `chat:${BUBBLE}` }, meta)).isError).toBe(true);
  }
  expect(calls).toBe(0);
});

test("decision routes refuse forwarded proxy credentials and malformed administrative input", async () => {
  await request();
  for (const action of ["approve", "deny"]) {
    const path = `/hygiene/bedtime/${action}`;
    expect((await http(path, { id: "request-1", by: `chat:${BUBBLE}`, reason: "x" }, "local-test-key", true)).code).toBe(403);
    for (const body of [null, [], { id: "request-1", by: `chat:${BUBBLE}`, reason: " " }, { id: "bad/id", by: `chat:${BUBBLE}`, reason: "x" }])
      expect((await http(path, body, "local-test-key", false)).code).toBe(400);
  }
  expect(loadState().bypass.count).toBe(0);
});

test("a later bedtime grant cannot charge an earlier tap covered by hygiene", async () => {
  const s = emptyState(iso(START - 86400_000));
  s.bypass = { count: 1, until: iso(START + 60 * MIN), history: [iso(START)] };
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
  clock = START + 10 * MIN;
  await request();
  await decide();
  clock += MIN;
  const r = await api("/bypass", { source: "cairn-shield", at: iso(START + 5 * MIN), minutes: 15 });
  expect(r.body).toMatchObject({ applied: false, debt_id: null });
  expect(loadState().bypass.count).toBe(2);
  expect(loadState().debts).toHaveLength(1);
});

test("a new hygiene bypass after bedtime still covers subsequent delayed hygiene taps", async () => {
  const s = emptyState(iso(START - 86400_000));
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(s));
  resetGateCache();
  await tap();
  clock += 20 * MIN;
  const first = await api("/bypass", { source: "cairn-shield", at: iso(clock), minutes: 30 });
  expect(first.body.applied).toBe(true);
  clock += 5 * MIN;
  await request();
  await decide();
  clock += MIN;
  expect((await api("/bypass", { source: "cairn-shield", at: iso(START + 22 * MIN), minutes: 15 })).body.debt_id).toBeNull();
  expect(loadState().bypass.count).toBe(3);
});

test("bedtime debt cannot excuse or suspend a hygiene item through fault rulings", async () => {
  setGateDeps({ now: () => clock, fixStatus: () => "open", wake: async () => "sent" });
  await tap();
  const debt = loadState().debts[0];
  const fault = { verdict: "justified", reasonClass: "gate_fault", item: "shower", fixRef: { kind: "q", id: "fixture-repair" }, reason: "Phone shield fault" };
  const r = await http(`/hygiene/debt/${debt.id}/resolve`, fault, "local-test-key", false);
  expect(r.code).toBe(422);
  expect(gateStatus().suspensions).toEqual([]);
  expect(loadState().debts[0].status).toBe("open");
  expect((await http(`/hygiene/debt/${debt.id}/resolve`, { verdict: "justified", item: "shower", reason: "Travel" }, "local-test-key", false)).code).toBe(422);
  expect((await http(`/hygiene/debt/${debt.id}/resolve`, { verdict: "justified", reason: "Travel" }, "local-test-key", false)).code).toBe(200);
  expect(gateStatus().skips).toEqual([]);
  expect(noteText(debt, "http://fixture")).toContain("unlocked his phone at bedtime");
  expect(noteText(debt, "http://fixture")).not.toContain("legacy debt");
});

test("missing wake queue marker retries after a failed enqueue and restart", async () => {
  const path = join(dir, "hygiene-held.json");
  mkdirSync(path);
  await request();
  await flushWakes();
  expect(loadState().bedtime!.requests[0].notificationQueuedAt).toBeUndefined();
  expect(wakes).toHaveLength(0);
  rmSync(path, { recursive: true });
  resetGateCache();
  await flushWakes();
  expect(wakes).toHaveLength(1);
  expect(loadState().bedtime!.requests[0].notificationQueuedAt).toBe(iso(START));
  expect(JSON.parse(readFileSync(path, "utf8")).wakes).toHaveLength(1);
});

const free = (id = "free-1") => api("/bedtime/free", { id });
async function jakarta(at = START) {
  clock = at;
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  await noteDeviceZone("Asia/Jakarta");
}
test("free bedtime grants fifteen minutes, audits identity and never charges or touches other filters", async () => {
  await jakarta();
  const before = structuredClone(loadState());
  const signature = shieldSignature();
  expect((await status()).body.bedtime_free).toMatchObject({ available: true, day: "2026-11-25", zone: "Asia/Jakarta" });
  const r = await free();
  expect(r.code).toBe(200);
  expect(r.body.gate.bedtime_unlock_until).toBe(iso(clock + 15 * MIN));
  expect(r.body.gate.bedtime_free).toMatchObject({ available: false, used_at: iso(clock) });
  expect(loadState().bypass).toEqual(before.bypass);
  expect(loadState().debts).toEqual(before.debts);
  expect(loadState().adultFilter).toEqual(before.adultFilter);
  expect(r.body.gate.adult_filter_unlock_until).toBeUndefined();
  expect(loadState().bedtime?.freeUnlocks).toEqual([{ id: "free-1", by: "cairn:phone", at: iso(clock), until: iso(clock + 15 * MIN), zone: "Asia/Jakarta", day: "2026-11-25" }]);
  expect(shieldSignature()).not.toBe(signature);
  await flushWakes();
  expect(wakes).toHaveLength(0);
});
test("free limit survives restart, concurrent taps and expired id replay; bypass still charges", async () => {
  await jakarta();
  const results = await Promise.all([free(), free("other")]);
  expect(results.map(r => r.code).sort()).toEqual([200, 409]);
  clock += 16 * MIN;
  resetGateCache();
  expect((await free()).body.duplicate).toBe(true);
  expect((await status()).body.bedtime_unlock_until).toBeUndefined();
  expect((await free("second")).code).toBe(409);
  await api("/bedtime/bypass", { phrase: "BYPASS" });
  expect((await api("/bedtime/bypass", { phrase: "BYPASS apple birch cloud" })).body.granted).toBe(true);
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().debts).toHaveLength(1);
});
test("Jakarta midnight renews free allowance and a straddling grant belongs to its start day", async () => {
  await jakarta(Date.parse("2026-11-25T16:55:00Z"));
  expect((await free()).code).toBe(200);
  clock = Date.parse("2026-11-25T17:00:00Z");
  expect((await status()).body.bedtime_free).toMatchObject({ available: true, day: "2026-11-26" });
  expect((await free("next")).code).toBe(409); // Don't consume or extend an active grant.
  clock += 10 * MIN;
  expect((await free("next")).code).toBe(200);
  expect(loadState().bedtime?.freeUnlocks).toHaveLength(2);
});
test("zone change within the day does not restore a spent free unlock", async () => {
  await jakarta(Date.parse("2026-11-25T09:00:00Z"));
  await free();
  clock += 16 * MIN;
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  await noteDeviceZone("Asia/Tokyo");
  expect((await status()).body.bedtime_free.available).toBe(false);
  expect((await free("tokyo")).code).toBe(409);
});
test("active paid grant preserves free allowance; invalid or unauthorized requests do nothing", async () => {
  await jakarta();
  await request(); await decide();
  const until = loadState().bedtime?.unlockUntil;
  expect((await free()).code).toBe(409);
  expect(loadState().bedtime?.unlockUntil).toBe(until);
  expect((await status()).body.bedtime_free.available).toBe(true);
  clock += 15 * MIN;
  for (const body of [null, {}, { id: "bad/id" }]) expect((await api("/bedtime/free", body)).code).toBe(400);
  expect((await api("/bedtime/free", { id: "x" }, "agent")).code).toBe(403);
  expect((await free()).code).toBe(200);
});

test("proxy ends the grant during the phone's minute-rounding tail; free stays spent and paid bypass still works", async () => {
  await jakarta(Date.parse("2026-11-25T16:30:37Z"));
  await free();
  clock += 15 * MIN + 1;
  expect((await status()).body.bedtime_unlock_until).toBeUndefined();
  expect((await free("tail")).code).toBe(409);
  await api("/bedtime/bypass", { phrase: "BYPASS" });
  expect((await api("/bedtime/bypass", { phrase: "BYPASS apple birch cloud" })).body.granted).toBe(true);
  expect(loadState().bypass.count).toBe(1);
  expect(loadState().debts).toHaveLength(1);
});

test("zone hopping cannot renew a still-running origin day", async () => {
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  clock = Date.parse("2026-11-25T04:00:00Z"); await noteDeviceZone("America/Vancouver");
  expect((await free()).code).toBe(200);
  clock = Date.parse("2026-11-25T05:01:00Z"); await noteDeviceZone("America/New_York");
  expect((await free("ny")).code).toBe(409);
  clock = Date.parse("2026-11-25T10:01:00Z"); await noteDeviceZone("Pacific/Kiritimati");
  expect((await free("island")).code).toBe(200); // original Vancouver day ended at 07:00Z
});

// cairn-free15-shield R1-M2: a free unlock lifts only the bedtime lock. While the hygiene gate is
// armed the phone stays shielded, so the free 15 would be spent for nothing; refuse it instead.
const JAKARTA_SINCE = [{ zone: "Asia/Jakarta", from: "2026-11-14T00:00:00.000Z", seenAt: "2026-11-24T00:00:00.000Z" }];
const NIGHT_DONE = { "2026-11-24/shower": "x", "2026-11-24/night-teeth": "x" };
function gateState(extra: Record<string, unknown>, startsAt = "2026-11-20T00:00:00.000Z") {
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify({ ...emptyState(startsAt), zones: JAKARTA_SINCE, ...extra }));
  resetGateCache();
}
async function refusedWithoutSpending(id: string) {
  const before = structuredClone(loadState());
  const r = await free(id);
  expect(r.code).toBe(409);
  expect(r.body.error).toBe("The hygiene gate is locked, so a free unlock would open nothing. Send the photo first; your free unlock is still available.");
  expect(loadState().bedtime?.freeUnlocks ?? []).toEqual([]);
  expect(loadState().bedtime?.unlockUntil).toBeUndefined();
  expect(loadState().bypass).toEqual(before.bypass);
  expect(loadState().debts).toEqual(before.debts);
  const s = (await status()).body;
  expect(s.state).toBe("armed");
  expect(s.bedtime_free.available).toBe(true);
}

test("free unlock is refused, unspent, while last night's photos lock the gate", async () => {
  gateState({});
  clock = START; // 00:05 WIB Nov 25: Nov 24's shower and night teeth are owed
  await refusedWithoutSpending("owed-night");
  gateState({ filled: NIGHT_DONE });
  expect((await free("after-photos")).code).toBe(200);
});

test("free unlock is refused at the 05:00 arm while the morning photos are owed", async () => {
  gateState({ filled: NIGHT_DONE });
  clock = Date.parse("2026-11-24T22:30:00Z"); // 05:30 WIB Nov 25, before a 07:00 wake
  await refusedWithoutSpending("morning");
});

test("free unlock is refused while an owed penance locks the gate, even before the gate's start", async () => {
  gateState({
    debts: [{ id: "d0", at: iso(START - 60 * MIN), skipped: [], status: "penance", penance: { description: "ten pushups", setAt: iso(START - 30 * MIN) } }],
  }, iso(START + 86400_000));
  await refusedWithoutSpending("penance");
});

test("a retried free id that was already granted still answers after the gate re-arms", async () => {
  gateState({ filled: NIGHT_DONE });
  clock = Date.parse("2026-11-24T21:50:00Z"); // 04:50 WIB, nothing owed
  expect((await free("early")).code).toBe(200);
  clock = Date.parse("2026-11-24T22:01:00Z"); // 05:01 WIB, the morning photos arm
  const retry = await free("early");
  expect(retry.code).toBe(200);
  expect(retry.body.duplicate).toBe(true);
});

test("a spent free unlock says it is used, not still available, while the gate is armed", async () => {
  gateState({ filled: NIGHT_DONE });
  clock = Date.parse("2026-11-24T21:50:00Z"); // 04:50 WIB, nothing owed
  expect((await free("early")).code).toBe(200);
  clock = Date.parse("2026-11-24T22:20:00Z"); // 05:20 WIB: the grant has ended and the morning photos arm
  const r = await free("again");
  expect(r.code).toBe(409);
  expect(r.body.error).toBe("Today's free unlock is used.");
});

test("the free command records the phone's zone like a status read does", async () => {
  const r = await handleRequest(new Request("http://localhost/hygiene/api/v1/bedtime/free", {
    method: "POST",
    headers: { authorization: "Bearer phone", "content-type": "application/json", "x-forwarded-for": "100.64.1.1", "x-device-time-zone": "Asia/Jakarta" },
    body: JSON.stringify({ id: "zoned" }),
  }), "127.0.0.1");
  expect(r.status).toBe(200);
  expect(loadState().bedtime?.freeUnlocks?.[0]).toMatchObject({ zone: "Asia/Jakarta", day: "2026-11-25" });
});

test("Jakarta to Bali keeps the allowance used through the origin midnight", async () => {
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  await jakarta(Date.parse("2026-11-25T15:30:00Z")); await free();
  clock = Date.parse("2026-11-25T15:46:00Z"); await noteDeviceZone("Asia/Makassar");
  expect((await free("bali")).code).toBe(409);
  clock = Date.parse("2026-11-25T16:00:00Z");
  expect((await free("bali")).code).toBe(409);
  clock = Date.parse("2026-11-25T17:00:00Z");
  expect((await free("bali")).code).toBe(200);
});

test("eastward destination date waits only until origin midnight", async () => {
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  clock = Date.parse("2026-12-03T08:00:00Z"); await noteDeviceZone("Asia/Makassar"); await free();
  clock = Date.parse("2026-12-03T08:16:00Z"); await noteDeviceZone("Pacific/Kiritimati");
  expect((await free("east")).code).toBe(409);
  clock = Date.parse("2026-12-03T10:01:00Z"); // destination Dec 4, origin still Dec 3
  expect((await free("east")).code).toBe(409);
  clock = Date.parse("2026-12-03T16:00:00Z"); // origin Dec 4
  expect((await free("east")).code).toBe(200);
});

test("recorded date prevents a second use after westward travel even outside destination's start interval", async () => {
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  await jakarta(Date.parse("2026-11-24T17:05:00Z")); await free(); // Nov25 in Jakarta, Nov24 in Vancouver
  clock = Date.parse("2026-11-25T17:05:00Z"); await noteDeviceZone("America/Vancouver");
  expect((await free("west")).code).toBe(409); // still calendar Nov25, origin now Nov26
});

test("receipt start within destination day prevents a second use when recorded date differs", async () => {
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  clock = Date.parse("2026-11-25T06:00:00Z"); await noteDeviceZone("America/Vancouver"); await free(); // Nov24
  clock = Date.parse("2026-11-25T07:01:00Z"); await noteDeviceZone("Asia/Tokyo");
  expect((await free("tokyo-after-origin-midnight")).code).toBe(409);
});

test("Bali to Vancouver on Dec 3 keeps the destination day spent until its midnight", async () => {
  // The fixture gate starts Nov 25, so by Dec 4 unsent photos would arm it and refuse the free
  // unlock; this test is about the day boundary only, so the gate never starts here.
  writeFileSync(process.env.HYGIENE_GATE_STATE!, JSON.stringify(emptyState("2027-01-01T00:00:00.000Z")));
  resetGateCache();
  const { noteDeviceZone } = await import("../src/hygiene-gate");
  clock = Date.parse("2026-12-03T07:00:00Z"); await noteDeviceZone("Asia/Makassar"); await free();
  clock += 16 * MIN; await noteDeviceZone("America/Vancouver");
  expect((await free("vancouver")).code).toBe(409);
  clock = Date.parse("2026-12-03T16:00:00Z"); // Bali's day ended; Vancouver still has the spent Dec3.
  expect((await free("vancouver")).code).toBe(409);
  clock = Date.parse("2026-12-04T07:00:00Z");
  expect((await free("vancouver")).code).toBe(200);
});
