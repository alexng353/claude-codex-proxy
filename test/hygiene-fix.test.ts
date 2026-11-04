import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixStatus, type FixRef } from "../src/hygiene-fix";
test("read-only q and ledger checks distinguish missing, open, and terminal repairs", () => {
  const dir = mkdtempSync(join(tmpdir(), "fix-ref-"));
  const savedQ = process.env.HYGIENE_QUEUE_DB,
    savedT = process.env.HYGIENE_TASK_DB;
  const path = join(dir, "repairs.sqlite");
  const db = new Database(path);
  try {
    process.env.HYGIENE_QUEUE_DB = path;
    process.env.HYGIENE_TASK_DB = path;
    db.run("CREATE TABLE items (id TEXT, state TEXT)");
    db.run(
      "CREATE TABLE tasks (n INTEGER, target TEXT, status TEXT, receipt TEXT)",
    );
    db.run("INSERT INTO items VALUES ('repair','claimed')");
    const q: FixRef = { kind: "q", id: "repair" };
    expect(readFixStatus(q)).toBe("open");
    db.run("UPDATE items SET state='done'");
    expect(readFixStatus(q)).toBe("closed");
    db.run("UPDATE items SET state='cancelled'");
    expect(readFixStatus(q)).toBe("closed");
    expect(readFixStatus({ kind: "q", id: "absent" })).toBe("missing");
    const chat: FixRef = {
      kind: "chat",
      id: "chat",
      eta: "2099-01-01T00:00:00Z",
    };
    expect(readFixStatus(chat)).toBe("missing");
    db.run("INSERT INTO tasks VALUES (1,'chat','running',NULL)");
    expect(readFixStatus(chat)).toBe("open");
    expect(chat.task).toBe(1);
    db.run("INSERT INTO tasks VALUES (2,'chat','running',NULL)");
    expect(readFixStatus({ kind: "chat", id: "chat", eta: chat.eta })).toBe(
      "ambiguous",
    );
    db.run("UPDATE tasks SET status='done', receipt='{}' WHERE n=2");
    expect(readFixStatus(chat)).toBe("open");
    db.run("UPDATE tasks SET status='done' WHERE n=1");
    expect(readFixStatus(chat)).toBe("awaiting_receipt");
    db.run("UPDATE tasks SET status='cancelled' WHERE n=1");
    expect(readFixStatus(chat)).toBe("closed");
    db.run("UPDATE tasks SET receipt='{}' WHERE n=1");
    expect(readFixStatus(chat)).toBe("closed");
  } finally {
    db.close();
    if (savedQ === undefined) delete process.env.HYGIENE_QUEUE_DB;
    else process.env.HYGIENE_QUEUE_DB = savedQ;
    if (savedT === undefined) delete process.env.HYGIENE_TASK_DB;
    else process.env.HYGIENE_TASK_DB = savedT;
    rmSync(dir, { recursive: true, force: true });
  }
});
