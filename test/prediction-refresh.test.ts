import { expect, test } from "bun:test";
import { CorpusRefresh } from "../src/prediction-refresh";
test("refresh is off the read path, never overlaps, and throttles failed attempts", async () => {
  let now = 100_000,
    calls = 0,
    finish!: () => void;
  const refresh = new CorpusRefresh(
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    () => now,
  );
  refresh.kick();
  expect(calls).toBe(1);
  now += 120_000;
  refresh.kick();
  expect(calls).toBe(1);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  refresh.kick();
  expect(calls).toBe(2);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  refresh.kick();
  expect(calls).toBe(2);
});
