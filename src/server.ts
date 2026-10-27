#!/usr/bin/env bun
import { handleRequest } from "./app";
import { closeIdleWorkers } from "./claude";
import { healthInfo, isDraining, runningCommit, setDraining } from "./handoff";
import { drainPerpetual, perpetualBusy } from "./perpetual";
import { startUsageProbe } from "./usage-probe";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3456);
/** This copy's own port for /health, so a handoff checks the new copy itself (alex-0230). */
const healthPort = Number(process.env.HEALTH_PORT ?? 0);
/** After this long a draining copy logs what still runs; it keeps waiting (F9). */
const DRAIN_WARN_MS = Number(process.env.DRAIN_WARN_MS ?? 2 * 60 * 60_000);

if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !process.env.PROXY_API_KEY) {
  throw new Error("PROXY_API_KEY is required when binding outside localhost");
}

// reusePort: during a handoff the next copy listens on the same port beside this one
// (alex-0230), so nothing is refused while one starts and the other drains.
const server = Bun.serve({ hostname, port, reusePort: true, fetch: handleRequest });
console.log(`Claude Codex Proxy ${runningCommit()} listening at ${server.url}`);
const own = healthPort
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: healthPort,
      fetch: () => Response.json(healthInfo(server.pendingRequests)),
    })
  : undefined;
// Idle accounts have no turn headers; /usage fills their meters for routing and caps.
const stopProbe = startUsageProbe();

/**
 * Hand over (alex-0230): stop accepting, start no new work (the usage probe, idle
 * Claude workers, memory summaries), let every open request, summary and probe
 * finish, then exit 0 so the unit stays down. Nothing open is ever cut: a turn that
 * runs for hours keeps this copy alive for hours (logged every DRAIN_WARN_MS).
 */
async function drain(signal: string): Promise<void> {
  if (isDraining()) return;
  setDraining(true);
  console.log(`Draining on ${signal}: ${server.pendingRequests} open requests`);
  let probeDone = false;
  void stopProbe().finally(() => (probeDone = true));
  closeIdleWorkers();
  let memoryDone = false;
  void drainPerpetual().finally(() => (memoryDone = true));
  server.stop(false);
  let warnAt = Date.now() + DRAIN_WARN_MS;
  while (server.pendingRequests > 0 || perpetualBusy() > 0 || !memoryDone || !probeDone) {
    await Bun.sleep(1000);
    closeIdleWorkers();
    if (Date.now() >= warnAt) {
      console.log(
        `Still draining: ${server.pendingRequests} requests, ${perpetualBusy()} memory, probe ${probeDone ? "done" : "running"}`,
      );
      warnAt = Date.now() + DRAIN_WARN_MS;
    }
  }
  closeIdleWorkers();
  console.log("Drained: every request finished");
  own?.stop(true);
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void drain(signal));
