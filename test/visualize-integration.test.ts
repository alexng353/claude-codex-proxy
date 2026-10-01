import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";

test("a bare visualize reference reaches Codex wrapped and the warm worker is reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-visualize-"));
  const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"]
    .map((key) => [key, process.env[key]]));
  const fake = join(root, "fake.mjs");
  await mkdir(join(root, "base"));
  await mkdir(join(root, "state"));
  const reference = '{"path":"/tmp/viz/demo.html","title":"Demo"}';
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(join(root, "launches"))}, "launch\\n");
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  count++;
  const text = count === 1 ? ${JSON.stringify(`Here.\n\nvisualize${reference}`)} : "second";
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { text, tool_calls: [] } }));
}
`);
  await chmod(fake, 0o755);
  closeIdleWorkers();
  resetAccountState();
  process.env.CLAUDE_BIN = fake;
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  process.env.PROXY_STATE_DIR = join(root, "state");
  try {
    const user = { role: "user", content: [{ type: "input_text", text: "show me" }] };
    const first = await runClaude({ model: "sonnet", input: [user] });
    expect(first.text).toBe(`Here.\n\nvisualize${reference}`);
    const second = await runClaude({ model: "sonnet", input: [
      user,
      { role: "assistant", content: [{ type: "output_text", text: first.text }] },
      { role: "user", content: [{ type: "input_text", text: "again" }] },
    ] });
    expect(second.text).toBe("second");
    expect(await readFile(join(root, "launches"), "utf8")).toBe("launch\n");
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
