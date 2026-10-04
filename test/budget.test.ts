import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAccountState } from "../src/accounts";
import {
  fitReplay,
  promptTooLong,
  replayTokens,
  retryBudget,
} from "../src/budget";
import { closeIdleWorkers, runClaude } from "../src/claude";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const MARKER = "claude-codex-proxy elided";

/** A long agentic history: context, a question, then many large tool results. */
function history(calls: number, outputChars = 20_000): ResponsesRequest {
  const input: ResponseInputItem[] = [
    { role: "user", content: "<environment_context>cwd</environment_context>" },
    { role: "user", content: "Investigate the logs." },
  ];
  for (let index = 0; index < calls; index++) {
    input.push({ type: "function_call", name: "shell", call_id: `c${index}`, arguments: "{}" });
    input.push({
      type: "function_call_output",
      call_id: `c${index}`,
      output: `start-${index}:` + "x".repeat(outputChars) + `:end-${index}`,
    });
    input.push({ role: "assistant", content: `Checked log ${index}.` });
  }
  input.push({ role: "user", content: "What did you find?" });
  return { model: "claude-opus-5-5", input };
}

const items = (request: ResponsesRequest) => request.input as ResponseInputItem[];

test("a replay that fits is returned unchanged", () => {
  const request = history(3);
  const fitted = fitReplay(request, 1_000_000);
  expect(fitted.request).toBe(request);
  expect(fitted.elided).toBe(0);
  expect(fitted.fits).toBe(true);
});

test("oversized replays shed older tool outputs first and keep every message", () => {
  const request = history(60);
  const budget = Math.floor(replayTokens(request) / 2);
  const fitted = fitReplay(request, budget);
  expect(fitted.fits).toBe(true);
  expect(fitted.tokens).toBeLessThanOrEqual(budget);
  expect(replayTokens(fitted.request)).toBeLessThanOrEqual(budget + 1);
  const before = items(request);
  const after = items(fitted.request);
  expect(after).toHaveLength(before.length);
  // Messages and calls are untouched.
  for (const [index, item] of before.entries())
    if (item.type !== "function_call_output") expect(after[index]).toBe(item);
  const outputs = after.filter((item) => item.type === "function_call_output");
  // The oldest output is elided with a visible marker that keeps its head and tail.
  expect(outputs[0].output).toContain(MARKER);
  expect(outputs[0].output).toContain("start-0:");
  expect(outputs[0].output).toContain(":end-0");
  // Recent outputs survive intact.
  expect(outputs.at(-1)!.output).toBe(before.at(-3)!.output);
  expect(String(outputs.at(-1)!.output)).not.toContain(MARKER);
  // Only as much as needed: some older outputs remain whole.
  expect(outputs.some((item, index) => index < 40 && !String(item.output).includes(MARKER))).toBe(true);
});

test("a tight budget replaces older outputs and trims recent ones, sparing the last items", () => {
  const request = history(30);
  const fitted = fitReplay(request, 2_000);
  const after = items(fitted.request);
  expect(String(after[3].output)).toMatch(/^\[claude-codex-proxy elided this older tool output \(\d+ characters\)/);
  // The last few items, including the final tool output, are never touched.
  expect(after.at(-3)).toBe(items(request).at(-3));
  expect(fitted.fits).toBe(false);
});

test("elided outputs drop their images; tool_search outputs keep loaded tools", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AAAA" };
  const search = {
    type: "tool_search_output",
    call_id: "s1",
    tools: [{ type: "function", name: "loaded_tool", description: "d".repeat(50_000) }],
  };
  const request = history(30);
  items(request).splice(2, 0, search, {
    type: "function_call_output",
    call_id: "img",
    output: [{ type: "input_text", text: "screenshot" }, image],
  });
  const fitted = fitReplay(request, 5_000);
  const after = items(fitted.request);
  expect(after[2]).toBe(search);
  expect(typeof after[3].output).toBe("string");
  expect(JSON.stringify(after)).not.toContain("data:image");
});

test("parses Claude Code and API prompt-too-long errors", () => {
  expect(
    promptTooLong(
      "Prompt is too long · the request is ~1021402 tokens (limit 1000000) but this conversation is only ~560334 tokens",
    ),
  ).toEqual({ requested: 1_021_402, limit: 1_000_000 });
  expect(promptTooLong("prompt is too long: 205,000 tokens > 200,000 maximum")).toEqual({
    requested: 205_000,
    limit: 200_000,
  });
  expect(promptTooLong("Prompt is too long")).toEqual({});
  expect(promptTooLong("rate limit")).toBeUndefined();
});

test("retry budgets rescale by the error's own sizes", () => {
  // 574k estimated was really 1.02M: aim for 85% of the limit in real tokens.
  const budget = retryBudget(574_504, { requested: 1_021_402, limit: 1_000_000 }, "claude-opus-5-5");
  expect(budget).toBeGreaterThan(470_000);
  expect(budget).toBeLessThan(480_000);
  expect(retryBudget(100_000, {}, "claude-opus-5-5")).toBe(60_000);
  expect(retryBudget(2_000_000, { requested: 1_000_001, limit: 1_000_000 }, "claude-opus-5-5")).toBe(850_000);
});

test("a rejected replay is shrunk and retried once on a fresh worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-budget-"));
  const saved = Object.fromEntries(
    ["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR", "CLAUDE_CONTEXT_TOKENS"].map((key) => [key, process.env[key]]),
  );
  const fake = join(root, "fake.mjs");
  const log = join(root, "prompts");
  await mkdir(join(root, "base"));
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const first = !existsSync(${JSON.stringify(log)});
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(${JSON.stringify(log)}, line.length + " " + line.includes(${JSON.stringify(MARKER)}) + "\\n");
  const result = first
    ? { is_error: true, api_error_status: 400, result: "Prompt is too long · the request is ~90000 tokens (limit 40000)" }
    : { is_error: false, structured_output: { text: "fits now", tool_calls: [] } };
  console.log(JSON.stringify({ type: "result", subtype: "success", ...result }));
}
`);
  await chmod(fake, 0o755);
  closeIdleWorkers();
  resetAccountState();
  process.env.CLAUDE_BIN = fake;
  process.env.CLAUDE_CONFIG_DIR = join(root, "base");
  process.env.PROXY_STATE_DIR = join(root, "state");
  process.env.CLAUDE_CONTEXT_TOKENS = "40000";
  try {
    const request = history(20, 3_000);
    // Under the estimated budget, so the first launch sends everything.
    expect(replayTokens(request)).toBeLessThan(34_000);
    const output = await runClaude(request);
    expect(output.text).toBe("fits now");
    const launches = (await readFile(log, "utf8")).trim().split("\n").map((row) => row.split(" "));
    expect(launches).toHaveLength(2);
    expect(launches[0][1]).toBe("false");
    expect(launches[1][1]).toBe("true");
    expect(Number(launches[1][0])).toBeLessThan(Number(launches[0][0]) * 0.6);
    // Codex still sees the full history's size, so it can compact.
    expect(output.usage.inputTokens).toBeGreaterThanOrEqual(replayTokens(request));
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
