import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PredictionCorpus } from "../src/prediction-corpus";
import { createScrubber } from "../src/scrub.mjs";
import {
  guardedModelPrediction,
  predictionIndexPath,
} from "../src/prediction-route";
import {
  prewarmPredictionModel,
  closePredictionModel,
} from "../src/prediction-model";
import { closePredictionPreparation } from "../src/prediction-preparation";

const out =
  process.env.PREDICTION_EVAL_OUTPUT ??
  join(homedir(), ".cache/composer-predictions/eval.jsonl");
const scrubber = createScrubber();
const db = new Database(predictionIndexPath());
const corpus = new PredictionCorpus(db, (text) => scrubber.scrub(text));
// Freeze all 200 targets and the training cutoff before any call, never a rolling split.
const held = corpus.holdout(200);
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const row = JSON.parse(line);
          return row.id + ":" + row.fewShot;
        })
    : [],
);
function normalized(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)),
      );
    row = next;
  }
  return row[b.length];
}
prewarmPredictionModel();
for (const target of held) {
  await Promise.all(
    [false, true].map(async (fewShot) => {
      if (done.has(target.id + ":" + fewShot)) return;
      const started = Date.now();
      const examples = fewShot
        ? corpus.examples(target.context, 200, target.at_ms)
        : [];
      const retrievalMs = Date.now() - started;
      let timing: unknown;
      let prediction = "",
        failure = false;
      if (target.context && scrubber.scrub(target.context) === target.context) {
        try {
          prediction =
            (await guardedModelPrediction(
              target.context,
              examples,
              AbortSignal.timeout(12000),
              started + 12000,
              (value) => {
                timing = value;
              },
            )) ?? "";
        } catch {
          failure = true;
        }
      }
      if (scrubber.scrub(prediction) !== prediction) {
        prediction = "";
        failure = true;
      }
      const expected = normalized(target.reply),
        actual = normalized(prediction);
      const exact = !!actual && actual === expected;
      const similarity =
        actual && expected && Math.max(actual.length, expected.length) <= 4000
          ? 1 -
            distance(actual, expected) /
              Math.max(actual.length, expected.length)
          : 0;
      // This lexical proxy is reported as such; it does not claim Alex accepted it.
      const near =
        exact || (actual.split(" ").length >= 3 && similarity >= 0.8);
      appendFileSync(
        out,
        JSON.stringify({
          id: target.id,
          fewShot,
          exact,
          near,
          similarity,
          failure,
          suggested: !!prediction,
          contextAvailable: !!target.context,
          examples: examples.length,
          elapsedMs: Date.now() - started,
          retrievalMs,
          timing,
          prediction,
          expected: target.reply,
        }) + "\n",
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          completed: done.size + 1,
          total: held.length * 2,
          fewShot,
          exact,
          near,
          failure,
        }),
      );
      done.add(target.id + ":" + fewShot);
    }),
  );
}
const rows = readFileSync(out, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const summary = [false, true].map((fewShot) => {
  const group = rows.filter((row) => row.fewShot === fewShot);
  return {
    fewShot,
    n: group.length,
    exact: group.filter((row) => row.exact).length,
    near: group.filter((row) => row.near).length,
    failures: group.filter((row) => row.failure).length,
    noContext: group.filter((row) => !row.contextAvailable).length,
    failureRate: group.filter((row) => row.failure).length / group.length,
    p50Ms: group.map((row) => row.elapsedMs).sort((a, b) => a - b)[
      Math.ceil(group.length * 0.5) - 1
    ],
    p90Ms: group.map((row) => row.elapsedMs).sort((a, b) => a - b)[
      Math.ceil(group.length * 0.9) - 1
    ],
    meanLatencyMs: Math.round(
      group.reduce((n, row) => n + row.elapsedMs, 0) / group.length,
    ),
  };
});
writeFileSync(
  out + ".summary.json",
  JSON.stringify(
    {
      corpus: corpus.count(),
      heldout: held.length,
      metric:
        "Normalized exact match; near = exact or at least 3 words with normalized Levenshtein similarity >= 0.8. Lexical proxy, not human acceptance.",
      summary,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
db.close();
await closePredictionModel();
closePredictionPreparation();
