import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { closeIdleWorkers } from "../src/claude";
import { preparePerpetual, setPerpetualDeps } from "../src/perpetual";
import { preloadSkills } from "../src/skill-preload";
import type { ResponsesRequest } from "../src/types";

let directory: string;
let skill: string;
let saved: Record<string, string | undefined>;
const env = [
  "SKILL_PRELOAD_CONFIG",
  "CLAUDE_BIN",
  "CLAUDE_CONFIG_DIR",
  "PROXY_STATE_DIR",
  "HYGIENE_GATE_DISABLED_FILE",
  "PLATE_ACTIVITY_CONFIG",
];
const body = "# Voice replies\nUse respond_jarvis for a voice request.";
const request = (extra: Record<string, unknown> = {}): ResponsesRequest => ({
  model: "sonnet",
  prompt_cache_key: "selected-chat",
  input: [
    { role: "developer", content: "original instructions" },
    { role: "user", content: "# AGENTS.md instructions\nUse Bun." },
    { role: "user", content: "hello" },
  ],
  ...extra,
});
const configure = (threads: unknown) =>
  writeFileSync(process.env.SKILL_PRELOAD_CONFIG!, JSON.stringify({ threads }));
const render = (value: unknown) => JSON.stringify(value);
const send = (path: string, value = request()) =>
  handleRequest(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    }),
  );

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "skill-preload-"));
  saved = Object.fromEntries(env.map((key) => [key, process.env[key]]));
  process.env.SKILL_PRELOAD_CONFIG = join(directory, "skills.json");
  process.env.PROXY_STATE_DIR = join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude-config");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, "disabled");
  process.env.PLATE_ACTIVITY_CONFIG = join(directory, "no-plate.json");
  writeFileSync(process.env.HYGIENE_GATE_DISABLED_FILE, "");
  skill = join(directory, "SKILL.md");
  writeFileSync(
    skill,
    `---\nname: voice-test\ndescription: metadata-not-in-prompt\n---\n\n${body}\n`,
  );
  configure({ "selected-chat": [skill] });
  setPerpetualDeps({ config: () => undefined });
});

