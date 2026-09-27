import { runClaude } from "../src/claude";
const rules = Array.from(
  { length: 180 },
  (_, i) =>
    `Reference entry ${i}: This controlled cache experiment uses stable instructions. Return the requested marker exactly and do not perform unrelated actions.`,
).join("\n");
const request = {
  model: "claude-opus-5-5",
  reasoning: { effort: "low" },
  instructions: rules,
  input: "Reply CACHE_OK. Do not use tools.",
};
for (let i = 0; i < 3; i++) {
  const result = await runClaude(request);
  console.log(
    JSON.stringify({
      phase: process.env.PROBE_PHASE,
      run: i + 1,
      text: result.text,
    }),
  );
}
const tools = [
  {
    type: "function",
    name: "lookup",
    description: "Return a test value",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];
const first = await runClaude({
  ...request,
  input:
    "Call lookup exactly once with empty arguments. After its result reply TOOL_OK.",
  tools,
});
if (!first.toolCalls.length) throw new Error("No tool call in probe");
const call = first.toolCalls[0];
const second = await runClaude({
  ...request,
  tools,
  input: [
    {
      role: "user",
      content:
        "Call lookup exactly once with empty arguments. After its result reply TOOL_OK.",
    },
    {
      type: "function_call",
      name: call.name,
      call_id: call.callId,
      arguments: call.arguments,
    },
    { type: "function_call_output", call_id: call.callId, output: "success" },
  ],
});
console.log(
  JSON.stringify({ phase: process.env.PROBE_PHASE, toolLoop: second.text }),
);
