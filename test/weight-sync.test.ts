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
  expect(decideWeight(p, { "weight.2026-10-23": { lb: 112.2 } }).result).toBe("written");
  expect(decideWeight(p, { "weight.2026-10-30": { lb: 225 } }).result).toBe("written");
});
test("durable dedupe and retry preserve accepted verdict; lost response never overwrites", async () => {
  const path = database(), r = record(); let attempts = 0;
  const settings: Record<string, unknown> = {};
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
  const client: WeightClient = { list: async () => { if (down) throw new Error("offline"); return {}; }, insert: async () => ({ result: "needs-review", reason: "concurrent hand entry" }) };
  await queue.run(client); expect(queue.list()[0].result).toBe("pending");
  down = false; await queue.run(client); expect(queue.list()[0]).toMatchObject({ result: "needs-review", reason: "concurrent hand entry" }); queue.close();
});

test("backfill preview sorts by capture time, deduplicates photos, and uses projected earlier entries", async () => {
  const { previewWeights } = await import("../src/weight-sync");
  const first = record({ at: "2026-10-30T20:00:00Z", reading: "227 lb" });
  const jump = record({ sha256: "b".repeat(64), reading: "112.2 lb" });
  const rows = await previewWeights([jump, first, first], {});
  expect(rows.map(r => [r.day, r.result])).toEqual([["2026-10-30", "written"], ["2026-10-31", "needs-review"]]);
});
