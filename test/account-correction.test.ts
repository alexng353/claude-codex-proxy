import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";

for (const compaction of [false, true]) {
  test(`fails over when a ${compaction ? "compaction" : "tool-name"} correction hits quota`, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-correction-"));
    const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"]
      .map((key) => [key, process.env[key]]));
    const base = join(root, "base");
    const state = join(root, "state");
    const fake = join(root, "fake.mjs");
    await mkdir(base);
    await mkdir(join(state, "accounts/spare"), { recursive: true });
    await writeFile(join(state, "accounts/spare/.credentials.json"), "{}");
    await writeFile(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const spare = process.env.CLAUDE_CONFIG_DIR.endsWith("/spare");
appendFileSync(${JSON.stringify(join(root, "launches"))}, spare ? "spare\\n" : "default\\n");
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  count++;
  const result = spare
    ? { is_error: false, structured_output: { text: "spare success", tool_calls: [] } }
    : count === 1
      ? { is_error: false, structured_output: { text: "", tool_calls: [{ name: "missing", arguments: "{}" }] } }
      : { is_error: true, api_error_status: 429, result: "rate limit" };
  console.log(JSON.stringify({ type: "result", subtype: "success", ...result }));
}
`);
    await chmod(fake, 0o755);
    closeIdleWorkers();
    resetAccountState();
    process.env.CLAUDE_BIN = fake;
    process.env.CLAUDE_CONFIG_DIR = base;
    process.env.PROXY_STATE_DIR = state;
    try {
      const output = await runClaude({ model: "sonnet", input: compaction
        ? [{ role: "user", content: "summarize" }, { type: "compaction_trigger" }]
        : "hello" });
      expect(compaction ? output.compaction : output.text).toBe("spare success");
      expect(output.account).toBe("spare");
      expect(await readFile(join(root, "launches"), "utf8")).toBe("default\nspare\n");
    } finally {
      closeIdleWorkers();
      resetAccountState();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
