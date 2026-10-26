import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardData, dashboardHandler } from "../src/dashboard";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("dashboard reload reads new quota samples and turns without modifying telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-dashboard-"));
  dirs.push(dir);
  const now = Date.now();
  const sample = JSON.stringify({
    recordedAt: new Date(now).toISOString(),
    account: "work",
    email: "private@example.com",
    windows: { five_hour: { usedPercent: 12, resetsAt: null } },
  });
  await writeFile(join(dir, "limits-history.jsonl"), sample + "\n{partial");
  const db = new Database(join(dir, "usage.sqlite"));
  db.exec(
    "CREATE TABLE turns (ts INTEGER, account TEXT, model TEXT, is_error INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL)",
  );
  db.exec(
    `INSERT INTO turns VALUES (${now}, 'work', 'opus', 0, 10, 20, 30, 40, 0.05)`,
  );
  db.close();
  const first = dashboardData(dir, now);
  expect(first.samples).toHaveLength(1);
  expect(first.samples[0]).toMatchObject({
    a: "work",
    w: { five_hour: { v: 12 } },
  });
  expect(first.turns[0]).toMatchObject({
    a: "work",
    i: 10,
    o: 20,
    cr: 30,
    cw: 40,
    c: 0.05,
  });
  expect(JSON.stringify(first)).not.toContain("private@example.com");
  const updated = JSON.parse(sample);
  updated.windows.five_hour.usedPercent = 25;
  const history = sample + "\n" + JSON.stringify(updated) + "\n";
  await writeFile(join(dir, "limits-history.jsonl"), history);
  const writer = new Database(join(dir, "usage.sqlite"));
  writer.exec(
    `INSERT INTO turns VALUES (${now}, 'work', 'opus', 0, 50, 60, 70, 80, 0.10)`,
  );
  writer.close();
  const second = dashboardData(dir, now);
  expect(second.samples).toHaveLength(2);
  expect(second.samples[1].w.five_hour.v).toBe(25);
  expect(second.turns.map((turn) => turn.o)).toEqual([20, 60]);
  expect(await readFile(join(dir, "limits-history.jsonl"), "utf8")).toBe(
    history,
  );
  const stored = new Database(join(dir, "usage.sqlite"), { readonly: true });
  try {
    expect(
      stored
        .query("SELECT output_tokens, cost_usd FROM turns ORDER BY rowid")
        .all(),
    ).toEqual([
      { output_tokens: 20, cost_usd: 0.05 },
      { output_tokens: 60, cost_usd: 0.1 },
    ]);
  } finally {
    stored.close();
  }
});

test("missing telemetry renders an empty dashboard; malformed lines and old records are excluded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-dashboard-"));
  dirs.push(dir);
  expect(dashboardData(dir).turns).toEqual([]);
  expect(dashboardData(dir).samples).toEqual([]);
  await writeFile(
    join(dir, "limits-history.jsonl"),
    JSON.stringify({
      recordedAt: "2000-01-01T00:00:00Z",
      account: "old",
      windows: {},
    }) + "\n{}\nbad\n",
  );
  expect(dashboardData(dir).samples).toEqual([]);
});

test("cached quota readings retain their observation times rather than their recording time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-dashboard-"));
  dirs.push(dir);
  const now = Date.now(),
    overall = now - 3600_000,
    scoped = now - 7200_000;
  await writeFile(
    join(dir, "limits-history.jsonl"),
    JSON.stringify({
      recordedAt: new Date(now).toISOString(),
      observedAt: new Date(overall).toISOString(),
      account: "work",
      windows: {
        five_hour: { usedPercent: 30 },
        scoped: { usedPercent: 12, observedAt: new Date(scoped).toISOString() },
      },
    }) + "\n",
  );
  const row = dashboardData(dir, now).samples[0];
  expect(row.t).toBe(now);
  expect(row.w.five_hour.t).toBe(overall);
  expect(row.w.scoped.t).toBe(scoped);
});

test("dashboard serves fresh data with no caching and rejects foreign hosts and origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-dashboard-"));
  dirs.push(dir);
  const handler = dashboardHandler(dir);
  const response = await handler(new Request("http://127.0.0.1:3458/data"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).turns).toEqual([]);
  expect(
    (await handler(new Request("http://attacker.example:3458/data"))).status,
  ).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1:3458/data", {
          headers: { origin: "https://attacker.example" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handler(
        new Request("http://127.0.0.1:3458/data", { method: "POST" }),
      )
    ).status,
  ).toBe(405);
});

test("account names cannot inject HTML or replacement tokens into the dashboard page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-dashboard-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "limits-history.jsonl"),
    JSON.stringify({
      recordedAt: new Date().toISOString(),
      account: "</script><script>bad()</script>$&",
      windows: {},
    }) + "\n",
  );
  const response = await dashboardHandler(dir)(
    new Request("http://127.0.0.1:3458/"),
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain("</script><script>bad()");
  expect(html).toContain("\\u003c/script>\\u003cscript>bad()\\u003c/script>$&");
});
