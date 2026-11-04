/** Read-only evidence that the repair attached to a gate fault exists or has closed. */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export type FixRef =
  | { kind: "q"; id: string }
  | { kind: "chat"; id: string; eta: string; task?: number };
export type FixStatus =
  | "open"
  | "closed"
  | "missing"
  | "unavailable"
  | "ambiguous"
  | "awaiting_receipt";
const TERMINAL = new Set(["done", "cancelled"]);

/** For chat references without a task, pins the unique open ledger record in ref.task. */
export function readFixStatus(ref: FixRef): FixStatus {
  let db: Database | undefined;
  try {
    db = new Database(
      ref.kind === "q"
        ? (process.env.HYGIENE_QUEUE_DB ??
            join(homedir(), ".local/state/today-ops/queue.sqlite"))
        : (process.env.HYGIENE_TASK_DB ??
            join(homedir(), ".local/state/today/daemon.sqlite")),
      { readonly: true },
    );
    if (ref.kind === "q") {
      const row = db
        .query("SELECT state FROM items WHERE id = ?")
        .get(ref.id) as { state: string } | null;
      if (!row) return "missing";
      return TERMINAL.has(row.state) ? "closed" : "open";
    }
    const rows = (
      ref.task === undefined
        ? db
            .query(
              "SELECT n, status, receipt FROM tasks WHERE target = ? AND status NOT IN ('done','cancelled') ORDER BY n DESC LIMIT 2",
            )
            .all(ref.id)
        : db
            .query(
              "SELECT n, status, receipt FROM tasks WHERE target = ? AND n = ?",
            )
            .all(ref.id, ref.task)
    ) as Array<{ n: number; status: string; receipt: string | null }>;
    if (rows.length > 1) return "ambiguous";
    const row = rows[0];
    if (!row) return "missing";
    ref.task = row.n; // Pin the record so another task in the same chat cannot close this repair.
    const receipt = row.receipt ? JSON.parse(row.receipt) : null;
    if (row.status === "cancelled") return "closed";
    if (TERMINAL.has(row.status))
      return receipt ? "closed" : "awaiting_receipt";
    return "open";
  } catch {
    return "unavailable";
  } finally {
    db?.close();
  }
}
