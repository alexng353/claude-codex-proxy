import { spawn, type ChildProcess } from "node:child_process";

// SSH keeps this control input open after the first request line. Its EOF is
// cancellation, unlike the separate exporter's input, which ends immediately.
const exporter = process.argv[2];
if (!exporter || !/^\/[a-zA-Z0-9_./-]+$/.test(exporter)) process.exit(1);
let child: ChildProcess | undefined;
let stopping = false;
let started = false;
let input = "";
let outputBytes = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  if (!child?.pid) process.exit(1);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdout.on("error", stop);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (started) {
    stop();
    return;
  }
  input += chunk;
  if (input.length > 64000) {
    stop();
    return;
  }
  const end = input.indexOf("\n");
  if (end < 0) return;
  started = true;
  try {
    const request = JSON.parse(input.slice(0, end));
    if (
      typeof request.context !== "string" ||
      request.context.length > 16000 ||
      !Number.isFinite(request.deadlineMs)
    ) {
      stop();
      return;
    }
    const remaining = Math.min(12000, request.deadlineMs - Date.now());
    if (remaining <= 0) {
      stop();
      return;
    }
    child = spawn(process.execPath, [exporter], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.on("error", stop);
    child.stdin!.on("error", stop);
    child.stdout!.on("data", (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > 32000) {
        stop();
        return;
      }
      process.stdout.write(data);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      process.stdout.end(() => process.exit(stopping ? 1 : (code ?? 1)));
    });
    if (timer) clearTimeout(timer);
    timer = setTimeout(stop, remaining);
    child.stdin!.end(JSON.stringify({ context: request.context }));
  } catch {
    stop();
  }
});
// A broken connection that never sends a request must not leave a supervisor.
timer = setTimeout(stop, 12000);
