import { historicalGeneratedEnvelope } from "./prediction-provenance";
import { Database } from "bun:sqlite";

export type Example = {
  id: string;
  context: string;
  reply: string;
  at_ms: number;
};
type Event = {
  id: string;
  thread_id: string;
  seq: number;
  at_ms: number;
  actor: string;
  type: string;
  client?: string;
  generated_origin?: boolean;
  text?: string;
  role?: { kind: string };
};

function alex(event: Event): boolean {
  const client = event.client ?? "";
  return (
    event.type === "user_message" &&
    event.generated_origin !== true &&
    !historicalGeneratedEnvelope(event.text ?? "") &&
    event.actor === "me" &&
    (client === "today-gpui" ||
      client.startsWith("today-gpui@") ||
      ["phone", "email", "plate", "jarvis"].includes(client)) &&
    !/<(?:codex_delegation|system-reminder|automation)[\s>]/i.test(
      event.text ?? "",
    )
  );
}

/** A private derivative index. Source databases are never opened for writing. */
export class PredictionCorpus {
  constructor(
    private db: Database,
    private scrub: (text: string) => string,
    initialize = true,
  ) {
    if (!initialize) return;
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, thread TEXT NOT NULL,
      at_ms INTEGER NOT NULL, context TEXT NOT NULL, reply TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reply_time ON replies(at_ms);
      CREATE TABLE IF NOT EXISTS cursors (
        source TEXT NOT NULL, thread TEXT NOT NULL, seq INTEGER NOT NULL,
        context TEXT NOT NULL, PRIMARY KEY(source,thread));
      CREATE VIRTUAL TABLE IF NOT EXISTS contexts USING fts5(id UNINDEXED, context);`);
  }
  private safe(text: string): boolean {
    return (
      text.length > 0 &&
      text.length <= 64000 &&
      this.scrub(text) === text &&
      !/\[REDACTED[:\]]/i.test(text)
    );
  }
  cursor(source: string, thread: string): number {
    return (
      (
        this.db
          .query("SELECT seq FROM cursors WHERE source=? AND thread=?")
          .get(source, thread) as { seq: number } | null
      )?.seq ?? 0
    );
  }
  ingest(source: string, raw: unknown[]): void {
    this.db.transaction(() => {
      for (const event of raw as Event[]) {
        const previous = this.db
          .query("SELECT seq,context FROM cursors WHERE source=? AND thread=?")
          .get(source, event.thread_id) as {
          seq: number;
          context: string;
        } | null;
        if (event.seq <= (previous?.seq ?? 0)) continue;
        let context = previous?.context ?? "";
        if (event.type === "item" && event.role?.kind === "agent") {
          context = this.safe(event.text ?? "") ? event.text! : "";
        }
        if (alex(event) && this.safe(event.text ?? "")) {
          const added = this.db
            .query("INSERT OR IGNORE INTO replies VALUES (?,?,?,?,?,?)")
            .run(
              event.id,
              source,
              event.thread_id,
              event.at_ms,
              context,
              event.text!,
            ).changes;
          if (added)
            this.db
              .query("INSERT INTO contexts VALUES (?,?)")
              .run(event.id, context);
        }
        this.db
          .query("INSERT OR REPLACE INTO cursors VALUES (?,?,?,?)")
          .run(source, event.thread_id, event.seq, context);
      }
    })();
  }
  count(): number {
    return (
      this.db.query("SELECT count(*) AS n FROM replies").get() as { n: number }
    ).n;
  }
  holdout(n: number): Example[] {
    if (n <= 0) return [];
    const result: Example[] = [];
    // Old derivative databases may predate ingestion filters. Filter before
    // counting the limit so excluded rows cannot displace safe holdout replies.
    const statement = this.db.prepare(
      "SELECT id,context,reply,at_ms FROM replies WHERE context <> '' ORDER BY at_ms DESC,id DESC",
    );
    try {
      for (const row of statement.iterate() as Iterable<Example>) {
        if (historicalGeneratedEnvelope(row.reply)) continue;
        result.push(row);
        if (result.length >= n) break;
      }
    } finally {
      statement.finalize();
    }
    return result;
  }

  examples(
    context: string,
    holdout = 200,
    before = Number.MAX_SAFE_INTEGER,
  ): Example[] {
    const held = this.holdout(holdout);
    const cutoff = Math.min(before, ...held.map((row) => row.at_ms));
    const words = [
      ...new Set(context.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []),
    ].slice(0, 40);
    if (!words.length) return [];
    const query = words.map((word) => '"' + word + '"').join(" OR ");
    const statement = this.db.prepare(
      `SELECT r.id,r.context,r.reply,r.at_ms FROM contexts f
       JOIN replies r ON r.id=f.id WHERE contexts MATCH ? AND r.at_ms < ?
       ORDER BY bm25(contexts),r.at_ms DESC`,
    );
    const result: Example[] = [];
    try {
      // A legacy index can contain arbitrarily many excluded rows ahead of
      // safe examples. Stop after four accepted rows, not four scanned rows.
      for (const row of statement.iterate(query, cutoff) as Iterable<Example>) {
        if (
          historicalGeneratedEnvelope(row.reply) ||
          held.some((test) => test.reply === row.reply)
        )
          continue;
        result.push(row);
        if (result.length === 4) break;
      }
    } finally {
      statement.finalize();
    }
    return result;
  }

  /** Stream in bounded pages so a long chat cannot stall the prediction path. */
  refreshToday(source: string, path: string): number {
    const input = new Database(path, { readonly: true });
    const start = this.count();
    try {
      const threads = input.query("SELECT thread_id FROM threads").all() as {
        thread_id: string;
      }[];
      for (const { thread_id } of threads) {
        for (;;) {
          const rows = input
            .query(
              `SELECT id,thread_id,seq,at_ms,actor,body FROM events
            WHERE thread_id=? AND seq>? ORDER BY seq LIMIT 500`,
            )
            .all(thread_id, this.cursor(source, thread_id)) as (Event & {
            body: string;
          })[];
          if (!rows.length) break;
          this.ingest(
            source,
            rows.map(({ body, ...row }) => ({ ...JSON.parse(body), ...row })),
          );
        }
      }
      return this.count() - start;
    } finally {
      input.close();
    }
  }
}
