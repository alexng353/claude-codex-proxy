import { refreshCorpusInBackground } from "./prediction-refresh";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { refuseLocal } from "./pins";
import { PredictionService } from "./predictions";
import {
  preparePrediction,
  guardPredictionReply,
} from "./prediction-preparation";
import {
  generatePrediction,
  prewarmPredictionModel,
  type PredictionModelMetrics,
  type PredictionTokens,
} from "./prediction-model";
import {
  forkPrediction,
  predictionSource,
  type ForkOutcome,
  type PredictionSource,
} from "./prediction-fork";

export const predictionIndexPath = () =>
  process.env.PREDICTION_INDEX ??
  join(homedir(), ".local/state/today/composer-predictions.sqlite");
export type PredictionTiming = {
  preparationMs: number;
  retrievalMs: number;
  guardMs: number;
  modelMs: number;
  outputGuardMs: number;
  totalMs: number;
};
type PredictionDependencies = {
  prepare: typeof preparePrediction;
  generate: typeof generatePrediction;
  guardReply: typeof guardPredictionReply;
  refresh: () => void;
  source: () => PredictionSource;
  fork: typeof forkPrediction;
};
const productionDependencies: PredictionDependencies = {
  prepare: preparePrediction,
  generate: generatePrediction,
  guardReply: guardPredictionReply,
  refresh: refreshCorpusInBackground,
  source: predictionSource,
  fork: forkPrediction,
};

/** Time kept back from a fork so a failed one still leaves Haiku its p90 (5.4 s on Forge). */
const HAIKU_RESERVE_MS = 5_500;

/** How an attempt was answered, for its usage line. Never the text. */
export type PredictionAttempt = {
  source: PredictionSource;
  /** Why the fork did not answer, when Haiku did instead. */
  fallback?: string;
  forkMs?: number;
  fork?: ForkOutcome["usage"];
  forkAccount?: string;
  forkUnmeteredContextTokens?: number;
  haiku?: PredictionTokens;
};
/** Each admitted request's record, by an id only that request knows: a duplicate the
 * service skipped never runs, so it can neither make nor take one. */
const attempts = new Map<string, PredictionAttempt>();
function takeAttempt(id: string): PredictionAttempt | undefined {
  const attempt = attempts.get(id);
  attempts.delete(id);
  return attempt;
}
/** Single guarded model boundary for production and the paired holdout. Raw fields
 * are checked in an isolated worker before formatting; outputs are checked too. */
export async function guardedModelPrediction(
  context: string,
  examples: unknown[] | undefined,
  signal: AbortSignal,
  deadlineMs: number,
  onTiming?: (timing: PredictionTiming) => void,
  dependencies: PredictionDependencies = productionDependencies,
  onModel?: (metrics: PredictionModelMetrics) => void,
): Promise<string | null> {
  const started = Date.now();
  const prepared = await dependencies.prepare(
    context,
    examples,
    signal,
    deadlineMs,
  );
  signal.throwIfAborted();
  const modelStart = Date.now();
  if (!prepared.prompt) return null;
  const reply = (
    await dependencies.generate(prepared.prompt, signal, onModel, deadlineMs)
  ).trim();
  signal.throwIfAborted();
  const guardStart = Date.now();
  const safe =
    reply.length > 0 &&
    reply.length <= 500 &&
    !reply.includes("\n") &&
    (await dependencies.guardReply(reply, signal));
  signal.throwIfAborted();
  onTiming?.({
    preparationMs: modelStart - started,
    retrievalMs: prepared.retrievalMs,
    guardMs: prepared.guardMs,
    modelMs: guardStart - modelStart,
    outputGuardMs: Date.now() - guardStart,
    totalMs: Date.now() - started,
  });
  return safe ? reply : null;
}
let service: PredictionService | undefined;
function localService(): PredictionService {
  if (service) return service;
  prewarmPredictionModel();
  const root = dirname(predictionIndexPath());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "prediction-attempts.sqlite");
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec(
    "CREATE TABLE IF NOT EXISTS prediction_attempts (key TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)",
  );
  service = createPredictionService(
    productionDependencies,
    (key) =>
      db
        .query("INSERT OR IGNORE INTO prediction_attempts VALUES (?,?)")
        .run(key, Date.now()).changes > 0,
  );

  return service;
}
/** Production and route fixtures use the same admission and guarded-call path.
 * Dependencies replace only expensive boundaries, never route/service logic. */
