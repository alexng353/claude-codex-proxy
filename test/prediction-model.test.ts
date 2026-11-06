import { describe, expect, test } from "bun:test";
import { PredictionModelPool } from "../src/prediction-model";
const fake = (script: string) => () =>
  Bun.spawn([process.execPath, "-e", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
const responder = `
console.log(JSON.stringify({type:"system", subtype:"init"}));
for await (const chunk of Bun.stdin.stream()) {
 const input = JSON.parse(new TextDecoder().decode(chunk));
 console.log(JSON.stringify({type:"result", result:JSON.stringify({prediction:input.message.content, confidence:0.9}), duration_api_ms:7}));
}
`;
describe("one-shot prediction workers", () => {
  test("a prewarmed child handles exactly one prompt and is reaped", async () => {
    const children: ReturnType<ReturnType<typeof fake>>[] = [];
    const spawn = fake(responder);
    const pool = new PredictionModelPool(() => {
      const child = spawn();
      children.push(child);
      return child;
    });
    pool.prewarm();
    const metrics: any[] = [];
    expect(
      await pool.generate("show me", undefined, (m) => metrics.push(m)),
    ).toBe("show me");
    expect(await children[0]!.exited).not.toBeNull();
    expect(await pool.generate("try again")).toBe("try again");
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(metrics[0].apiMs).toBe(7);
    await pool.close();
    for (const child of children) expect(await child.exited).not.toBeNull();
  });
  test("abort kills and reaps a running model, without returning its late result", async () => {
    let child: ReturnType<ReturnType<typeof fake>> | undefined;
    const pool = new PredictionModelPool(
      () =>
        (child = fake(
          "for await (const _ of Bun.stdin.stream()) { await Bun.sleep(10000); }",
        )()),
    );
    const abort = new AbortController();
    const result = pool.generate("hello", abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(await child!.exited).not.toBeNull();
    await pool.close();
  });
  test("an expired deadline launches no child", async () => {
    let spawned = 0;
    const pool = new PredictionModelPool(() => {
      spawned++;
      return fake(responder)();
    });
    await expect(
      pool.generate("hello", undefined, undefined, Date.now() - 1),
    ).rejects.toThrow();
    expect(spawned).toBe(0);
    await pool.close();
  });
  test("malformed and oversized output fail closed and reap the child", async () => {
    for (const script of [
      'console.log("not json");',
      'console.log("x".repeat(70000));',
    ]) {
      let child: ReturnType<ReturnType<typeof fake>> | undefined;
      const pool = new PredictionModelPool(() => (child = fake(script)()));
      await expect(pool.generate("hello")).rejects.toThrow();
      expect(await child!.exited).not.toBeNull();
      await pool.close();
    }
  });
  test("pre-aborted requests never consume an idle child", async () => {
    let spawned = 0;
    const pool = new PredictionModelPool(() => {
      spawned++;
      return fake(responder)();
    });
    const abort = new AbortController();
    abort.abort();
    await expect(pool.generate("hello", abort.signal)).rejects.toThrow();
    expect(spawned).toBe(0);
    await pool.close();
  });
});

test("malformed idle worker is promptly reaped instead of lingering until expiry", async () => {
  let child: ReturnType<ReturnType<typeof fake>> | undefined;
  const pool = new PredictionModelPool(
    () => (child = fake('console.log("not json"); await Bun.sleep(10000);')()),
  );
  pool.prewarm();
  const exited = await Promise.race([
    child!.exited.then(() => true),
    Bun.sleep(100).then(() => false),
  ]);
  await pool.close();
  expect(exited).toBe(true);
});
