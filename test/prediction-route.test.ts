import { expect, test } from "bun:test";
import { handlePredictionRoute } from "../src/prediction-route";

test("prediction route rejects browsers and non-loopback callers before any work", async () => {
  const request = new Request("http://127.0.0.1:3456/composer-predictions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
    },
    body: "{}",
  });
  expect(
    (await handlePredictionRoute(request, new URL(request.url), "127.0.0.1"))
      ?.status,
  ).toBe(403);
  const local = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(
    (await handlePredictionRoute(local, new URL(local.url), "100.1.2.3"))
      ?.status,
  ).toBe(403);
});

test("real HTTP disconnect cancels model work and consumes its turn", async () => {
  const { PredictionService } = await import("../src/predictions");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(tmpdir() + "/prediction-http-");
  const before = process.env.PREDICTION_INDEX;
  const saved = {
    PORT: process.env.PORT,
    PROXY_API_KEY: process.env.PROXY_API_KEY,
    PROXY_STATE_DIR: process.env.PROXY_STATE_DIR,
  };
  process.env.PROXY_API_KEY = "prediction-test-only";
  process.env.PROXY_STATE_DIR = root;
  process.env.PREDICTION_INDEX = root + "/index.sqlite";
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled!: () => void;
  const stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const service = new PredictionService(
    async (_prompt, signal) => {
      started();
      return new Promise((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            cancelled();
            resolve("late");
          },
          { once: true },
        ),
      );
    },
    (text) => text,
    () => [],
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await handlePredictionRoute(
        request,
        new URL(request.url),
        "127.0.0.1",
        service,
      ))!,
  });
  process.env.PORT = String(server.port);
  const input = { threadId: "disconnect", turnId: "1", context: "ready" };
  try {
    const http = await import("node:http");
    const pending = http.request(
      `http://127.0.0.1:${server.port}/composer-predictions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer prediction-test-only",
        },
      },
    );
    pending.on("error", () => {});
    pending.end(JSON.stringify(input));
    await began;
    pending.destroy();
    await stopped;
    expect(await service.predict(input)).toBeNull();
  } finally {
    await server.stop(true);
    if (before === undefined) delete process.env.PREDICTION_INDEX;
    else process.env.PREDICTION_INDEX = before;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
