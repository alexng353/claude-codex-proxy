import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCaptureTime, parseWeightReading } from "../src/hygiene-proof";
import { prepareWeight, decideWeight, WeightQueue, type WeightClient } from "../src/weight-sync";
import type { ImageRecord } from "../src/hygiene";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const record = (overrides: Partial<ImageRecord> = {}): ImageRecord => ({ sha256: "a".repeat(64), dhash: null, at: "2026-10-31T07:05:00Z", source: { thread: "chat", key: "photo" }, kind: "weight", verdict: "accepted", reading: "226.9 lb", ...overrides });
function database() { const dir = mkdtempSync(join(tmpdir(), "weight-sync-")); dirs.push(dir); return join(dir, "queue.sqlite"); }
test("units remain explicit and bounded", () => {
  expect(parseWeightReading("100 kg")).toBe(220.5);
  expect(parseWeightReading("226,9 lbs")).toBe(226.9);
  for (const s of ["226.9", "100", "770.3", "226 lb 9", "10 kg"]) expect(parseWeightReading(s)).toBeNull();
});
test("EXIF capture day wins over receipt day, otherwise receipt time is used", async () => {
  const capturedAt = new Date(parseCaptureTime("2026:10:30 23:55:00|-07:00")!).toISOString();
  expect(await prepareWeight(record({ capturedAt }))).toMatchObject({ day: "2026-10-30", at: capturedAt });
  expect(await prepareWeight(record())).toMatchObject({ day: "2026-10-31", at: record().at });
  expect(await prepareWeight(record({ capturedAt: "2026-11-01T08:30:00Z" }))).toMatchObject({ day: "2026-11-01" });
});
test("no unit, existing hand entry, and jumps require review; same value is skipped", async () => {
  const p = await prepareWeight(record());
  expect(decideWeight(await prepareWeight(record({ reading: "226.9" })), {})).toMatchObject({ result: "needs-review" });
  expect(decideWeight(p, { "weight.2026-10-31": { lb: 228 } })).toMatchObject({ result: "needs-review" });
  expect(decideWeight(p, { "weight.2026-10-31": { lb: 226.9 } })).toMatchObject({ result: "skipped-existing" });
  expect(decideWeight(p, { "weight.2026-10-30": { lb: 112.2 } })).toMatchObject({ result: "needs-review" });
  expect(decideWeight(p, { "weight.2026-10-23": { lb: 112.2 } }).result).toBe("needs-review");
  expect(decideWeight(p, { "weight.2026-10-30": { lb: 225 } }).result).toBe("written");
});
test("durable dedupe and retry preserve accepted verdict; lost response never overwrites", async () => {
  const path = database(), r = record(); let attempts = 0;
  const settings: Record<string, unknown> = { "weight.2026-10-30": { lb: 227 } };
  const client: WeightClient = {
    list: async () => structuredClone(settings),
    insert: async (p) => { attempts++; settings["weight." + p.day] = { lb: p.lb, at: p.at }; throw new Error("lost response"); },
  };
  let queue = new WeightQueue(path);
  await queue.add([r, r]);
  await queue.run(client);
  expect(queue.list()).toHaveLength(1);
  expect(queue.list()[0].result).toBe("pending");
  expect(r.verdict).toBe("accepted");
  queue.close(); queue = new WeightQueue(path);
  await queue.run(client);
  expect(queue.list()[0].result).toBe("skipped-existing");
  await queue.add([r]); await queue.run(client);
  expect(attempts).toBe(1); queue.close();
});
test("relay conflicts are retained for review and transport failure retries", async () => {
  const queue = new WeightQueue(database()); await queue.add([record()]);
  let down = true;
  const client: WeightClient = { list: async () => { if (down) throw new Error("offline"); return { "weight.2026-10-30": { lb: 227 } }; }, insert: async () => ({ result: "needs-review", reason: "concurrent hand entry" }) };
  await queue.run(client); expect(queue.list()[0].result).toBe("pending");
  down = false; await queue.run(client); expect(queue.list()[0]).toMatchObject({ result: "needs-review", reason: "concurrent hand entry" }); queue.close();
});

