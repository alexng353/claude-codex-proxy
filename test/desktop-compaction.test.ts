import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { alexCreateCompactionQueue } = require("../desktop/compaction/queue.cjs");
const id = "01a10494-b499-7af3-986b-3c30d8c94b91";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compact-test-"));
  const file = join(dir, "status.json");
  let status = "active", calls = 0, reads = 0;
  const handlers: ((event: any) => void)[] = [];
  const connection = {
    registerInternalNotificationHandler(handler: (event: any) => void) { handlers.push(handler); return () => {}; },
    async readThread() { reads++; return { status: { type: status } }; },
    async resumeThread() { status = "idle"; },
    async sendAppServerRequest(method: string) { expect(method).toBe("thread/compact/start"); calls++; },
  };
  return { file, connection, queue: () => alexCreateCompactionQueue({ file, fs, client: () => connection }),
    status: (next: string) => { status = next; }, calls: () => calls, reads: () => reads,
    emit: (event: any) => handlers.forEach(h => h(event)),
    record: () => JSON.parse(fs.readFileSync(file, "utf8"))[id],
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("active chat queues once and starts only after it becomes idle", async () => {
  const f = fixture();
  try {
    const q = f.queue();
    expect((await q.request(id)).state).toBe("queued");
    expect((await q.request(id)).duplicate).toBe(true);
    f.emit({ method: "turn/completed", params: { threadId: id } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(0);
    f.status("idle");
    f.emit({ method: "thread/status/changed", params: { threadId: id } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(1);
    expect(f.record().state).toBe("started");
    f.emit({ method: "item/completed", params: { threadId: id, item: { type: "contextCompaction" } } });
    expect(f.record().state).toBe("completed");
  } finally { f.cleanup(); }
});

test("queued requests survive restart; accepted ones never replay", async () => {
  const f = fixture();
  try {
    await f.queue().request(id);
    f.status("idle");
    f.queue().restore();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(1);
    f.queue().restore();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(1);
    expect(f.record().state).toBe("interrupted");
  } finally { f.cleanup(); }
});

test("admission failures persist and simultaneous requests coalesce", async () => {
  const f = fixture();
  try {
    f.status("idle");
    f.connection.sendAppServerRequest = async () => { throw Error("RPC unavailable"); };
    const q = f.queue();
    const results = await Promise.allSettled([q.request(id), q.request(id)]);
    expect(results[0].status).toBe("rejected");
    expect(f.reads()).toBe(1);
    expect(f.record().state).toBe("failed");
    expect(f.record().error).toBe("RPC unavailable");
    await expect(q.request("not-a-thread")).rejects.toThrow("UUID");
  } finally { f.cleanup(); }
});