afterEach(() => {
  closeIdleWorkers();
  setPerpetualDeps({});
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test("loads only the selected chat's skill body as leading developer context", () => {
  const original = request();
  const snapshot = render(original);
  const loaded = preloadSkills(original);
  expect(render(loaded)).toContain(body.replaceAll("\n", "\\n"));
  expect(render(loaded)).not.toContain("metadata-not-in-prompt");
  expect((loaded.input as any[])[0].role).toBe("developer");
  expect((loaded.input as any[]).slice(1)).toEqual(original.input as any[]);
  expect(render(original)).toBe(snapshot);
  expect(preloadSkills(loaded)).toEqual(loaded);
  for (const prompt_cache_key of [
    "other-chat",
    "constructor",
    "__proto__",
    undefined,
  ]) {
    const other = request({ prompt_cache_key });
    expect(preloadSkills(other)).toBe(other);
  }
});

test("subagents, consolidation, auxiliary requests and compaction keep their inputs", () => {
  for (const meta of [
    { thread_source: "subagent" },
    { thread_source: "memory_consolidation" },
    { request_kind: "title" },
  ]) {
    for (const value of [meta, JSON.stringify(meta)]) {
      const other = request({
        client_metadata: { "x-codex-turn-metadata": value },
      });
      expect(preloadSkills(other)).toBe(other);
    }
  }
  const compact = request({ input: [{ type: "compaction_trigger" }] });
  expect(preloadSkills(compact)).toBe(compact);
});

test("rereads skill and config changes and supports string and incremental inputs", () => {
  const string = request({
    input: "hello",
    previous_response_id: "resp_previous",
  });
  expect(render(preloadSkills(string))).toContain("respond_jarvis");
  writeFileSync(
    skill,
    "\uFEFF---\r\nname: revised\r\ndescription: hidden\r\n---\r\n\r\nRevised voice rule.",
  );
  const updated = preloadSkills(string);
  expect(render(updated)).toContain("Revised voice rule.");
  expect(render(updated)).not.toContain("respond_jarvis");
  expect(
    (updated as ResponsesRequest & { previous_response_id: string })
      .previous_response_id,
  ).toBe("resp_previous");
  expect((updated.input as any[])[1]).toEqual({
    role: "user",
    content: "hello",
  });
  configure({ "selected-chat": [] });
  expect(preloadSkills(string)).toBe(string);
  rmSync(process.env.SKILL_PRELOAD_CONFIG!);
  expect(preloadSkills(string)).toBe(string);
});

test("deduplicates paths, preserves order, and scrubs loaded text", () => {
  const second = join(directory, "second.md");
  writeFileSync(
    second,
    "Second rule. CF_API_TOKEN=synthetic_canary_never_expose_123456789",
  );
  configure({ "selected-chat": [skill, skill, second] });
  const text = render(preloadSkills(request()));
  expect(text.match(/Use respond_jarvis/g)).toHaveLength(1);
  expect(text.indexOf("Use respond_jarvis")).toBeLessThan(
    text.indexOf("Second rule"),
  );
  expect(text).not.toContain("synthetic_canary_never_expose_123456789");
});

test("invalid selected paths, missing files and empty bodies fail without leaking file data", () => {
  for (const value of [
    "not-an-array",
    [42],
    ["relative/SKILL.md"],
    [join(directory, "missing.md")],
  ]) {
    configure({ "selected-chat": value });
    expect(() => preloadSkills(request())).toThrow("Skill preload failed");
    const other = request({ prompt_cache_key: "other-chat" });
    expect(preloadSkills(other)).toBe(other);
  }
  configure({ "selected-chat": [skill] });
  writeFileSync(skill, "---\nname: empty\n---\n");
  expect(() => preloadSkills(request())).toThrow("Skill preload failed");
});

test("malformed configuration produces a fixed diagnostic on both model paths", async () => {
  writeFileSync(process.env.SKILL_PRELOAD_CONFIG!, "private-config-canary{");
  expect(() => preloadSkills(request())).toThrow("Skill preload failed");
  const claude = await send("/v1/responses");
  expect(claude.status).toBe(502);
  const failure = await claude.text();
  expect(failure).toContain("Skill preload failed");
  expect(failure).not.toContain("private-config-canary");
  const gpt = await send("/hygiene/gate");
  expect(gpt.status).toBe(200);
  const decision = (await gpt.json()) as any;
  expect(decision.action).toBe("respond");
  expect(render(decision)).not.toContain("private-config-canary");
});

test("perpetual rewriting retains the skill outside summarized conversation", () => {
  setPerpetualDeps({
    root: join(directory, "perpetual"),
    config: () => ({
      titlePrefix: "Today",
      threads: ["selected-chat"],
      viewMin: 64000,
      viewMax: 128000,
      summaryModel: "haiku",
    }),
    title: () => "Today (test)",
    runner: () => ({ ask: async () => "summary", close() {} }),
  });
  const plan = preparePerpetual(preloadSkills(request()))!;
  expect(render(plan.request)).toContain("respond_jarvis");
  const log = join(directory, "perpetual", "selected-chat", "main");
  expect(
    readdirSync(log)
      .map((file) => readFileSync(join(log, file), "utf8"))
      .join("\n"),
  ).not.toContain("respond_jarvis");
});

test("GPT router preprocessing injects skills and reports selected-file failures", async () => {
  const result = (await (
    await send("/hygiene/gate", request({ model: "gpt-6-astra" }))
  ).json()) as any;
  expect(result.action).toBe("forward");
  expect(render(result.request)).toContain("respond_jarvis");
  const other = await (
    await send("/hygiene/gate", request({ prompt_cache_key: "other-chat" }))
  ).json();
  expect(other).toEqual({ action: "forward" });
  rmSync(skill);
  const failure = (await (await send("/hygiene/gate")).json()) as any;
  expect(failure.action).toBe("respond");
  expect(render(failure.response)).toContain("Skill preload failed");
});

test("Claude receives the skill and reuses its worker for the next turn", async () => {
  const executable = join(directory, "fake-claude");
  const capture = join(directory, "capture.jsonl");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = ${JSON.stringify(capture)};
const file = process.argv[process.argv.indexOf('--system-prompt-file') + 1];
appendFileSync(capture, JSON.stringify({ pid: process.pid, system: readFileSync(file, 'utf8') }) + '\\n');
for await (const input of createInterface({ input: process.stdin })) {
  appendFileSync(capture, JSON.stringify({ pid: process.pid, input: JSON.parse(input) }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    structured_output: { text: 'mock-ok', tool_calls: [] } }) + '\\n');
}
`,
  );
  chmodSync(executable, 0o755);
  process.env.CLAUDE_BIN = executable;
  expect((await send("/v1/responses")).status).toBe(200);
  expect(
    (
      await send(
        "/v1/responses",
        request({
          input: [
            ...(request().input as any[]),
            { role: "assistant", content: "mock-ok" },
            { role: "user", content: "next question" },
          ],
        }),
      )
    ).status,
  ).toBe(200);
  const records = readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(new Set(records.map((row) => row.pid)).size).toBe(1);
  expect(records.find((row) => row.system).system).toContain("respond_jarvis");
  expect(render(records.filter((row) => row.input).at(-1))).not.toContain(
    "respond_jarvis",
  );
});
