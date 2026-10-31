#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tryLock, unlock } from "../src/filelock";
import { statePath } from "../src/hygiene-gate";
import type { ImageRecord } from "../src/hygiene";
import { cairnWeightClient, previewWeights, WeightQueue, type WeightClient, type WeightSettings } from "../src/weight-sync";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const state = option("--state") ?? statePath();
const settingsFile = option("--settings");
const config = option("--config") ?? process.env.HYGIENE_CAIRN_AGENT_CONFIG;
if (args.includes("--help")) {
  console.log("bun scripts/backfill-weights.ts [--dry-run] [--state gate.json] [--config agent.json] [--settings exported-weights.json (dry-run only)] [--backup-dir directory]");
  process.exit(0);
}
const allowed = new Set(["--dry-run", "--state", "--config", "--settings", "--backup-dir"]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== "--dry-run" && (!args[++i] || args[i].startsWith("--"))) throw new Error("Missing option value");
}
if (settingsFile && !dryRun) throw new Error("--settings is read-only and requires --dry-run; writes must read current relay state");
if (!settingsFile && !config) throw new Error("Supply --config or HYGIENE_CAIRN_AGENT_CONFIG; dry-run may use --settings");
const client: WeightClient = settingsFile ? {
  list: async () => JSON.parse(readFileSync(settingsFile, "utf8")) as WeightSettings,
  insert: async () => { throw new Error("read-only snapshot"); },
} : cairnWeightClient(config!);
const settings = await client.list();
if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid settings snapshot");
const weights = Object.fromEntries(Object.entries(settings).filter(([key]) => key.startsWith("weight.")));
const backupDir = option("--backup-dir") ?? join(dirname(state), "weight-backups");
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const backup = join(backupDir, `weights-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.json`);
writeFileSync(backup, JSON.stringify(weights, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Backup: ${backup}\n`);
const records = (JSON.parse(readFileSync(state, "utf8")) as { images: ImageRecord[] }).images;
let rows;
if (dryRun) {
  rows = await previewWeights(records, weights);
  console.log("DRY RUN — written means would write; no Cairn or queue changes.\n");
} else {
  const path = `${state}.weights.sqlite`, lock = `${path}.lock`;
  if (!tryLock(lock).held) throw new Error("Weight delivery already running; retry after it finishes");
  const queue = new WeightQueue(path);
  try { await queue.add(records); await queue.run(client); rows = queue.list(); }
  finally { queue.close(); unlock(lock); }
}
const cell = (value: unknown) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
console.log("| Date | Reading | lb | Result | Reason | Photo path |\n|---|---|---:|---|---|---|");
for (const row of rows) console.log(`| ${[row.day, row.reading, row.lb, row.result, row.reason, row.file].map(cell).join(" | ")} |`);
const counts: Record<string, number> = {};
for (const row of rows) counts[row.result] = (counts[row.result] ?? 0) + 1;
console.log(`\nCounts: ${JSON.stringify(counts)}`);
if (rows.some(row => row.result === "pending")) process.exitCode = 1;
