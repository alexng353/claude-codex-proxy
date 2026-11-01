import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

export type PreparedPrediction = {
  prompt: string | null;
  retrievalMs: number;
  guardMs: number;
};
export type PreparationJob =
  | { kind: "prepare"; context: string; examples?: unknown[] }
  | { kind: "reply"; reply: string };
type Value = PreparedPrediction | boolean;
type Job = {
  input: PreparationJob;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};
type Slot = { child: ChildProcess; job?: Job; exited: Promise<void> };

/** Dedicated process groups keep synchronous credential loaders off the HTTP loop
 * and let cancellation terminate their descendants as well as the worker. */
export class PredictionPreparationPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  constructor(
    private url = new URL(
      "./prediction-preparation-worker.ts",
      import.meta.url,
    ),
    private ready?: () => void,
  ) {}
  get active() {
    return this.slots.filter((slot) => slot.job).length;
  }
  private refs(slot: Slot, active: boolean) {
    for (const stream of [slot.child.stdin, slot.child.stdout]) {
      const handle = stream as unknown as {
        ref?: () => void;
        unref?: () => void;
      };
      if (active) handle?.ref?.();
      else handle?.unref?.();
    }
  }
  private kill(slot: Slot): Promise<void> {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    try {
      if (slot.child.pid) process.kill(-slot.child.pid, "SIGKILL");
    } catch {
      slot.child.kill("SIGKILL");
    }
    return slot.exited;
  }
  run(input: PreparationJob, signal?: AbortSignal): Promise<Value> {
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("prediction aborted"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        input,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          const slot = this.slots.find((slot) => slot.job === job);
          signal?.removeEventListener("abort", job.abort);
          if (slot) {
            slot.job = undefined;
            void this.kill(slot).then(() =>
              reject(signal?.reason ?? new Error("prediction aborted")),
            );
          } else reject(signal?.reason ?? new Error("prediction aborted"));
          this.drain();
        },
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain() {
    while (this.queue.length) {
      let slot = this.slots.find((slot) => !slot.job);
      if (!slot) {
        if (this.slots.length >= 2) return;
        const child = spawn(process.execPath, [fileURLToPath(this.url)], {
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
        child.unref();
        const exited = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.once("error", () => resolve());
        });
        slot = { child, exited };
        this.slots.push(slot);
        const owned = slot;
        const fail = () => {
          const job = owned.job;
          owned.job = undefined;
          void this.kill(owned);
          if (job) {
            job.signal?.removeEventListener("abort", job.abort);
            job.reject(new Error("prediction preparation failed"));
          }
          this.drain();
        };
        let buffer = "";
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1000000) {
            fail();
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let data: { ready?: boolean; error?: boolean; value: Value };
            try {
              data = JSON.parse(line);
            } catch {
              fail();
              return;
            }
            if (data.ready) {
              this.ready?.();
              continue;
            }
            const job = owned.job;
            if (!job) continue;
            owned.job = undefined;
            job.signal?.removeEventListener("abort", job.abort);
            if (data.error)
              job.reject(new Error("prediction preparation failed"));
            else job.resolve(data.value);
            this.refs(owned, false);
            this.drain();
          }
        });
        child.once("error", fail);
        child.once("exit", fail);
        child.stdin!.on("error", fail);
      }
      slot.job = this.queue.shift()!;
      this.refs(slot, true);
      slot.child.stdin!.write(JSON.stringify(slot.job.input) + "\n");
    }
  }
  close() {
    const jobs = [
      ...this.queue,
      ...this.slots.flatMap((slot) => (slot.job ? [slot.job] : [])),
    ];
    this.queue = [];
    for (const slot of [...this.slots]) {
      slot.job = undefined;
      void this.kill(slot);
    }
    for (const job of jobs) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(new Error("prediction pool closed"));
    }
  }
}
const pool = new PredictionPreparationPool();

/** Parent owns SSH so cancelling a worker cannot orphan its retrieval process. */
async function remoteExamples(
  context: string,
  signal?: AbortSignal,
  deadlineMs = Date.now() + 12000,
): Promise<unknown[]> {
  signal?.throwIfAborted();
  const exporter =
    process.env.PREDICTION_FORGE_EXPORTER ??
    "/home/alex/.local/share/claude-codex-proxy/scripts/prediction-examples.ts";
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(exporter)) return [];
  const child = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=3",
      "forge",
      "/home/alex/.bun/bin/bun",
      join(dirname(exporter), "prediction-remote.ts"),
      exporter,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const kill = () => child.kill();
  signal?.addEventListener("abort", kill, { once: true });
  const remoteDeadline = Math.min(deadlineMs, Date.now() + 5000);
  const timer = setTimeout(kill, Math.max(0, remoteDeadline - Date.now()));
  try {
    signal?.throwIfAborted();
    child.stdin.write(
      JSON.stringify({ context, deadlineMs: remoteDeadline }) + "\n",
    );
    let output = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (output.length > 32000) {
        child.kill();
        return [];
      }
    }
    output += decoder.decode();
    signal?.throwIfAborted();
    if ((await child.exited) !== 0) return [];
    const result: unknown = JSON.parse(output);
    return Array.isArray(result) ? result.slice(0, 4) : [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    child.kill();
    await child.exited;
  }
}

export async function preparePrediction(
  context: string,
  examples: unknown[] | undefined,
  signal?: AbortSignal,
  deadlineMs = Date.now() + 12000,
): Promise<PreparedPrediction> {
  if (examples === undefined && hostname() !== "forge") {
    // Do not transmit raw context to retrieval until its secret check has passed.
    const checked = (await pool.run(
      { kind: "prepare", context, examples: [] },
      signal,
    )) as PreparedPrediction;
    if (!checked.prompt) return checked;
    const start = performance.now();
    const found = await remoteExamples(context, signal, deadlineMs);
    const retrievalMs = performance.now() - start;
    const prepared = (await pool.run(
      { kind: "prepare", context, examples: found },
      signal,
    )) as PreparedPrediction;
    return {
      ...prepared,
      retrievalMs,
      guardMs: checked.guardMs + prepared.guardMs,
    };
  }
  return (await pool.run(
    { kind: "prepare", context, examples },
    signal,
  )) as PreparedPrediction;
}
export async function guardPredictionReply(
  reply: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await pool.run({ kind: "reply", reply }, signal)) as boolean;
}

export function closePredictionPreparation(): void {
  pool.close();
}
