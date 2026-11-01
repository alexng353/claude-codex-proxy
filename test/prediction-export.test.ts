import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("source export preserves Today origin and excludes immutable Cairn generated facts while advancing cursors", async () => {
  const home = mkdtempSync(join(tmpdir(), "prediction-export-"));
  const todayPath = join(home, "today.sqlite");
  const today = new Database(todayPath);
  today.exec(
    "CREATE TABLE threads(thread_id TEXT); CREATE TABLE events(id TEXT,thread_id TEXT,seq INTEGER,at_ms INTEGER,actor TEXT,body TEXT)",
  );
  today.query("INSERT INTO threads VALUES (?)").run("today");
  today.query("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
    "generated",
    "today",
    1,
    1,
    "me",
    JSON.stringify({
      type: "user_message",
      client: "today-gpui",
      text: "generated reply",
      generated_origin: true,
    }),
  );
  today.query("INSERT INTO events VALUES (?,?,?,?,?,?)").run(
    "human",
    "today",
    2,
    2,
    "me",
    JSON.stringify({
      type: "user_message",
      client: "today-gpui",
      text: "my typed reply",
    }),
  );
  const envelopes = [
    "[Fork reconciliation] While forge was unreachable, Alex continued this thread",
    "[Side prompt] While you worked, Alex asked a few things on the side.",
    "<fork_conversation>transcript</fork_conversation>",
    "<side_conversation>transcript</side_conversation>",
    "Produce the catch-up summary from the supplied snapshot. Answer only; use no tools.",
  ];
  for (const [i, text] of envelopes.entries()) {
    today
      .query("INSERT INTO events VALUES (?,?,?,?,?,?)")
      .run(
        "envelope-" + i,
        "today",
        i + 3,
        i + 3,
        "me",
        JSON.stringify({ type: "user_message", client: "today-gpui", text }),
      );
  }
  today.close();
  mkdirSync(join(home, ".local/share/plate"), { recursive: true });
  const cairn = new Database(join(home, ".local/share/plate/cairn.sqlite"));
  cairn.exec(
    "CREATE TABLE items(id TEXT,url TEXT,owner TEXT,created_by TEXT,section TEXT,source TEXT,title TEXT,body TEXT,end_at TEXT,start_at TEXT,source_updated_at TEXT,created_at TEXT); CREATE TABLE oplog(id TEXT,entity_id TEXT,actor TEXT,hlc TEXT,body TEXT)",
  );
  cairn
    .query(
      "INSERT INTO items(id,url,owner,created_by,section,body) VALUES (?,?,?,?,?,?)",
    )
    .run(
      "out",
      "chat",
      "me",
      "me",
      "codexchat-out",
      "an agent later edited this",
    );
  cairn.query("INSERT INTO oplog VALUES (?,?,?,?,?)").run(
    "legacy-generated",
    "out",
    "me",
    "1000-0",
    JSON.stringify({
      set: {
        body: "legacy generated reply",
        facts: ["generated_origin=true"],
      },
    }),
  );
  for (const [i, text] of envelopes.entries()) {
    cairn
      .query("INSERT INTO oplog VALUES (?,?,?,?,?)")
      .run(
        "envelope-" + i,
        "out",
        "me",
        "1000-0",
        JSON.stringify({ set: { body: text } }),
      );
  }
  cairn.close();
  const exportRows = async (cursors: Record<string, number>) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/prediction-export.ts"),
        todayPath,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: home, PATH: process.env.PATH, SECRET_SCRUB_FILES: "" },
      },
    );
    child.stdin.write(JSON.stringify(cursors));
    await child.stdin.end();
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  try {
    const rows = await exportRows({});
    expect(rows.find((row) => row.id === "generated")?.generated_origin).toBe(
      true,
    );
    expect(rows.find((row) => row.id === "human")?.text).toBe("my typed reply");
    const legacy = rows.find((row) => row.id === "cairn:legacy-generated");
    expect(legacy?.generated_origin).toBe(true);
    expect(legacy?.text).toBe("");
    expect(legacy?.seq).toBe(2);
    expect(JSON.stringify(rows)).not.toContain("legacy generated reply");
    for (let i = 0; i < envelopes.length; i++) {
      for (const prefix of ["", "cairn:"]) {
        const row = rows.find((row) => row.id === prefix + "envelope-" + i);
        expect(row?.generated_origin).toBe(true);
        expect(row?.text).toBe("");
      }
    }
    const next = await exportRows({ today: 7, "cairn:chat": 12 });
    expect(next).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
