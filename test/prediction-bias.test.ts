/**
 * Composer predictions model Alex, not the assistant (q prediction-bias, Nov 2026).
 * Bubble ended a turn on "Bed by midnight" and was offered "ok sounds good gn";
 * Alex sends a bare ack about 1 time in 100.
 * Only symbols that predate the fix are imported, so on main these fail by behaviour.
 */
import { expect, test } from "bun:test";
import { PredictionModelPool } from "../src/prediction-model";
import { parsePrediction } from "../src/predictions";

const closingAsk =
  "Alex: the x for goal tab is not pinned to the right\n\n" +
  "Assistant: Logged it for the pane batch, due Fri at 18:00.\n\nShower, send me your shower and teeth photos, then bed. Bed by midnight.";

const service = async (source: "fork" | "haiku", forkText: string, haikuText: string) => {
  const { createPredictionService } = await import("../src/prediction-route");
  const calls: string[] = [];
  const engine = createPredictionService({
    prepare: async () => ({ prompt: "haiku prompt", retrievalMs: 0, guardMs: 0 }),
    generate: async () => (calls.push("haiku"), haikuText),
    guardReply: async () => true,
    refresh: () => {},
    source: () => source,
    fork: async () => (calls.push("fork"), { kind: "suggested", text: forkText }),
  } as never);
  return { engine, calls };
};
const input = (turn: string) => ({ threadId: "bubble", turnId: turn, context: closingAsk, engineThreadId: "e" });

test("a turn ending on a closing ask never yields a bare ack, from the fork or from Haiku", async () => {
  for (const ack of ["ok sounds good gn", "Sounds good, thanks!", "gn bubble 🌙", "yes do it", "ok"]) {
    const fork = await service("fork", ack, "never asked");
    expect(await fork.engine.predict(input("1"))).toBeNull();
    // Screened, not failed: no Haiku call with the same pull toward agreeing.
    expect(fork.calls).toEqual(["fork"]);
    const haiku = await service("haiku", "unused", ack);
    expect(await haiku.engine.predict(input("2"))).toBeNull();
  }
  const real = await service("fork", "also the goal tab x still isnt pinned", "unused");
  expect(await real.engine.predict(input("3"))).toBe("also the goal tab x still isnt pinned");
});

test("low confidence yields no prediction", async () => {
  expect(parsePrediction('{"prediction":"why is gym paused today","confidence":0.2}')).toBeNull();
  // A model that states no confidence has not said the guess is likely.
  expect(parsePrediction('{"prediction":"why is gym paused today"}')).toBeNull();
  expect(parsePrediction('{"prediction":"why is gym paused today","confidence":0.7}')).toBe("why is gym paused today");
  // End to end through the Haiku worker: an unsure guess reaches the route as nothing.
  const worker = (confidence: number) => `
console.log(JSON.stringify({type:"system", subtype:"init"}));
for await (const chunk of Bun.stdin.stream()) {
 console.log(JSON.stringify({type:"result", result:JSON.stringify({prediction:"why is gym paused", confidence:${confidence}})}));
}`;
  const run = async (confidence: number) => {
    const pool = new PredictionModelPool(() =>
      Bun.spawn([process.execPath, "-e", worker(confidence)], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }),
    );
    const metrics: Record<string, unknown>[] = [];
    const text = await pool.generate("prompt", undefined, (m) => metrics.push(m as never));
    await pool.close();
    return { text, lowConfidence: metrics[0]?.lowConfidence };
  };
  // The unsure guess is held back, and the worker says so for the usage line.
  expect(await run(0.1)).toEqual({ text: "", lowConfidence: true });
  expect(await run(0.7)).toEqual({ text: "why is gym paused", lowConfidence: undefined });
});

