#!/usr/bin/env node
// Use the desktop's existing authorized app-tools pipe, never a second app-server.
import net from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.argv[2] === "status") {
  console.log(readFileSync(join(homedir(), ".local/state/codex-compaction/status.json"), "utf8"));
  process.exit(0);
}
const threadId = process.argv[2] ?? process.env.CODEX_THREAD_ID;
const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH ?? readFileSync(join(homedir(), ".local/state/codex-compaction/pipe"), "utf8").trim();
if (!pipe || !threadId) throw Error("Run inside a Codex Desktop chat, or supply CODEX_APP_TOOLS_PIPE_PATH and a thread UUID");
const params = {
  arguments: process.argv[2] ? { threadId } : {}, callerSource: "codex", hostId: "local",
  namespace: "codex_app", tool: "compact_thread", threadId,
  callId: randomUUID(), turnId: "local-compact-" + randomUUID(),
};
const socket = net.createConnection(pipe);
let buffered = Buffer.alloc(0);
socket.setTimeout(30000, () => socket.destroy(Error("Desktop compaction request timed out")));
socket.on("error", error => { console.error(error.message); process.exitCode = 1; });
socket.on("connect", () => {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  socket.write(Buffer.concat([header, payload]));
});
socket.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4) return;
  const length = buffered.readUInt32LE();
  if (length > 16 * 1024 * 1024) return socket.destroy(Error("Oversized desktop response"));
  if (buffered.length < length + 4) return;
  const response = JSON.parse(buffered.subarray(4, length + 4).toString());
  console.log(JSON.stringify(response.result ?? response.error, null, 2));
  if (response.error || response.result?.success === false) process.exitCode = 1;
  socket.end();
});
