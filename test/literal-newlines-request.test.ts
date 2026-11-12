// literal-newline-text through the request path: a double-escaped StructuredOutput text
// is returned with real line breaks, and that same text is what the worker parks, so
// Codex's echo of it on the next turn resumes the parked worker (one launch, not two).
// One JSON log line per repaired answer, with the count and thread and no text.
import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";

const LITERAL = "Checklist:\\n- [ ] Passport\\n- [ ] Printed letter";
const REPAIRED = "Checklist:\n- [ ] Passport\n- [ ] Printed letter";

test("a double-escaped answer is returned and parked with real newlines, and logged once", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-literal-newline-"));
  const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"]
    .map((key) => [key, process.env[key]]));
  const base = join(root, "base");
  const state = join(root, "state");
  const fake = join(root, "fake.mjs");
  const launches = join(root, "launches");
  await mkdir(base);
  await mkdir(state);
  // The first turn answers double-escaped, as Bubble's did; later turns answer plainly.
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(launches)}, "launch\\n");
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const text = turn++ === 0 ? ${JSON.stringify(LITERAL)} : "ok";
  const out = { text, tool_calls: [] };
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: out }] } }));
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: out }));
}
`);
  await chmod(fake, 0o755);
  closeIdleWorkers();
  resetAccountState();
  process.env.CLAUDE_BIN = fake;
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.PROXY_STATE_DIR = state;
  const logged: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const key = crypto.randomUUID();
  const first = [{ role: "user", content: "hello" }];
  try {
    const output = await runClaude({ model: "sonnet", input: first, prompt_cache_key: key });
    expect(output.text).toBe(REPAIRED);
    // Codex echoes the answer it was given; only a worker that parked the repaired text
    // matches that echo and is resumed.
    const again = await runClaude({
      model: "sonnet",
      input: [...first, { role: "assistant", content: REPAIRED }, { role: "user", content: "thanks" }],
      prompt_cache_key: key,
    });
    expect(again.text).toBe("ok");
    expect(await readFile(launches, "utf8")).toBe("launch\n");
    const repairs = logged
      .filter((l) => l.includes("textNewlinesRepaired"))
      .map((l) => JSON.parse(l));
    expect(repairs).toEqual([{ textNewlinesRepaired: 2, threadId: key }]);
  } finally {
    spy.mockRestore();
    closeIdleWorkers();
    resetAccountState();
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k]; else process.env[k] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