test("a screened suggestion is logged as screened, by why, never by text", async () => {
  const { createPredictionService, takeAttemptForTest } = await import("../src/prediction-route");
  const make = (source: "fork" | "haiku", generate: () => string, metrics?: Record<string, unknown>) =>
    createPredictionService({
      prepare: async () => ({ prompt: "haiku prompt", retrievalMs: 0, guardMs: 0 }),
      generate: async (_p: string, _s: AbortSignal, onModel?: (m: unknown) => void) => {
        onModel?.({ warm: true, spawnMs: 0, modelMs: 0, totalMs: 0, ...metrics });
        return generate();
      },
      guardReply: async () => true,
      refresh: () => {},
      source: () => source,
      fork: async () => ({ kind: "suggested", text: "ok sounds good gn" }),
    } as never);
  const attempt = async (engine: ReturnType<typeof make>, id: string) => {
    await engine.predict({ ...input(id), attemptId: id });
    return takeAttemptForTest(id);
  };
  expect(await attempt(make("fork", () => "unused"), "screened-fork")).toMatchObject({ source: "fork", screened: "ack" });
  expect(await attempt(make("haiku", () => "gn bubble"), "screened-haiku")).toMatchObject({ source: "haiku", screened: "ack" });
  expect(await attempt(make("haiku", () => "", { lowConfidence: true }), "unsure-haiku")).toMatchObject({ source: "haiku", screened: "confidence" });
  const shown = await attempt(make("haiku", () => "also the goal tab x"), "shown-haiku");
  expect(shown?.screened).toBeUndefined();
  expect(JSON.stringify(await attempt(make("fork", () => "unused"), "no-text"))).not.toContain("sounds good");
});

test("the usage line says what was screened and why, and never the text", async () => {
  const { createPredictionService, handlePredictionRoute } = await import("../src/prediction-route");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "prediction-screened-"));
  const saved = { index: process.env.PREDICTION_INDEX, key: process.env.PROXY_API_KEY };
  process.env.PREDICTION_INDEX = join(root, "index.sqlite");
  process.env.PROXY_API_KEY = "prediction-screened-test";
  const engine = (source: "fork" | "haiku", haiku: string, metrics: Record<string, unknown> = {}) =>
    createPredictionService({
      prepare: async () => ({ prompt: "p", retrievalMs: 0, guardMs: 0 }),
      generate: async (_p: string, _s: AbortSignal, onModel?: (m: unknown) => void) => {
        onModel?.({ warm: true, spawnMs: 0, modelMs: 0, totalMs: 0, ...metrics });
        return haiku;
      },
      guardReply: async () => true,
      refresh: () => {},
      source: () => source,
      fork: async () => ({ kind: "suggested", text: "ok sounds good gn" }),
    } as never);
  const call = async (service: ReturnType<typeof engine>, turnId: string) => {
    const request = new Request("http://127.0.0.1:3456/composer-predictions", {
      method: "POST",
      body: JSON.stringify({ threadId: "bubble", turnId, context: closingAsk, engineThreadId: "e" }),
      headers: { "content-type": "application/json", authorization: "Bearer prediction-screened-test" },
    });
    return JSON.parse((await (await handlePredictionRoute(request, new URL(request.url), "127.0.0.1", service))!.text()).trim());
  };
  try {
    expect(await call(engine("fork", "unused"), "t1")).toEqual({ prediction: null, source: "fork" });
    expect(await call(engine("haiku", "thanks bubble"), "t2")).toEqual({ prediction: null, source: "haiku" });
    expect(await call(engine("haiku", "", { lowConfidence: true }), "t3")).toEqual({ prediction: null, source: "haiku" });
    const raw = await readFile(join(root, "prediction-usage.jsonl"), "utf8");
    expect(raw).not.toContain("sounds good");
    expect(raw).not.toContain("thanks");
    const [fork, ack, unsure] = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(fork).toMatchObject({ turnId: "t1", model: "fork", screened: "ack", suggested: false });
    expect(ack).toMatchObject({ turnId: "t2", model: "haiku", screened: "ack", suggested: false });
    expect(unsure).toMatchObject({ turnId: "t3", model: "haiku", screened: "confidence", suggested: false });
  } finally {
    if (saved.index === undefined) delete process.env.PREDICTION_INDEX;
    else process.env.PREDICTION_INDEX = saved.index;
    if (saved.key === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = saved.key;
    await rm(root, { recursive: true, force: true });
  }
});
