import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killQuietly, waitGone } from "./proc-alive";

test("remote supervisor returns exporter output without waiting for stdin EOF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prediction-remote-"));
  const exporter = join(dir, "exporter.ts");
  writeFileSync(
    exporter,
    `const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify([{assistant:input.context,alex:'show me the diff'}]));`,
  );
  const child = Bun.spawn(
    [process.execPath, "scripts/prediction-remote.ts", exporter],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  try {
    child.stdin.write(
      JSON.stringify({
        context: "tests passed",
        deadlineMs: Date.now() + 3000,
      }) + "\n",
    );
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual([
      { assistant: "tests passed", alex: "show me the diff" },
    ]);
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSH stdin EOF cancels exporter and its descendant before deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prediction-remote-abort-"));
  const exporter = join(dir, "exporter.ts");
  const pidPath = join(dir, "pid");
  writeFileSync(
    exporter,
    `import {spawnSync} from 'node:child_process'; spawnSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); setInterval(()=>{},1000);`)}],{stdio:['ignore','inherit','ignore']});`,
  );
  const child = Bun.spawn(
    [process.execPath, "scripts/prediction-remote.ts", exporter],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const watcher = watch(dir);
  try {
    child.stdin.write(
      JSON.stringify({
        context: "safe test context",
        deadlineMs: Date.now() + 12000,
      }) + "\n",
    );
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
    const pid = Number(readFileSync(pidPath, "utf8"));
    await child.stdin.end();
    await child.exited;
    const alive = !(await waitGone(pid));
    try {
      expect(alive).toBe(false);
    } finally {
      if (alive) killQuietly(pid);
    }
    expect(child.exitCode).not.toBe(0);
  } finally {
    watcher.close();
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
