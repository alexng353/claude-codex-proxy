import { expect, test } from "bun:test";
import {
  PredictionService,
  contextMessages,
  isBareAck,
  parsePrediction,
  predictionPrompt,
} from "../src/predictions";

test("a bare ack is only acknowledgement words, so a real message that starts with one survives", () => {
  for (const ack of ["ok sounds good gn", "thanks bubble, going to bed", "makes sense", "yes do it", "Sounds good, thanks!", "ok"])
    expect(isBareAck(ack)).toBe(true);
  for (const real of ["ok so why is gym paused today", "shower and teeth have been sent", "will you do that?", "do i go to bed now?", "will you do that", "ok and the pane thing"])
    expect(isBareAck(real)).toBe(false);
});

test("Haiku sees Alex's own recent messages apart from the answer it would otherwise echo", () => {
  const context =
    "Alex: the x for goal tab is not pinned to the right\n\n" +
    "Assistant: Logged it for the pane batch.\n\nShower, then bed. Bed by midnight.";
  const messages = contextMessages(context);
  expect(messages.map((m) => m.speaker)).toEqual(["Alex", "Assistant"]);
  expect(messages[1]!.text).toContain("\n\nShower");
  const prompt = JSON.parse(predictionPrompt(context, []));
  expect(prompt.alex_recent).toEqual(["the x for goal tab is not pinned to the right"]);
  expect(prompt.last_answer).toStartWith("Logged it");
  expect(prompt.conversation).toBeUndefined();
});

test("one short attempt per completed turn and secrets refused before model", async () => {
  const calls: string[] = [];
  const service = new PredictionService(
    async (prompt) => {
      calls.push(prompt);
      return "show me";
    },
    (text) => (text.includes("SECRET") ? "[REDACTED]" : text),
    () => [],
  );
  const input = { threadId: "a", turnId: "1", context: "the tests pass" };
  expect(await service.predict(input)).toBe("show me");
  expect(await service.predict(input)).toBe(null);
  expect(calls).toHaveLength(1);
  expect(
    await service.predict({ ...input, turnId: "2", context: "SECRET" }),
  ).toBe(null);
  expect(calls).toHaveLength(1);
  expect(
    await service.predict({
      ...input,
      turnId: "3",
      context: "x".repeat(16001),
    }),
  ).toBe(null);
});

test("model JSON fences are parsed, but commentary is never shown as a prediction", () => {
  expect(parsePrediction('```json\n{"prediction":"show me","confidence":0.8}\n```')).toBe(
    "show me",
  );
  expect(parsePrediction('{"prediction":null}')).toBeNull();
  expect(parsePrediction("(empty string - no examples provided)")).toBeNull();
});

test("slow retrieval reserves concurrency and retrieval errors fail closed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  const service = new PredictionService(
    async () => "show me the diff",
    (text) => text,
    async () => {
      lookups++;
      await gate;
      return [];
    },
  );
  const a = service.predict({
    threadId: "a",
    turnId: "1",
    context: "ready",
    corpusEnabled: true,
  });
  const b = service.predict({
    threadId: "b",
    turnId: "1",
    context: "ready",
    corpusEnabled: true,
  });
  const c = service.predict({
    threadId: "c",
    turnId: "1",
    context: "ready",
    corpusEnabled: true,
  });
  expect(lookups).toBe(2);
  release();
  expect(await Promise.all([a, b, c])).toEqual(["show me the diff", "show me the diff", null]);
  const broken = new PredictionService(
    async () => "show me the diff",
    (text) => text,
    async () => {
      throw new Error("offline");
    },
  );
  expect(
    await broken.predict({
      threadId: "a",
      turnId: "1",
      context: "ready",
      corpusEnabled: true,
    }),
  ).toBeNull();
});

test("runtime corpus and benchmark examples share a bounded prompt", () => {
  const context = "old".repeat(10_000) + "latest assistant response";
  const corpus = [
    {
      id: "private-id",
      at_ms: 1,
      context: "a".repeat(10_000),
      reply: "b".repeat(10_000),
    },
  ];
  const evaluation = [{ assistant: corpus[0].context, alex: corpus[0].reply }];
  const prompt = predictionPrompt(context, corpus);
  expect(prompt).toBe(predictionPrompt(context, evaluation));
  expect(prompt.length).toBeLessThan(12_000);
  expect(prompt).not.toContain("private-id");
  expect(JSON.parse(prompt).last_answer).toEndWith(
    "latest assistant response",
  );
});

test("raw secret fields are rejected before JSON escaping or truncation", async () => {
  const secret = "literal\npassword";
  const prompts: string[] = [];
  const service = new PredictionService(
    async (prompt) => {
      prompts.push(prompt);
      return "ok";
    },
    (text) => (text.includes(secret) ? "[REDACTED]" : text),
    () => [{ context: "ready", reply: secret }],
  );
  await service.predict({
    threadId: "raw",
    turnId: "1",
    context: "ready",
    corpusEnabled: true,
  });
  expect(prompts.join("")).not.toContain("literal");
});

test("corpus is opt-in and cancellation consumes the attempt", async () => {
  let lookups = 0;
  let cancelled = false;
  const service = new PredictionService(
    async (_prompt, signal) =>
      new Promise<string>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve("late");
          },
          { once: true },
        );
      }),
    (text) => text,
    () => {
      lookups++;
      return [];
    },
  );
  const controller = new AbortController();
  const input = { threadId: "cancel", turnId: "1", context: "ready" };
  const pending = service.predict(input, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  expect(await pending).toBeNull();
  expect(cancelled).toBe(true);
  expect(lookups).toBe(0);
  expect(await service.predict(input)).toBeNull();
});

test("one absolute deadline cancels retrieval before model execution", async () => {
  let generated = false;
  const service = new PredictionService(
    async () => {
      generated = true;
      return "late";
    },
    (text) => text,
    async (_context, signal) =>
      new Promise<unknown[]>((resolve) => {
        signal?.addEventListener("abort", () => resolve([]), { once: true });
      }),
  );
  const result = await service.predict({
    threadId: "deadline",
    turnId: "1",
    context: "ready",
    corpusEnabled: true,
    deadlineMs: Date.now() + 20,
  });
  expect(result).toBeNull();
  expect(generated).toBe(false);
});

test("a model exception consumes the attempt and cannot retry", async () => {
  let calls = 0;
  const service = new PredictionService(
    async () => {
      calls++;
      if (calls === 1) throw new Error("fake model unavailable");
      return "would expose a retry";
    },
    (text) => text,
    () => [],
  );
  const input = { threadId: "failed-model", turnId: "1", context: "ready" };
  expect(await service.predict(input)).toBeNull();
  expect(await service.predict(input)).toBeNull();
  expect(calls).toBe(1);
});