test("backfill preview sorts by capture time, deduplicates photos, and uses projected earlier entries", async () => {
  const { previewWeights } = await import("../src/weight-sync");
  const first = record({ at: "2026-10-30T20:00:00Z", reading: "227 lb" });
  const jump = record({ sha256: "b".repeat(64), reading: "112.2 lb" });
  const rows = await previewWeights([jump, first, first], { "weight.2026-10-29": { lb: 227 } });
  expect(rows.map(r => [r.day, r.result])).toEqual([["2026-10-30", "written"], ["2026-10-31", "needs-review"]]);
});

test("ambiguous readings are flagged even while Cairn is offline", async () => {
  const queue = new WeightQueue(database());
  await queue.add([record({ reading: "226.9" })]);
  await queue.run({ list: async () => { throw new Error("offline"); }, insert: async () => { throw new Error("must not write"); } });
  expect(queue.list()[0].result).toBe("needs-review");
  queue.close();
});

test("backfill CLI backs up all weights and leaves the source and journal untouched in dry-run", async () => {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "weight-backfill-")); dirs.push(dir);
  const state = join(dir, "gate.json"), settings = join(dir, "settings.json");
  const original = JSON.stringify({ images: [record()] });
  writeFileSync(state, original);
  writeFileSync(settings, JSON.stringify({ "weight.2026-10-30": { lb: 227, at: "yesterday" } }));
  const run = Bun.spawn([process.execPath, "scripts/backfill-weights.ts", "--dry-run", "--state", state, "--settings", settings, "--backup-dir", dir], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(run.stdout).text();
  expect(await run.exited).toBe(0);
  expect(readFileSync(state, "utf8")).toBe(original);
  expect(existsSync(state + ".weights.sqlite")).toBe(false);
  const backup = output.match(/^Backup: (.+)$/m)![1];
  expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(JSON.parse(readFileSync(settings, "utf8")));
  expect(output).toContain("DRY RUN");
  expect(output).toContain('| 2026-10-31 | 226.9 lb | 226.9 | written |');
});

test("worker recovers accepted intent on startup and uses the configured Cairn HTTP path", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { startWeightWorker, weightReviews } = await import("../src/weight-worker");
  const { resetGateCache } = await import("../src/hygiene-gate");
  const dir = mkdtempSync(join(tmpdir(), "weight-worker-")); dirs.push(dir);
  const state = join(dir, "gate.json"), config = join(dir, "agent.json");
  const original = JSON.stringify({ startsAt: "2026-10-01T12:00:00Z", images: [record({ capturedAt: null, cairnWeightPending: true })] });
  writeFileSync(state, original);
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer scratch-only");
    if (new URL(req.url).pathname === "/v1/weights") return Response.json({ settings: { "weight.2026-10-30": { lb: 227 } } });
    expect(new URL(req.url).pathname).toBe("/v1/weight-proofs");
    requests.push(await req.json());
    return Response.json({ result: "written" });
  } });
  writeFileSync(config, JSON.stringify({ token: "scratch-only", endpoints: [{ url: server.url.toString() }] }));
  const keys = ["HYGIENE_GATE_STATE", "HYGIENE_CAIRN_AGENT_CONFIG", "HYGIENE_GATE_REMOTE"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.HYGIENE_GATE_STATE = state; process.env.HYGIENE_CAIRN_AGENT_CONFIG = config; delete process.env.HYGIENE_GATE_REMOTE;
    resetGateCache();
    await startWeightWorker()();
    expect(requests).toEqual([{ sha256: "a".repeat(64), day: "2026-10-31", at: record().at, lb: 226.9 }]);
    expect(weightReviews()).toEqual({ reviews: [], pending: 0 });
    expect(readFileSync(state, "utf8")).toBe(original);
    await startWeightWorker()();
    expect(requests).toHaveLength(1);
  } finally {
    server.stop(true);
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    resetGateCache();
  }
});


test("baseline cascade uses the 7-day mean, then most recent within 30 days, else review", async () => {
  const p = await prepareWeight(record());
  expect(decideWeight(p, {}).result).toBe("needs-review");
  expect(decideWeight(p, { "weight.2026-09-30": { lb: 227 } }).result).toBe("needs-review");
  expect(decideWeight(p, { "weight.2026-10-01": { lb: 227 } }).result).toBe("written");
  expect(decideWeight(p, { "weight.2026-10-01": { lb: 112 }, "weight.2026-10-10": { lb: 227 } }).result).toBe("written");
  expect(decideWeight(p, { "weight.2026-10-10": { lb: 112 }, "weight.2026-10-30": { lb: 227 } }).result).toBe("written");
  const { previewWeights } = await import("../src/weight-sync");
  const rows = await previewWeights([record(), record({ sha256: "b".repeat(64), at: "2026-11-01T20:00:00Z" })], {});
  expect(rows.map(r => r.result)).toEqual(["needs-review", "needs-review"]);
});

