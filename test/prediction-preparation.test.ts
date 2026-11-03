import { test, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  watch,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PredictionPreparationPool } from "../src/prediction-preparation";
import { killQuietly, waitGone } from "./proc-alive";

test("ordinary HTTP stays responsive during real cold prediction preparation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prediction-app-"));
  const marker = join(dir, "scrub-started");
  const secrets = join(dir, "fixture-secrets.zsh");
  const serverScript = join(dir, "server.ts");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const secret = "guardfixture-privatevalue-42";
  writeFileSync(
    secrets,
    [
      `print -r -- started > ${quote(marker)}`,
      `${quote(process.execPath)} -e ${quote("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800)")}`,
      `export FIXTURE_SECRET=${quote(secret)}`,
    ].join("\n"),
  );
  // Import only the real app entry point: removing its prediction route or
  // moving cold secret loading onto its event loop must break this test.
  writeFileSync(
    serverScript,
    `
    import { handleRequest } from ${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)};
    const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:(request)=>handleRequest(request,"127.0.0.1")});
    process.env.PORT=String(server.port);
    console.log(JSON.stringify({url:server.url.href}));
  `,
  );
  const child = Bun.spawn([process.execPath, serverScript], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: dir,
      USER: "prediction-fixture",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
      PROXY_STATE_DIR: join(dir, "proxy"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CLAUDE_BIN: join(dir, "nonexistent-claude"),
      PREDICTION_INDEX: join(dir, "index.sqlite"),
      TODAY_DB_PATH: join(dir, "nonexistent-today.sqlite"),
      SECRET_SCRUB_FILES: secrets,
      PROXY_API_KEY: "prediction-route-fixture",
    },
  });
  const watcher = watch(dir);
  const watchdog = setTimeout(() => child.kill(), 4000);
  let markerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (!ready.value) throw new Error("private app server did not start");
    const url = JSON.parse(new TextDecoder().decode(ready.value)).url;
    const entered = new Promise<void>((resolve, reject) => {
      markerTimer = setTimeout(
        () => reject(new Error("real prediction guard was never reached")),
        2000,
      );
      watcher.on("change", () => {
        if (existsSync(marker)) {
          clearTimeout(markerTimer);
          resolve();
        }
      });
    });
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer prediction-route-fixture",
    };
    let settled = false;
    const predictionStarted = performance.now();
    const pending = fetch(new URL("/composer-predictions", url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: "real-route",
        turnId: "1",
        context: `please review ${secret}`,
      }),
    })
      .then((response) => response.json())
      .then((value) => {
        settled = true;
        return value;
      });
    void pending.catch(() => {});
    await entered;
    const response = await fetch(new URL("/v1/responses", url), {
      method: "POST",
      headers,
      body: "{",
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBeDefined();
    expect(performance.now() - predictionStarted).toBeLessThan(400);
    expect(settled).toBe(false);
    expect(await pending).toEqual({ prediction: null, source: "haiku" });
  } finally {
    clearTimeout(watchdog);
    clearTimeout(markerTimer);
    watcher.close();
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation terminates blocked workers and queued jobs without retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prediction-abort-"));
  const path = join(dir, "worker.ts");
  writeFileSync(
    path,
    `const postMessage=(v)=>process.stdout.write(JSON.stringify(v)+"\\n"); process.stdin.on("data", () => { postMessage({ready:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000); postMessage({value:true}); });`,
  );
  const pool = new PredictionPreparationPool(new URL("file://" + path));
  const abort = new AbortController();
  try {
    const jobs = [1, 2, 3].map(() =>
      pool.run({ kind: "reply", reply: "hello" }, abort.signal),
    );
    abort.abort();
    expect(
      (await Promise.allSettled(jobs)).every((r) => r.status === "rejected"),
    ).toBe(true);
    expect(pool.active).toBe(0);
  } finally {
    pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborting cold preparation kills its synchronous scrubber descendant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prediction-group-"));
  const path = join(dir, "worker.ts");
  const pidPath = join(dir, "pid");
  writeFileSync(
    path,
    `import {spawnSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const work = () => { spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); setInterval(()=>{},1000)`)}], {stdio:['ignore','inherit','ignore'],timeout:10000}); }; process.stdin.on('data',work);`,
  );
  const pool = new PredictionPreparationPool(new URL("file://" + path));
  const abort = new AbortController();
  try {
    const pending = pool.run(
      { kind: "prepare", context: "hi", examples: [] },
      abort.signal,
    );
    const watcher = watch(dir);
    if (!existsSync(pidPath))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("descendant did not start")),
          3000,
        );
        watcher.on("change", () => {
          if (existsSync(pidPath)) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    watcher.close();
    const pid = Number(readFileSync(pidPath, "utf8"));
    abort.abort();
    await expect(pending).rejects.toBeDefined();
    const alive = !(await waitGone(pid));
    try {
      expect(alive).toBe(false);
    } finally {
      if (alive) killQuietly(pid);
    }
  } finally {
    pool.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actual preparation checks raw multiline secrets before JSON serialization", async () => {
  const pool = new PredictionPreparationPool();
  const key =
    "-----BEGIN PRIVATE KEY-----\n" +
    "FAKEONLY0123456789".repeat(4) +
    "\n-----END PRIVATE KEY-----";
  try {
    const unsafeContext = await pool.run({
      kind: "prepare",
      context: `context ${key}`,
      examples: [],
    });
    expect(typeof unsafeContext).toBe("object");
    if (typeof unsafeContext === "boolean")
      throw new Error("unexpected worker result");
    expect(unsafeContext.prompt).toBeNull();

    const safeContext = await pool.run({
      kind: "prepare",
      context: "the tests passed",
      examples: [
        { assistant: key, alex: "show me the diff" },
        { assistant: "the tests passed", alex: key },
        { assistant: "the tests passed", alex: "show me the diff" },
      ],
    });
    if (typeof safeContext === "boolean")
      throw new Error("unexpected worker result");
    expect(safeContext.prompt).not.toBeNull();
    expect(JSON.parse(safeContext.prompt!).examples).toEqual([
      { assistant: "the tests passed", alex: "show me the diff" },
    ]);
    expect(await pool.run({ kind: "reply", reply: key })).toBe(false);
    expect(await pool.run({ kind: "reply", reply: "show me the diff" })).toBe(
      true,
    );
  } finally {
    pool.close();
  }
});
