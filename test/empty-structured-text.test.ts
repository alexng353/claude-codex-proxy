import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";

for (const mode of ["prose", "silent", "both"] as const) {
  test(`empty StructuredOutput text: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-prose-"));
    const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"]
      .map((key) => [key, process.env[key]]));
    const base = join(root, "base");
    const state = join(root, "state");
    const fake = join(root, "fake.mjs");
    await mkdir(base);
    await mkdir(state);
    await writeFile(fake, `#!${process.execPath}
import { createInterface } from "node:readline";
const mode = ${JSON.stringify(mode)};
for await (const line of createInterface({ input: process.stdin })) {
  const say = (content) => console.log(JSON.stringify({ type: "assistant", message: { content } }));
  say([{ type: "thinking", thinking: "hidden" }]);
  if (mode !== "silent") say([{ type: "text", text: "Merge the PR." }]);
  if (mode === "both") say([{ type: "text", text: "Then approve the gate." }]);
  say([{ type: "tool_use", name: "StructuredOutput", input: { text: "", tool_calls: [] } }]);
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { text: "", tool_calls: [] } }));
}
`);
    await chmod(fake, 0o755);
    closeIdleWorkers();
    resetAccountState();
    process.env.CLAUDE_BIN = fake;
    process.env.CLAUDE_CONFIG_DIR = base;
    process.env.PROXY_STATE_DIR = state;
    try {
      const output = await runClaude({ model: "sonnet", input: "hello", prompt_cache_key: crypto.randomUUID() });
      expect(output.text).toBe({ prose: "Merge the PR.", silent: "", both: "Merge the PR.\n\nThen approve the gate." }[mode]);
    } finally {
      closeIdleWorkers();
      resetAccountState();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