test("HTTP 423 retries, other 4xx are reviewable with status, and each row logs failure once durably", async () => {
  const { writeFileSync } = await import("node:fs");
  const { cairnWeightClient } = await import("../src/weight-sync");
  const path = database(), config = path + ".json", logs: string[] = [];
  let status = 423;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req =>
    new URL(req.url).pathname === "/v1/weights" ? Response.json({ settings: { "weight.2026-10-30": { lb: 227 } } }) : Response.json({error:"private server detail"}, {status}) });
  writeFileSync(config, JSON.stringify({ token: "scratch", endpoints: [{ url: server.url.toString() }] }));
  let queue = new WeightQueue(path, message => logs.push(message));
  try {
    const client = cairnWeightClient(config);
    await queue.add([record()]); await queue.run(client); await queue.run(client);
    expect(queue.list()[0]).toMatchObject({ result: "pending", reason: "Cairn HTTP 423" });
    queue.close(); queue = new WeightQueue(path, message => logs.push(message));
    status = 403; await queue.run(client);
    expect(queue.list()[0]).toMatchObject({ result: "needs-review", reason: "Cairn HTTP 403" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("423");
    expect(logs[0]).not.toContain("private server detail");
    for (const code of [400, 401, 404, 409, 429]) {
      status = code;
      const r = record({sha256: String(code).padStart(64, "0")});
      await queue.add([r]); await queue.run(client);
      expect(queue.list().find(row => row.sha256 === r.sha256)).toMatchObject({result:"needs-review",reason: "Cairn HTTP " + code});
    }
  } finally { queue.close(); server.stop(true); }
});

test("reviews handle an existing empty database without creating its table", async () => {
  const { Database } = await import("bun:sqlite");
  const { writeFileSync } = await import("node:fs");
  const { weightReviews } = await import("../src/weight-worker");
  const { resetGateCache } = await import("../src/hygiene-gate");
  const state = database() + ".gate";
  writeFileSync(state, JSON.stringify({images:[]}));
  const path = state + ".weights.sqlite";
  new Database(path, {create:true}).close();
  const previous = process.env.HYGIENE_GATE_STATE;
  try {
    process.env.HYGIENE_GATE_STATE = state; resetGateCache();
    expect(weightReviews()).toEqual({ reviews: [], pending: 0 });
    const db = new Database(path, {readonly:true});
    expect(db.query("SELECT name FROM sqlite_master WHERE name='weights'").get()).toBeNull(); db.close();
  } finally { if (previous === undefined) delete process.env.HYGIENE_GATE_STATE; else process.env.HYGIENE_GATE_STATE = previous; resetGateCache(); }
});

test("old delivery journals migrate and expose HTTP failures through reviews", async () => {
  const { Database } = await import("bun:sqlite");
  const { writeFileSync } = await import("node:fs");
  const { weightReviews } = await import("../src/weight-worker");
  const { resetGateCache } = await import("../src/hygiene-gate");
  const state = database() + ".gate", path = state + ".weights.sqlite";
  writeFileSync(state, JSON.stringify({images:[]}));
  const old = new Database(path, {create:true});
  old.exec("CREATE TABLE weights (sha256 TEXT PRIMARY KEY, proof TEXT NOT NULL, result TEXT NOT NULL, reason TEXT)"); old.close();
  const previous = process.env.HYGIENE_GATE_STATE;
  const logs: string[] = [];
  const queue = new WeightQueue(path, message => logs.push(message));
  try {
    await queue.add([record()]);
    await queue.run({list: async () => ({"weight.2026-10-30": {lb:227}}), insert: async () => ({result:"needs-review",reason:"Cairn HTTP 403"})});
    process.env.HYGIENE_GATE_STATE = state; resetGateCache();
    expect(weightReviews().reviews[0]).toMatchObject({result:"needs-review",reason:"Cairn HTTP 403"});
    expect(logs).toHaveLength(1);
  } finally {
    queue.close(); if (previous === undefined) delete process.env.HYGIENE_GATE_STATE; else process.env.HYGIENE_GATE_STATE = previous; resetGateCache();
  }
});