export function createPredictionService(
  dependencies: PredictionDependencies = productionDependencies,
  claim?: (key: string) => boolean,
): PredictionService {
  // This mode delegates all raw-field checks to the isolated guarded boundary;
  // the legacy constructor callbacks are used only by the service unit fixtures.
  return new PredictionService(
    async () => "",
    (text) => text,
    () => [],
    claim,
    async (input, signal) => {
      if (input.corpusEnabled === true) dependencies.refresh();
      const attempt: PredictionAttempt = { source: "haiku" };
      if (typeof input.attemptId === "string") {
        attempts.set(input.attemptId, attempt);
        if (attempts.size > 64) attempts.delete(attempts.keys().next().value!);
      }
      if (dependencies.source() === "fork") {
        if (typeof input.engineThreadId !== "string") attempt.fallback = "no engine thread";
        else {
          const started = Date.now();
          const outcome = await dependencies.fork(
            input.engineThreadId,
            signal,
            input.deadlineMs! - HAIKU_RESERVE_MS,
            input.lastAnswerSha256,
          );
          attempt.forkMs = Date.now() - started;
          attempt.fork = outcome.usage;
          attempt.forkAccount = outcome.account;
          // Recorded before the abort check, so a cancelled fork is logged as one.
          if (outcome.kind === "failed") {
            attempt.fallback = outcome.reason;
            attempt.forkUnmeteredContextTokens = outcome.unmeteredContextTokens;
          }
          // The signal also fires at the deadline: only the caller's abort is a cancel.
          if (signal.aborted) attempt.fallback ??= Date.now() >= input.deadlineMs! ? "timed out" : "cancelled";
          signal.throwIfAborted();
          if (outcome.kind === "declined") {
            attempt.source = "fork";
            return null;
          }
          if (outcome.kind === "suggested") {
            if (await dependencies.guardReply(outcome.text, signal)) {
              attempt.source = "fork";
              return outcome.text;
            }
            attempt.fallback = "unsafe text";
          }
        }
      }
      return guardedModelPrediction(
        input.context,
        input.corpusEnabled === true ? undefined : [],
        signal,
        input.deadlineMs!,
        undefined,
        dependencies,
        (metrics) => {
          attempt.haiku = metrics.tokens;
        },
      );
    },
  );
}
export async function handlePredictionRoute(
  request: Request,
  url: URL,
  peer?: string,
  engine?: PredictionService,
): Promise<Response | undefined> {
  if (url.pathname !== "/composer-predictions") return undefined;
  const refused = refuseLocal(request, url, peer, "Composer predictions");
  if (refused) return refused;
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const started = Date.now();
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 64000)
      return new Response(null, { status: 413 });
    let text = "";
    const decoder = new TextDecoder();
    if (!request.body) return new Response(null, { status: 400 });
    for await (const chunk of request.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 64000) return new Response(null, { status: 413 });
    }
    text += decoder.decode();
    const value = JSON.parse(text);
    // This request's own key for its usage record (see `attempts`).
    const attemptId = crypto.randomUUID();
    const withAttempt =
      value && typeof value === "object" && !Array.isArray(value) ? { ...value, attemptId } : value;
    const disconnected = new AbortController();
    const signal = AbortSignal.any([request.signal, disconnected.signal]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(" "));
        // Returning the response immediately makes Bun own the stream lifetime;
        // request.signal alone does not observe disconnects while fetch awaits.
        void (engine ?? localService())
          .predict(withAttempt, signal)
          .then((prediction) => {
            const attempt = takeAttempt(attemptId);
            appendFileSync(
              join(dirname(predictionIndexPath()), "prediction-usage.jsonl"),
              JSON.stringify({
                at: Date.now(),
                kind: "composer_prediction",
                // Ids only, so the trial can join Today's accepted line: never text.
                ...(typeof value?.threadId === "string" ? { threadId: value.threadId } : {}),
                ...(typeof value?.turnId === "string" ? { turnId: value.turnId } : {}),
                // Which model answered: the chat's own (fork) or Haiku; skipped when the
                // service refused the request (a duplicate, busy, or invalid).
                model: attempt ? attempt.source : "skipped",
                ...(attempt?.fallback ? { fallback: attempt.fallback } : {}),
                ...(attempt?.forkMs !== undefined ? { forkMs: attempt.forkMs } : {}),
                ...(attempt?.fork ? { forkUsage: attempt.fork } : {}),
                ...(attempt?.forkAccount ? { forkAccount: attempt.forkAccount } : {}),
                ...(attempt?.forkUnmeteredContextTokens !== undefined
                  ? { forkUnmeteredContextTokens: attempt.forkUnmeteredContextTokens }
                  : {}),
                ...(attempt?.haiku ? { haikuUsage: attempt.haiku } : {}),
                elapsedMs: Date.now() - started,
                suggested: prediction !== null,
                cancelled: signal.aborted,
              }) + "\n",
              { mode: 0o600 },
            );
            if (!signal.aborted) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ prediction, source: attempt?.source ?? "skipped" }),
                ),
              );
              controller.close();
            }
          })
          .catch(() => {
            if (!signal.aborted)
              controller.error(new Error("prediction failed"));
          });
      },
      cancel() {
        disconnected.abort();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return Response.json({ prediction: null });
  }
}
