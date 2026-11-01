import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PredictionCorpus } from "../src/prediction-corpus";

test("only proven Alex messages enter the corpus, and held-out replies never become examples", () => {
  const corpus = new PredictionCorpus(new Database(":memory:"), (text) =>
    text.includes("SECRET") ? "[REDACTED]" : text,
  );
  const events = [
    {
      id: "a",
      thread_id: "chat",
      seq: 1,
      at_ms: 1,
      actor: "engine:codex",
      type: "item",
      role: { kind: "agent" },
      text: "the tests pass",
    },
    ...["today-gpui", "mcp", "script:timer", "phone"].map((client, i) => ({
      id: "u" + i,
      thread_id: "chat",
      seq: i + 2,
      at_ms: i + 2,
      actor: "me",
      type: "user_message",
      client,
      text: "ship " + i,
    })),
    {
      id: "secret",
      thread_id: "chat",
      seq: 6,
      at_ms: 6,
      actor: "me",
      type: "user_message",
      client: "phone",
      text: "SECRET",
    },
    {
      id: "envelope",
      thread_id: "chat",
      seq: 7,
      at_ms: 7,
      actor: "me",
      type: "user_message",
      client: "phone",
      text: "<codex_delegation>do work",
    },
  ];
  corpus.ingest("arch", events);
  expect(corpus.count()).toBe(2);
  corpus.ingest("arch", events);
  expect(corpus.count()).toBe(2);
  expect(corpus.holdout(1).map((x) => x.reply)).toEqual(["ship 3"]);
  expect(corpus.examples("the tests pass", 1).map((x) => x.reply)).toEqual([
    "ship 0",
  ]);
});

test("accepted predictions and edited mixtures never enter the human corpus", () => {
  const corpus = new PredictionCorpus(new Database(":memory:"), (text) => text);
  corpus.ingest("arch", [
    {
      id: "generated",
      thread_id: "chat",
      seq: 1,
      at_ms: 1,
      actor: "me",
      type: "user_message",
      client: "today-gpui",
      text: "show me the diff",
      generated_origin: true,
    },
    {
      id: "mixed",
      thread_id: "chat",
      seq: 2,
      at_ms: 2,
      actor: "me",
      type: "user_message",
      client: "phone",
      text: "show me the diff please",
      generated_origin: true,
    },
    {
      id: "typed",
      thread_id: "chat",
      seq: 3,
      at_ms: 3,
      actor: "me",
      type: "user_message",
      client: "phone",
      text: "my own question",
    },
  ]);
  expect(corpus.count()).toBe(1);
  expect(corpus.cursor("arch", "chat")).toBe(3);
});

test("historical machine transcript envelopes without origin never enter the corpus", () => {
  const corpus = new PredictionCorpus(new Database(":memory:"), (text) => text);
  const texts = [
    "[Fork reconciliation] While forge was unreachable, Alex continued this thread",
    "[Side prompt] While you worked, Alex asked a few things on the side.",
    "<fork_conversation>transcript</fork_conversation>",
    "<side_conversation>transcript</side_conversation>",
    "Produce the catch-up summary from the supplied snapshot. Answer only; use no tools.",
  ];
  corpus.ingest(
    "arch",
    [...texts, "please explain fork reconciliation"].map((text, i) => ({
      id: String(i),
      thread_id: "chat",
      seq: i + 1,
      at_ms: i + 1,
      actor: "me",
      type: "user_message",
      client: "phone",
      text,
    })),
  );
  expect(corpus.count()).toBe(1);
  expect(corpus.cursor("arch", "chat")).toBe(6);
});

test.each(["holdout", "examples"])(
  "%s rejects historical envelopes already persisted before filtering",
  (mode) => {
    const db = new Database(":memory:");
    const corpus = new PredictionCorpus(db, (text) => text);
    const replies = [
      "please show me the patch",
      "[Fork reconciliation] While forge was unreachable, Alex continued this thread",
      "[Side prompt] While you worked, Alex asked a few things on the side.",
      "<fork_conversation>transcript</fork_conversation>",
      "<side_conversation>transcript</side_conversation>",
      "Produce the catch-up summary from the supplied snapshot. Answer only; use no tools.",
    ];
    for (const [i, reply] of replies.entries()) {
      db.query("INSERT INTO replies VALUES (?,?,?,?,?,?)").run(
        String(i),
        "arch",
        "chat",
        i + 1,
        "the patch is ready",
        reply,
      );
      db.query("INSERT INTO contexts VALUES (?,?)").run(
        String(i),
        "the patch is ready",
      );
    }
    const found =
      mode === "holdout"
        ? corpus.holdout(1)
        : corpus.examples("the patch is ready", 0);
    expect(found.map((row) => row.reply)).toEqual([replies[0]]);
    expect(corpus.holdout(0)).toEqual([]);
    db.close();
  },
);

test("examples scan beyond legacy excluded rows to fill four safe replies", () => {
  const db = new Database(":memory:");
  const corpus = new PredictionCorpus(db, (text) => text);
  for (let i = 0; i < 34; i++) {
    const reply =
      i < 4
        ? "typed reply " + i
        : "[Side prompt] While you worked, Alex asked a few things on the side.";
    db.query("INSERT INTO replies VALUES (?,?,?,?,?,?)").run(
      String(i),
      "arch",
      "chat",
      i + 1,
      "the patch is ready",
      reply,
    );
    db.query("INSERT INTO contexts VALUES (?,?)").run(
      String(i),
      "the patch is ready",
    );
  }
  const expected = [
    "typed reply 3",
    "typed reply 2",
    "typed reply 1",
    "typed reply 0",
  ];
  expect(
    corpus.examples("the patch is ready", 0).map((row) => row.reply),
  ).toEqual(expected);
  expect(
    corpus.examples("the patch is ready", 0).map((row) => row.reply),
  ).toEqual(expected);
  db.close();
});
