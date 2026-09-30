import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, closeIdleWorkers } from "../src/claude";

// Exercise normalization before the real worker prefix/delta selection, using
// a fake CLI so the test consumes no model quota or account credentials.
test("direct Claude requests compact catalogs and reuse the same worker across turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proxy-context-integration-"));
  const capture = join(directory, "capture.jsonl");
  const executable = join(directory, "claude.js");
  const old = Object.fromEntries(
    [
      "CLAUDE_BIN",
      "PROXY_STATE_DIR",
      "CLAUDE_CONFIG_DIR",
      "CONTEXT_CAPTURE",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    await writeFile(
      executable,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const file = process.argv[process.argv.indexOf('--system-prompt-file') + 1];
appendFileSync(process.env.CONTEXT_CAPTURE, JSON.stringify({ pid: process.pid, system: readFileSync(file, 'utf8') }) + '\\n');
for await (const input of createInterface({ input: process.stdin })) {
  appendFileSync(process.env.CONTEXT_CAPTURE, JSON.stringify({ pid: process.pid, input: JSON.parse(input) }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    structured_output: { text: 'mock-ok', tool_calls: [] } }) + '\\n');
}
`,
    );
    await chmod(executable, 0o755);
    process.env.CLAUDE_BIN = executable;
    process.env.PROXY_STATE_DIR = join(directory, "state");
    process.env.CLAUDE_CONFIG_DIR = join(directory, "config");
    process.env.CONTEXT_CAPTURE = capture;
    const first = `<skills_instructions>\n## Skills\nRead each skill.\n### Available skills\n- alpha: first (file: /skills/alpha/SKILL.md)\n</skills_instructions>`;
    const second = first.replace("alpha: first", "alpha: changed");
    const memory = "<global-memory>\ndefaults\n</global-memory>";
    const developer = (content: string) => ({ role: "developer", content });
    const input = [
      developer(memory),
      developer(memory),
      developer(first),
      {
        role: "user",
        content: "# AGENTS.md instructions for /repo\n\nUse Bun.",
      },
      { role: "user", content: "first question" },
    ];
    const request = {
      model: "sonnet",
      instructions: "context-integration",
      input,
    };
    await runClaude(request);
    await runClaude({
      ...request,
      input: [
        ...input,
        { role: "assistant", content: "mock-ok" },
        developer(second),
        developer(second),
        { role: "user", content: "second question" },
      ],
    });
    const records = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(records.map((record) => record.pid)).size).toBe(1);
    const system = records.find((record) => record.system).system;
    expect(system.match(/<global-memory>/g)?.length).toBe(1);
    expect(system.match(/<skills_instructions>/g)?.length).toBe(1);
    const turns = records.filter((record) => record.input);
    expect(turns.length).toBe(2);
    const continued = JSON.stringify(turns[1].input);
    expect(continued).toContain("<skills_catalog_update>");
    expect(continued).toContain("alpha: changed");
    expect(continued).not.toContain("<skills_instructions>");
    expect(continued).not.toContain("first question");
  } finally {
    closeIdleWorkers();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
