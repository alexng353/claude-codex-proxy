import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createScrubber } from "../src/scrub.mjs";
import { PredictionCorpus } from "../src/prediction-corpus";
const root = join(homedir(), ".local/state/today");
const path =
  process.env.PREDICTION_INDEX ?? join(root, "composer-predictions.sqlite");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new Database(path, { create: true });
chmodSync(path, 0o600);
const scrubber = createScrubber();
const corpus = new PredictionCorpus(db, (text) => scrubber.scrub(text));
const before = corpus.count();
corpus.refreshToday(
  "forge",
  process.env.TODAY_DB_PATH ?? join(root, "daemon.sqlite"),
);
const cursors = Object.fromEntries(
  (
    db.query("SELECT thread,seq FROM cursors WHERE source='arch'").all() as {
      thread: string;
      seq: number;
    }[]
  ).map((row) => [row.thread, row.seq]),
);
// Explicit source-script override is for isolated worktree validation, not shell input.
const exporter =
  process.env.PREDICTION_ARCH_EXPORTER ??
  "/home/alex/.local/share/claude-codex-proxy/scripts/prediction-export.ts";
if (!/^\/[a-zA-Z0-9_./-]+$/.test(exporter))
  throw new Error("invalid exporter path");
const child = Bun.spawn(
  [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "arch",
    "bun",
    exporter,
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
);
child.stdin.write(JSON.stringify(cursors));
await child.stdin.end();
let pending = "",
  batch: unknown[] = [];
const decoder = new TextDecoder();
for await (const chunk of child.stdout) {
  pending += decoder.decode(chunk, { stream: true });
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line) batch.push(JSON.parse(line));
    if (batch.length === 500) {
      corpus.ingest("arch", batch);
      batch = [];
    }
  }
}
corpus.ingest("arch", batch);
const exit = await child.exited;
console.log(
  JSON.stringify({
    count: corpus.count(),
    added: corpus.count() - before,
    archExit: exit,
    sources: db
      .query("SELECT source,count(*) AS count FROM replies GROUP BY source")
      .all(),
  }),
);
db.close();
if (exit !== 0) process.exitCode = 1;
