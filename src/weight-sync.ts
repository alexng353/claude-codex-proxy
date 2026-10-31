/** Accepted proofs are the durable input; this journal records delivery independently
 * of the gate verdict. Both the worker and backfill use the same checks. */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { addDays, localTime, type ImageRecord } from "./hygiene";
import { captureTime, parseWeightReading, sha256 } from "./hygiene-proof";

export type WeightSettings = Record<string, unknown>;
export type WeightProof = { sha256: string; day: string; at: string; reading: string; lb: number | null; file: string | null; problem?: string };
export type WeightResult = { result: "written" | "skipped-existing" | "needs-review" | "pending"; reason?: string };
export type WeightRow = WeightProof & WeightResult;
export interface WeightClient {
  list(): Promise<WeightSettings>;
  insert(proof: WeightProof): Promise<WeightResult>;
}

export async function prepareWeight(record: ImageRecord): Promise<WeightProof> {
  let at = record.capturedAt ?? record.at;
  let problem: string | undefined;
  // New records store EXIF at acceptance. Older archives retain original bytes.
  if (record.capturedAt === undefined && record.file) {
    try {
      const bytes = readFileSync(record.file);
      if (sha256(bytes) !== record.sha256) problem = "archived photo hash mismatch";
      else {
        const captured = await captureTime(bytes);
        if (captured !== null && Number.isFinite(captured)) at = new Date(captured).toISOString();
      }
    } catch { problem = "archived photo missing or unreadable"; }
  }
  const validTime = Number.isFinite(Date.parse(at));
  if (!validTime) problem = "invalid photo or receipt time";
  return {
    sha256: record.sha256, day: validTime ? localTime(Date.parse(at)).day : "unknown", at,
    reading: record.reading ?? "", lb: parseWeightReading(record.reading), file: record.file ?? null,
    ...(problem ? { problem } : {}),
  };
}

