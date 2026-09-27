// Live probe: drives runClaude the way Codex does (full history every request)
// and prints per-turn cache usage. Usage: PROXY_STATE_DIR=/tmp/x bun scripts/keepalive-probe.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeIdleWorkers, runClaude } from "../src/claude";
import type { ResponseInputItem, ResponsesRequest } from "../src/types";

const instructions = Array.from(
  { length: 400 },
  (_, i) =>
    `Reference entry ${i}: This controlled cache experiment uses stable instructions. Follow the user's requests exactly and keep replies to one short line.`,
).join("\n");
const tools = [
  { type: "tool_search" },
  {
    type: "function",
    name: "lookup",
    description: "Return a test value",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];
const base = { model: "claude-opus-5-5", reasoning: { effort: "low" }, instructions, tools };
const history: ResponseInputItem[] = [];

async function turn(label: string, items: ResponseInputItem[], toolResult?: (call: { name: string; callId?: string; arguments: string }) => ResponseInputItem) {
  history.push(...items);
  const out = await runClaude({ ...base, input: [...history] } as ResponsesRequest);
  if (out.text)
    history.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: out.text }] });
  for (const call of out.toolCalls) {
    history.push(
      call.name === "__codex_tool_search"
        ? { type: "tool_search_call", call_id: call.callId, arguments: call.arguments }
        : { type: "function_call", name: call.name, call_id: call.callId, arguments: call.arguments },
    );
  }
  console.log(label, JSON.stringify({ text: out.text, calls: out.toolCalls.map((c) => c.name) }));
  return out;
}

const first = await turn("t1", [{ role: "user", content: "Call lookup once with empty arguments." }]);
await turn("t2", first.toolCalls.map((c) => ({ type: "function_call_output", call_id: c.callId, output: "VALUE_42" })));
// Kill the process: t3 must continue through a persisted session (--resume).
closeIdleWorkers();
await Bun.sleep(1000);
await turn("t3", [{ role: "developer", content: "Current time: now" }, { role: "user", content: "New message: reply with exactly SECOND_OK." }]);
const search = await turn("t4", [{ role: "user", content: "Use __codex_tool_search with query 'spawn agent' now." }]);
await turn("t5", search.toolCalls.map((c) => ({
  type: "tool_search_output",
  call_id: c.callId,
  tools: [{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent", description: "Spawn a sub-agent", parameters: { type: "object", properties: { message: { type: "string" } } } }] }],
})));

const rows = readFileSync(join(process.env.PROXY_STATE_DIR!, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
for (const r of rows)
  console.log(JSON.stringify({ worker: r.workerId.slice(0, 6), turn: r.workerTurn, attempt: r.attempt, cacheRead: r.usage?.cache_read_input_tokens, cacheWrite: r.usage?.cache_creation_input_tokens, input: r.usage?.input_tokens }));
process.exit(0);
