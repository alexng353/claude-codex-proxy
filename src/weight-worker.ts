import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tryLock, unlock } from "./filelock";
import { loadState, statePath } from "./hygiene-gate";
import { remoteGate } from "./hygiene-remote";
import { cairnWeightClient, WeightQueue, type WeightRow } from "./weight-sync";

export const weightQueuePath = () => `${statePath()}.weights.sqlite`;

/** Read-only: opening the review endpoint cannot enqueue or deliver a write. */
export function weightReviews() {
  const path = weightQueuePath();
  let rows: WeightRow[] = [];
  if (existsSync(path)) {
    const db = new Database(path, { readonly: true });
    try {
      if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'weights'").get()) rows = db.query<{ proof: string; result: string; reason: string | null }, []>("SELECT proof, result, reason FROM weights").all()
        .map(row => ({ ...JSON.parse(row.proof), result: row.result, reason: row.reason }));
    } finally { db.close(); }
  }
  const known = new Set(rows.map(row => row.sha256));
  const unqueued = new Set(loadState().images.filter(r => r.cairnWeightPending && !known.has(r.sha256)).map(r => r.sha256));
  return { reviews: rows.filter(row => row.result === "needs-review"), pending: rows.filter(row => row.result === "pending").length + unqueued.size };
}

/** Opt-in configuration, leader only. Gate JSON is the durable outbox input:
 * a crash between accepting a proof and this scan cannot lose its write. */
export function startWeightWorker(): () => Promise<void> {
  const config = process.env.HYGIENE_CAIRN_AGENT_CONFIG;
  if (!config || remoteGate()) return async () => {};
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      const lock = `${weightQueuePath()}.lock`;
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
      if (!tryLock(lock).held) return;
      let queue: WeightQueue | undefined;
      try {
        queue = new WeightQueue(weightQueuePath());
        await queue.add(loadState().images.filter(r => r.cairnWeightPending));
        await queue.run(cairnWeightClient(config));
      } finally { queue?.close(); unlock(lock); }
    })().catch(() => console.error("weigh-in sync: delivery pending; will retry"))
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, 60_000);
  tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
