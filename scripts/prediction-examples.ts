import { safePredictionExamples } from "../src/predictions";
import { Database } from "bun:sqlite";
import { createScrubber } from "../src/scrub.mjs";
import { PredictionCorpus } from "../src/prediction-corpus";
import { predictionIndexPath } from "../src/prediction-route";
const input = JSON.parse(await Bun.stdin.text());
if (typeof input.context !== "string" || input.context.length > 16000)
  process.exit(1);
const scrubber = createScrubber();
if (scrubber.scrub(input.context) !== input.context) process.exit(1);
const db = new Database(predictionIndexPath(), { readonly: true });
try {
  const examples = new PredictionCorpus(
    db,
    (text) => scrubber.scrub(text),
    false,
  ).examples(input.context, 0);
  console.log(
    JSON.stringify(
      (
        safePredictionExamples(examples, (text) =>
          scrubber.scrub(text),
        ) as typeof examples
      ).map((row) => ({
        assistant: row.context.slice(-1000),
        alex: row.reply.slice(0, 300),
      })),
    ),
  );
} finally {
  db.close();
}
