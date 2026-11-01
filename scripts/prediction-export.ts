import { historicalGeneratedEnvelope } from "../src/prediction-provenance";
// Run on the source machine. Only scrubbed message text leaves over local SSH.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { createScrubber } from "../src/scrub.mjs";
const db = new Database(
  process.argv[2] ?? join(homedir(), ".local/state/today/daemon.sqlite"),
  { readonly: true },
);
const cursors = JSON.parse(await Bun.stdin.text()) as Record<string, number>;
const scrubber = createScrubber();
try {
  const threads = db.query("SELECT thread_id FROM threads").all() as {
    thread_id: string;
  }[];
  for (const { thread_id } of threads) {
    const rows = db
      .query(
        "SELECT id,seq,at_ms,actor,body FROM events WHERE thread_id=? AND seq>? ORDER BY seq",
      )
      .iterate(thread_id, cursors[thread_id] ?? 0) as Iterable<{
      id: string;
      seq: number;
      at_ms: number;
      actor: string;
      body: string;
    }>;
    let last:
      { id: string; seq: number; at_ms: number; actor: string } | undefined;
    for (const { body, ...row } of rows) {
      last = row;
      const event = JSON.parse(body);
      if (
        event.type !== "user_message" &&
        !(event.type === "item" && event.role?.kind === "agent")
      )
        continue;
      const generatedOrigin =
        event.generated_origin === true ||
        (event.type === "user_message" &&
          typeof event.text === "string" &&
          historicalGeneratedEnvelope(event.text));
      const text =
        !generatedOrigin &&
        typeof event.text === "string" &&
        event.text.length <= 64000 &&
        scrubber.scrub(event.text) === event.text
          ? event.text
          : "";
      process.stdout.write(
        JSON.stringify({
          ...row,
          thread_id,
          type: event.type,
          role: event.role,
          client: event.client,
          generated_origin: generatedOrigin,
          text,
        }) + "\n",
      );
    }
    if (last)
      process.stdout.write(
        JSON.stringify({ ...last, thread_id, type: "cursor" }) + "\n",
      );
  }
} finally {
  db.close();
}
// Legacy Cairn outbox: use immutable operations whose actor is me, not mirrored
// transcript roles or an item's current body, which an agent could have edited.
const cairnPath = join(homedir(), ".local/share/plate/cairn.sqlite");
if (await Bun.file(cairnPath).exists()) {
  const cairn = new Database(cairnPath, { readonly: true });
  try {
    const rows = cairn
      .query(
        `SELECT o.id,o.rowid AS n,o.hlc,o.body,i.url
      FROM oplog o JOIN items i ON i.id=o.entity_id
      WHERE o.actor='me' AND i.owner='me' AND i.created_by='me'
        AND i.section='codexchat-out' AND json_type(o.body,'$.set.body')='text'
      ORDER BY o.rowid`,
      )
      .all() as {
      id: string;
      n: number;
      hlc: string;
      body: string;
      url: string;
    }[];
    for (const row of rows) {
      const thread_id = "cairn:" + row.url;
      const seq = row.n * 2;
      if (seq <= (cursors[thread_id] ?? 0)) continue;
      const operation = JSON.parse(row.body).set;
      const text = operation.body as string;
      // Inspect the immutable send operation, never a subsequently edited item.
      const generatedOrigin =
        historicalGeneratedEnvelope(text) ||
        (Array.isArray(operation.facts) &&
          operation.facts.includes("generated_origin=true"));
      const at_ms = Number(row.hlc.split("-")[0]);
      const at = new Date(at_ms).toISOString();
      const previous = cairn
        .query(
          `SELECT body FROM items WHERE owner='source'
        AND source='codexchat' AND url=? AND title='agent'
        AND COALESCE(end_at,start_at,source_updated_at,created_at) < ?
        ORDER BY COALESCE(end_at,start_at,source_updated_at,created_at) DESC LIMIT 1`,
        )
        .get(row.url, at) as { body: string } | null;
      const context = previous?.body ?? "";
      process.stdout.write(
        JSON.stringify({
          id: "cairn-context:" + row.id,
          thread_id,
          seq: seq - 1,
          at_ms,
          actor: "engine:import",
          type: "item",
          role: { kind: "agent" },
          text:
            context.length <= 64000 && scrubber.scrub(context) === context
              ? context
              : "",
        }) + "\n",
      );
      process.stdout.write(
        JSON.stringify({
          id: "cairn:" + row.id,
          thread_id,
          seq,
          at_ms,
          actor: "me",
          type: "user_message",
          client: "phone",
          generated_origin: generatedOrigin,
          // Retain the sequence for incremental refresh without exporting generated prose.
          text:
            !generatedOrigin &&
            text.length <= 64000 &&
            scrubber.scrub(text) === text
              ? text
              : "",
        }) + "\n",
      );
    }
  } finally {
    cairn.close();
  }
}
