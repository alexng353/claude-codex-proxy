import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIdleWorkers, runClaude } from "../src/claude";
import { resetAccountState } from "../src/accounts";

import { expect, test } from "bun:test";

for (const cachedCheckpoint of [true, false]) {
test(`correction auth failover preserves history (checkpoint: ${cachedCheckpoint})`, async () => {
const root = await mkdtemp(join(tmpdir(), "comb-auth-checkpoint-"));
const base = join(root, "base");
const state = join(root, "state");
await mkdir(join(base, "projects", "probe"), { recursive: true });
await mkdir(join(state, "accounts", "spare"), { recursive: true });
await writeFile(join(state, "accounts", "spare", ".credentials.json"), "{}");
const log = join(root, "launches.jsonl");
const oldCheckpoint = "11111111-1111-4111-8111-111111111111";
const rejectedCheckpoint = "22222222-2222-4222-8222-222222222222";
const fake = join(root, "fake.mjs");
await writeFile(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const id = argv[argv.indexOf("--session-id") + 1];
const spare = process.env.CLAUDE_CONFIG_DIR.endsWith("/spare");
const file = join(process.env.CLAUDE_CONFIG_DIR, "projects", "probe", id + ".jsonl");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ spare, argv }) + "\\n");
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  count++;
  appendFileSync(${JSON.stringify(join(root, "inputs.jsonl"))}, JSON.stringify({ spare, count, line }) + "\\n");
  if (!spare && count === 3) {
    console.log(JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "OAuth access token has expired" }));
    continue;
  }
  const checkpoint = count === 1 ? ${JSON.stringify(oldCheckpoint)} : ${JSON.stringify(rejectedCheckpoint)};
  if (count !== 1 || ${cachedCheckpoint}) appendFileSync(file, JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { content: [{ type: "tool_use", name: "StructuredOutput", id: "answer" + count }] } }) + "\\n");
  if (count !== 1 || ${cachedCheckpoint}) appendFileSync(file, JSON.stringify({ type: "user", uuid: checkpoint, message: { content: [{ type: "tool_result", tool_use_id: "answer" + count }] } }) + "\\n");
  const output = spare ? { text: "spare success", tool_calls: [] } : count === 1 ? { text: "first response", tool_calls: [] } : { text: "", tool_calls: [{ name: "missing", arguments: "{}" }] };
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: output }));
}
`);
await chmod(fake, 0o755);
const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"].map(k => [k, process.env[k]]));
process.env.CLAUDE_BIN = fake;
process.env.CLAUDE_CONFIG_DIR = base;
process.env.PROXY_STATE_DIR = state;
try {
  const prompt_cache_key = crypto.randomUUID();
  const tools = [{ type: "function", name: "valid", parameters: { type: "object", properties: {} } }];
  const first = await runClaude({ model: "sonnet", input: "first", prompt_cache_key, tools });
  const second = await runClaude({ model: "sonnet", input: [{ role: "user", content: "first" }, { role: "assistant", content: first.text }, { role: "user", content: "second" }], prompt_cache_key, tools });
  const launches = (await readFile(log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  const last = launches.at(-1);
  const actual = last.argv[last.argv.indexOf("--resume-session-at") + 1];
  expect(second.text).toBe("spare success");
  if (cachedCheckpoint) expect(actual).toBe(oldCheckpoint);
  else expect(last.argv).not.toContain("--resume");
  const inputs = (await readFile(join(root, "inputs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(inputs.at(-1).line).toContain("second");
  if (cachedCheckpoint) expect(inputs.at(-1).line).not.toContain("first response");
  else expect(inputs.at(-1).line).toContain("first response");
} finally {
  closeIdleWorkers();
  resetAccountState();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(root, { recursive: true, force: true });
}

});

}