export function decideWeight(proof: WeightProof, settings: WeightSettings): WeightResult {
  if (proof.problem) return { result: "needs-review", reason: proof.problem };
  if (proof.lb === null) return { result: "needs-review", reason: "reading missing, ambiguous unit, or outside 60–600 lb" };
  const key = `weight.${proof.day}`;
  if (Object.hasOwn(settings, key)) {
    const existing = settings[key] as { lb?: unknown } | null;
    return existing?.lb === proof.lb
      ? { result: "skipped-existing", reason: "same daily weight" }
      : { result: "needs-review", reason: "different existing daily entry" };
  }
  const entries = Object.entries(settings).flatMap(([key, value]) => {
    const day = key.slice(7), lb = (value as { lb?: unknown } | null)?.lb;
    return /^weight\.\d{4}-\d{2}-\d{2}$/.test(key) && day >= addDays(proof.day, -30) && day < proof.day &&
      typeof lb === "number" && Number.isFinite(lb) && lb >= 60 && lb <= 600 ? [{ day, lb }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day));
  const recent = entries.filter(e => e.day >= addDays(proof.day, -7));
  const baseline = recent.length ? recent : entries.slice(0, 1);
  if (!baseline.length) return { result: "needs-review", reason: "no prior weight within 30 days" };
  const mean = baseline.reduce((sum, e) => sum + e.lb, 0) / baseline.length;
  if (Math.abs(proof.lb - mean) > 5 || Math.abs(proof.lb - mean) / mean > 0.03)
    return { result: "needs-review", reason: "more than 5 lb or 3% from 7-day mean or last weight within 30 days" };
  return { result: "written" };
}

export class WeightQueue {
  readonly db: Database;
  constructor(path: string, private readonly log: (message: string) => void = console.error) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS weights (
      sha256 TEXT PRIMARY KEY, proof TEXT NOT NULL, result TEXT NOT NULL, reason TEXT, failure_logged INTEGER NOT NULL DEFAULT 0
    )`);
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(weights)").all().some(c => c.name === "failure_logged"))
      this.db.exec("ALTER TABLE weights ADD COLUMN failure_logged INTEGER NOT NULL DEFAULT 0");
  }
  close() { this.db.close(); }
  async add(records: ImageRecord[]) {
    for (const record of records) {
      if (record.kind !== "weight" || record.verdict !== "accepted") continue;
      if (this.db.query("SELECT 1 FROM weights WHERE sha256 = ?").get(record.sha256)) continue;
      const proof = await prepareWeight(record);
      this.db.query("INSERT OR IGNORE INTO weights (sha256, proof, result, reason) VALUES (?, ?, 'pending', NULL)").run(record.sha256, JSON.stringify(proof));
    }
  }
  list(): WeightRow[] {
    return this.db.query<{ proof: string; result: WeightResult["result"]; reason: string | null }, []>(
      "SELECT proof, result, reason FROM weights ORDER BY json_extract(proof, '$.at'), sha256",
    ).all().map(row => ({ ...JSON.parse(row.proof), result: row.result, ...(row.reason ? { reason: row.reason } : {}) }));
  }
  async run(client: WeightClient) {
    for (const proof of this.list().filter(row => row.result === "pending")) {
      let outcome: WeightResult;
      try {
        // Re-read before every write. The relay rechecks atomically, including jumps.
        outcome = proof.problem || proof.lb === null
          ? decideWeight(proof, {}) : decideWeight(proof, await client.list());
        if (outcome.result === "written") outcome = await client.insert(proof);
      } catch (error) {
        outcome = error instanceof CairnHttpError
          ? { result: error.status >= 400 && error.status < 500 && error.status !== 423 ? "needs-review" : "pending", reason: error.message }
          : { result: "pending", reason: "Cairn unavailable or write not acknowledged; retry pending" };
      }
      const failed = outcome.result === "pending" || outcome.result === "needs-review";
      const shouldLog = this.db.transaction(() => {
        this.db.query("UPDATE weights SET result = ?, reason = ? WHERE sha256 = ?").run(outcome.result, outcome.reason ?? null, proof.sha256);
        return failed && this.db.query("UPDATE weights SET failure_logged = 1 WHERE sha256 = ? AND failure_logged = 0").run(proof.sha256).changes > 0;
      })();
      if (shouldLog) this.log(`weigh-in ${proof.sha256} (${proof.day}): ${outcome.reason ?? outcome.result}`);
    }
  }
}

class CairnHttpError extends Error {
  constructor(readonly status: number) { super(`Cairn HTTP ${status}`); }
}

/** Existing Cairn agent config: credentials stay in the consuming process. */
export function cairnWeightClient(configPath: string): WeightClient {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    token: string; endpoints: { url: string; headers?: Record<string, string> }[];
  };
  async function request(path: string, body?: unknown): Promise<any> {
    let lastStatus: number | undefined;
    for (const endpoint of config.endpoints) {
      try {
        const res = await fetch(new URL(path, endpoint.url), {
          method: body === undefined ? "GET" : "POST",
          headers: { ...endpoint.headers, authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
        });
        if (res.status >= 400 && res.status < 500) throw new CairnHttpError(res.status);
        if (!res.ok) { lastStatus = res.status; continue; }
        return await res.json();
      } catch (error) {
        if (error instanceof CairnHttpError) throw error;
        // Network failures may use another route to the same relay.
      }
    }
    if (lastStatus !== undefined) throw new CairnHttpError(lastStatus);
    throw new Error("Cairn weight endpoint unavailable");
  }
  return {
    list: async () => {
      const response = await request("/v1/weights");
      if (!response.settings || typeof response.settings !== "object" || Array.isArray(response.settings)) throw new Error("invalid weight settings response");
      return response.settings;
    },
    insert: async proof => {
      const response = await request("/v1/weight-proofs", { sha256: proof.sha256, day: proof.day, at: proof.at, lb: proof.lb });
      if (!["written", "skipped-existing", "needs-review"].includes(response.result)) throw new Error("invalid weight write response");
      return { result: response.result, ...(typeof response.reason === "string" ? { reason: response.reason } : {}) };
    },
  };
}

/** Pure preview: earlier proposed writes form the baseline for later photos, just
 * as they will during delivery. The supplied live snapshot is never mutated. */
export async function previewWeights(records: ImageRecord[], settings: WeightSettings): Promise<WeightRow[]> {
  const unique = new Map(records.filter(r => r.kind === "weight" && r.verdict === "accepted").map(r => [r.sha256, r]));
  const proofs: WeightProof[] = [];
  for (const record of unique.values()) proofs.push(await prepareWeight(record));
  proofs.sort((a, b) => a.at.localeCompare(b.at) || a.sha256.localeCompare(b.sha256));
  const projected = structuredClone(settings);
  return proofs.map(proof => {
    const outcome = decideWeight(proof, projected);
    if (outcome.result === "written") projected[`weight.${proof.day}`] = { lb: proof.lb, at: proof.at };
    return { ...proof, ...outcome };
  });
}
