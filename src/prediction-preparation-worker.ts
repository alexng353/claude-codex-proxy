import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { createScrubber } from "./scrub.mjs";
import { PredictionCorpus } from "./prediction-corpus";
import { predictionPrompt, safePredictionExamples } from "./predictions";
import type { PreparationJob } from "./prediction-preparation";

const scrubber = createScrubber();
const scrub = (text: string) => scrubber.scrub(text);
const postMessage = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const prepare = (job: PreparationJob) => {
  try {
    const guardStart = performance.now();
    if (job.kind === "reply") {
      postMessage({
        value:
          job.reply.length > 0 &&
          job.reply.length <= 500 &&
          !job.reply.includes("\n") &&
          scrub(job.reply) === job.reply,
      });
      return;
    }
    if (scrub(job.context) !== job.context) {
      postMessage({
        value: {
          prompt: null,
          retrievalMs: 0,
          guardMs: performance.now() - guardStart,
        },
      });
      return;
    }
    let guardMs = performance.now() - guardStart;
    let examples = job.examples;
    let retrievalMs = 0;
    if (examples === undefined) {
      const start = performance.now();
      try {
        const db = new Database(
          process.env.PREDICTION_INDEX ??
            join(homedir(), ".local/state/today/composer-predictions.sqlite"),
          { readonly: true },
        );
        try {
          examples = new PredictionCorpus(db, scrub, false).examples(
            job.context,
            0,
          );
        } finally {
          db.close();
        }
      } catch {
        examples = [];
      }
      retrievalMs = performance.now() - start;
    }
    const examplesStart = performance.now();
    const safe = safePredictionExamples(examples, scrub);
    guardMs += performance.now() - examplesStart;
    postMessage({
      value: {
        prompt: predictionPrompt(job.context, safe),
        retrievalMs,
        guardMs,
      },
    });
  } catch {
    postMessage({ error: true });
  }
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 1000000) process.exit(1);
  let end: number;
  while ((end = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    try {
      prepare(JSON.parse(line) as PreparationJob);
    } catch {
      postMessage({ error: true });
    }
  }
});
