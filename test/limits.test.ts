import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(defaultConfig = true) {
  const dir = await mkdtemp(join(tmpdir(), "claude-limits-test-"));
  directories.push(dir);
  const cli = join(dir, "claude");
  await writeFile(cli, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (process.argv.includes("auth")) {
  if (existsSync("${dir}/require-unset") && process.env.CLAUDE_CONFIG_DIR) process.exit(1);
  console.log(JSON.stringify({loggedIn:true,email:existsSync("${dir}/switched")?"other@example.com":"test@example.com"}));
} else if (process.argv.includes("--version")) {
  console.log(existsSync("${dir}/old-cli") ? "2.1.100 (Claude Code)" : "2.1.285 (Claude Code)");
} else {
  appendFileSync("${dir}/probes", "probe\\n");
  appendFileSync("${dir}/invocations", JSON.stringify(process.argv.slice(2)) + "\\n");
  if (!process.argv.includes("--no-session-persistence")) process.exit(1);
  if (!process.argv.includes("/usage") || process.argv.includes("--model")) process.exit(1);
  if (!process.argv.includes("--safe-mode")) process.exit(1);
  if (existsSync("${dir}/unavailable")) {
    console.log(JSON.stringify({type:"result",is_error:true,result:"Usage unavailable"}));
  } else {
    console.log(JSON.stringify({type:"assistant",local_command_run:{command:"usage",args:""},usage_report:{session:{total_cost_usd:0,total_api_duration_ms:0,model_usage:{}},rate_limits:{limits:[{kind:"session",group:"session",percent:42,resets_at:new Date(Date.now()+3600_000).toISOString()},{kind:"weekly_all",group:"weekly",percent:12.5,resets_at:null},{kind:"weekly_scoped",group:"weekly",percent:0,resets_at:null,scope:{model:{display_name:"Fable"}}}]}}}));
    console.log(JSON.stringify({type:"result",is_error:false,num_turns:0,total_cost_usd:0,modelUsage:{}}));
  }
}
`);
  await chmod(cli, 0o755);
  let accounts: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ accounts }) });
  async function run(...args: string[]) {
    const env = { ...process.env, HOST: "127.0.0.1", PORT: String(server.port), CLAUDE_BIN: cli,
      CLAUDE_CONFIG_DIR: join(dir, "config"), PROXY_STATE_DIR: join(dir, "state") };
    if (!defaultConfig) delete (env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/limits.ts"), ...args], {
      env,
      stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    return output;
  }
  const cachePath = join(dir, "state/limits-cache/default.json");
  async function editCache(edit: (cached: any) => void) {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    edit(cached);
    await writeFile(cachePath, JSON.stringify(cached));
  }
  return { dir, cli, server, run, editCache, setAccounts: (rows: unknown[]) => { accounts = rows; },
    count: async () => (await readFile(join(dir, "probes"), "utf8")).trim().split("\n").length };
}

test("reuses probe results and --probe refreshes them", async () => {
  const f = await fixture();
  try {
    expect(await f.run()).toContain("42%");
    const output = await f.run();
    expect(output).toContain("12.5%");
    expect(output).toContain("weekly_scoped (Fable) ░░░░░░░░░░     0%");
    expect(await f.run()).toContain("[cache, seen 0m ago]");
    expect(await f.count()).toBe(1);
    expect(await f.run("--probe")).toContain("[usage");
    expect(await f.count()).toBe(2);
    const calls = (await readFile(join(f.dir, "invocations"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual(Array(2).fill(["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--safe-mode", "--tools", "", "--strict-mcp-config"]));
  } finally { f.server.stop(true); }
});

test("--record appends every account's sample and --quiet hides the display", async () => {
  const f = await fixture();
  try {
    expect(await f.run("--probe", "--record", "--quiet")).toBe("");
    expect(await f.run("--probe", "--record")).toContain("42%");
    const lines = (await readFile(join(f.dir, "state/limits-history.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.account).toBe("default");
      expect(line.email).toBe("test@example.com");
      expect(Date.parse(line.recordedAt)).toBeGreaterThan(0);
      expect(line.windows.five_hour.usedPercent).toBe(42);
      expect(line.windows.seven_day.usedPercent).toBe(12.5);
    }
    expect(await f.count()).toBe(2);
  } finally { f.server.stop(true); }
});

test("an old CLI is rejected before issuing an unsupported slash command", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "old-cli"), "");
    expect(await f.run()).toContain("requires Claude Code 2.1.282+");
    expect(await Bun.file(join(f.dir, "probes")).exists()).toBe(false);
  } finally { f.server.stop(true); }
});

test("a different logged-in account cannot reuse the previous account's cache", async () => {
  const f = await fixture();
  try {
    await f.run();
    await writeFile(join(f.dir, "switched"), "");
    expect(await f.run()).toContain("other@example.com  [usage");
    expect(await f.count()).toBe(2);
  } finally { f.server.stop(true); }
});

test("preserves unset CLAUDE_CONFIG_DIR for the default login", async () => {
  const f = await fixture(false);
  try {
    await writeFile(join(f.dir, "require-unset"), "");
    expect(await f.run()).toContain("test@example.com  [usage");
    expect(await f.run()).toContain("test@example.com  [cache");
    expect(await f.count()).toBe(1);
  } finally { f.server.stop(true); }
});

test("expired probes and quota resets trigger refresh", async () => {
  const f = await fixture();
  try {
    await f.run();
    await f.editCache((cached) => { cached.row.observedAt = new Date(Date.now() - 301_000).toISOString(); });
    expect(await f.run()).toContain("[usage");
    expect(await f.count()).toBe(2);
    await f.editCache((cached) => {
      cached.row.observedAt = new Date(Date.now() - 2000).toISOString();
      cached.row.windows.five_hour.resetsAt = new Date(Date.now() - 1000).toISOString();
    });
    expect(await f.run()).toContain("[usage");
    expect(await f.count()).toBe(3);
  } finally { f.server.stop(true); }
});

test("uses the newest observation and --probe bypasses proxy data too", async () => {
  const f = await fixture();
  try {
    await f.run();
    const row = { name: "default", observedAt: new Date(Date.now() - 60_000).toISOString(),
      windows: { five_hour: { usedPercent: 17, resetsAt: new Date(Date.now() + 3600_000).toISOString() } } };
    f.setAccounts([row]);
    expect(await f.run()).toContain("42%");
    await f.editCache((cached) => { cached.row.observedAt = new Date(Date.now() - 120_000).toISOString(); });
    f.setAccounts([{ ...row, observedAt: new Date().toISOString() }]);
    const output = await f.run();
    expect(output).toContain("17%");
    expect(output).toContain("weekly_scoped (Fable)");
    expect(output).toContain("[proxy + cache, seen 0m ago]");
    expect(output).toContain("(cache, seen 2m ago)");
    expect(await f.count()).toBe(1);
    expect(await f.run("--probe")).toContain("42%");
    expect(await f.count()).toBe(2);
  } finally { f.server.stop(true); }
});

test("queries scoped usage even when the proxy already has overall limits", async () => {
  const f = await fixture();
  try {
    f.setAccounts([{ name: "default", observedAt: new Date().toISOString(),
      windows: { five_hour: { usedPercent: 17, resetsAt: null } } }]);
    expect(await f.run()).toContain("weekly_scoped (Fable)");
    expect(await f.count()).toBe(1);
    expect(await f.run()).toContain("weekly_scoped (Fable)");
    expect(await f.count()).toBe(1);
  } finally { f.server.stop(true); }
});

test("a failed scoped refresh keeps valid proxy usage visible", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "unavailable"), "");
    f.setAccounts([{ name: "default", observedAt: new Date().toISOString(),
      windows: { five_hour: { usedPercent: 17, resetsAt: null } } }]);
    const output = await f.run();
    expect(output).toContain("[proxy");
    expect(output).toContain("17%");
    expect(await f.count()).toBe(1);
  } finally { f.server.stop(true); }
});

test("scoped usage refresh and cache reads preserve an explicit proxy rejection", async () => {
  const f = await fixture();
  try {
    f.setAccounts([{ name: "default", observedAt: new Date(Date.now() - 60_000).toISOString(),
      limitedUntil: new Date(Date.now() + 1200_000).toISOString(),
      windows: { five_hour: { usedPercent: 17, resetsAt: null } } }]);
    for (const args of [[], [], ["--probe"]]) {
      const output = await f.run(...args);
      expect(output).toContain("weekly_scoped (Fable)");
      expect(output).toContain("LIMITED until");
    }
    expect(await f.count()).toBe(2);
  } finally { f.server.stop(true); }
});

test("an unwritable cache cannot hide a successful live result", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "state"));
    await writeFile(join(f.dir, "state/limits-cache"), "occupied");
    expect(await f.run()).toContain("42%");
  } finally { f.server.stop(true); }
});

test("does not display pre-reset proxy usage", async () => {
  const f = await fixture();
  try {
    f.setAccounts([{ name: "default", observedAt: new Date(Date.now() - 2000).toISOString(),
      windows: { five_hour: { usedPercent: 100, resetsAt: new Date(Date.now() - 1000).toISOString() } } }]);
    const output = await f.run();
    expect(output).toContain("42%");
    expect(output).not.toContain("100%");
    expect(await f.count()).toBe(1);
  } finally { f.server.stop(true); }
});

test("auth timeout kills descendants holding output pipes", async () => {
  const f = await fixture();
  try {
    await writeFile(f.cli, '#!/bin/sh\nif [ "$1" = auth ]; then sleep 30 & wait; fi\n');
    f.setAccounts([{ name: "default", observedAt: new Date().toISOString(),
      windows: { five_hour: { usedPercent: 17, resetsAt: null } } }]);
    const start = performance.now();
    expect(await f.run()).toContain("unknown  [proxy");
    expect(performance.now() - start).toBeLessThan(8000);
  } finally { f.server.stop(true); }
}, 10_000);

test("unavailable local usage never falls back to a model turn or caches empty data", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "unavailable"), "");
    expect(await f.run()).toContain("usage unavailable");
    expect(await f.run()).toContain("usage unavailable");
    expect(await f.count()).toBe(2);
    const calls = (await readFile(join(f.dir, "invocations"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual(Array(2).fill(["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--safe-mode", "--tools", "", "--strict-mcp-config"]));
  } finally { f.server.stop(true); }
});
