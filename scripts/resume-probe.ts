// Live probe: does `claude --resume <id>` replay a session exactly enough to
// hit the prompt cache on the resumed process's first turn?
// Uses the proxy's real launch flags, minus --no-session-persistence.
import { buildClaudeArgs } from "../src/claude";

const bin = process.env.CLAUDE_BIN ?? "claude";
const cwd = process.env.CLAUDE_CWD ?? process.cwd();
const instructions = Array.from(
  { length: 400 },
  (_, i) =>
    `Reference entry ${i}: This controlled cache experiment uses stable instructions. Keep replies to one short line.`,
).join("\n");
const request = {
  model: "claude-opus-5-5",
  reasoning: { effort: "low" },
  input: "",
  tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
};
const base = buildClaudeArgs(request).filter((a) => a !== "--no-session-persistence");
const sessionId = crypto.randomUUID();

async function runProcess(label: string, extra: string[], messages: string[]) {
  const proc = Bun.spawn([bin, ...base, ...extra], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE" && k !== "CLAUDE_CODE_EFFORT_LEVEL"),
    ) as Record<string, string>,
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const pending: string[] = [];
  let buffer = "";
  const nextResult = async () => {
    while (true) {
      while (pending.length) {
        const line = pending.shift()!;
        try {
          const v = JSON.parse(line);
          if (v.type === "result") return v;
        } catch {}
      }
      const { done, value } = await reader.read();
      if (done) throw new Error(`${label}: exited before result: ${await new Response(proc.stderr).text()}`);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      pending.push(...lines);
    }
  };
  for (const [i, text] of messages.entries()) {
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    proc.stdin.flush();
    const r = await nextResult();
    console.log(
      JSON.stringify({
        process: label,
        turn: i + 1,
        isError: r.is_error,
        sessionId: r.session_id,
        cacheRead: r.usage?.cache_read_input_tokens,
        cacheWrite: r.usage?.cache_creation_input_tokens,
        input: r.usage?.input_tokens,
        text: r.structured_output?.text ?? String(r.result ?? "").slice(0, 160),
      }),
    );
  }
  proc.stdin.end();
  await proc.exited;
}

await runProcess("A", ["--session-id", sessionId], [
  `${instructions}\n\nCall lookup once with empty arguments.`,
  "<tool_result>VALUE_42</tool_result> Reply with exactly FIRST_OK.",
]);
// Let the first process fully exit and flush its transcript.
await Bun.sleep(1000);
await runProcess("B-resumed", ["--resume", sessionId], ["New message: reply with exactly RESUMED_OK."]);
process.exit(0);
