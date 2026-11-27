import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __test, wallToolCalls } from "../src/scratch-wall";
import { responseObject } from "../src/responses";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "../src/types";

const { declaredScratchRoot, tmpWriteTarget, sweepReaderTmp, noteReaderRun, defaultRunStart, runStarts, MAX_RUNS, logViolation } = __test;
type Violation = { rule: string; evidence: string; threadId: string; proposedCheck: string };

// Every path here lives under the preload's private TMPDIR: the real /tmp is only
// ever named in command strings, never touched.
let base: string;
let fakeTmp: string;
let work: string;
const saved = { base: process.env.SCRATCH_WALL_BASE, tmp: process.env.SCRATCH_WALL_TMP };

beforeEach(() => {
  work = mkdtempSync(join(process.env.TMPDIR!, "scratch-wall-"));
  base = join(work, "agent-tmp");
  fakeTmp = join(work, "fake-tmp");
  mkdirSync(base, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  process.env.SCRATCH_WALL_BASE = base;
  process.env.SCRATCH_WALL_TMP = fakeTmp;
});
afterEach(() => {
  for (const [key, value] of [["SCRATCH_WALL_BASE", saved.base], ["SCRATCH_WALL_TMP", saved.tmp]] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const tools = [{ type: "function", name: "exec_command", parameters: {} }, { type: "custom", name: "apply_patch" }];
const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const context: ResponseInputItem[] = [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] },
  user("# AGENTS.md instructions for /home/alex\n\nScratch root: /home/alex/.cache/agent-tmp/never-from-context"),
  user("<environment_context>\n  <cwd>/home/alex</cwd>\n</environment_context>"),
];
const spawnMessage = (root: string) =>
  `Your complete task is in ${root}/prompt.md. Read it completely and follow it exactly.\nScratch root: ${root}`;
const readerRequest = (root: string, extra: ResponseInputItem[] = [], thread = "01a2-reader-thread"): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: thread,
  tools,
  input: [...context, user(spawnMessage(root)), ...extra],
});
const plainRequest = (extra: ResponseInputItem[] = []): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: "01a2-plain-chat",
  tools,
  input: [...context, user("Please look at the build."), ...extra],
});
const exec = (cmd: string): ProxyOutput => ({
  text: "",
  toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd, yield_time_ms: 1000 }), callId: "call_1" }],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const cmdOf = (output: ProxyOutput, index = 0) => JSON.parse(output.toolCalls[index].arguments).cmd as string;
const final = (text = "NONCE abc\nSTATUS: COMPLETE"): ProxyOutput => ({ text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
const call = (cmd: string, out = "", id = "c1"): ResponseInputItem[] => [
  { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) },
  { type: "function_call_output", call_id: id, output: out },
];

// ---- R1-H1: the declaration comes only from the chat's own task ----

describe("declared scratch root", () => {
  test("v1: the spawn message, the first user message after Codex's context, declares it", () => {
    const root = join(base, "comb-x/p1_claude__abcdef012345");
    expect(declaredScratchRoot(readerRequest(root))).toBe(root);
    // Without injected context the first message is the task.
    expect(declaredScratchRoot({ model: "m", input: [user(spawnMessage(root))] })).toBe(root);
  });

  test("v2: the NEW_TASK agent message's validated task file declares it", () => {
    const tasks = mkdtempSync(join(process.env.TMPDIR!, "tasks-"));
    const previous = process.env.AGENT_TASKS_DIR;
    process.env.AGENT_TASKS_DIR = tasks;
    try {
      const root = join(base, "comb-y/p2_claude__0123456789ab");
      writeFileSync(join(tasks, "p2_claude__0123456789ab.md"), `Handshake nonce: 1\nScratch root: ${root}\n`, { mode: 0o600 });
      const request: ResponsesRequest = {
        model: "claude-opus-5-5",
        prompt_cache_key: "01a2-v2",
        input: [...context, {
          type: "agent_message", author: "/root", recipient: "/root/p2_claude__0123456789ab",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nTask name: p2_claude__0123456789ab\nPayload:" },
            { type: "encrypted_content", encrypted_content: "gAAAA" },
          ],
        }],
      };
      expect(declaredScratchRoot(request)).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.AGENT_TASKS_DIR;
      else process.env.AGENT_TASKS_DIR = previous;
    }
  });

  const line = () => `Scratch root: ${base}/comb-q/p1_claude__aaaaaaaaaaaa`;
  test("a later user message declares nothing", () => {
    expect(declaredScratchRoot(plainRequest([user(line())]))).toBeUndefined();
  });
  test("a <codex_delegation> relay declares nothing, later or first", () => {
    const relay = `<codex_delegation>\n  <input>Brief for the reader:\n${line()}\n</input>\n</codex_delegation>`;
    expect(declaredScratchRoot(plainRequest([user(relay)]))).toBeUndefined();
    expect(declaredScratchRoot({ model: "m", input: [...context, user(relay)] })).toBeUndefined();
  });
  test("a <subagent_notification> declares nothing, later or first", () => {
    const note = `<subagent_notification>\n{"agent":"p1"}\n${line()}\n</subagent_notification>`;
    expect(declaredScratchRoot(plainRequest([user(note)]))).toBeUndefined();
    expect(declaredScratchRoot({ model: "m", input: [...context, user(note)] })).toBeUndefined();
  });
  test("a fenced block declares nothing, later or in the first message", () => {
    const fenced = "Here is the template:\n```text\n" + line() + "\n```";
    expect(declaredScratchRoot(plainRequest([user(fenced)]))).toBeUndefined();
    expect(declaredScratchRoot({ model: "m", input: [...context, user(fenced)] })).toBeUndefined();
  });
  test("a child's agent_message to its parent declares nothing", () => {
    const child: ResponseInputItem = {
      type: "agent_message", author: "/root/p1_claude__aaaaaaaaaaaa", recipient: "/root",
      content: [{ type: "input_text", text: `Message Type: FINAL\nPayload:\n${line()}` }],
    };
    expect(declaredScratchRoot(plainRequest([child]))).toBeUndefined();
    // Even as the first item: only a NEW_TASK served from its task file is a task.
    expect(declaredScratchRoot({ model: "m", input: [...context, child] })).toBeUndefined();
  });
  test("Codex's own context declares nothing", () => {
    expect(declaredScratchRoot(plainRequest())).toBeUndefined();
  });
  test("a placeholder, a path outside the base, the base itself, or tool output: none", () => {
    const first = (text: string): ResponsesRequest => ({ model: "m", input: [...context, user(text)] });
    expect(declaredScratchRoot(first("Scratch root: <scratch>/r/<name>"))).toBeUndefined();
    expect(declaredScratchRoot(first("Scratch root: /tmp/comb-x"))).toBeUndefined();
    expect(declaredScratchRoot(first(`Scratch root: ${base}/../escape`))).toBeUndefined();
    expect(declaredScratchRoot(first(`Scratch root: ${base}`))).toBeUndefined();
    expect(declaredScratchRoot(plainRequest(call("cat x", `Scratch root: ${base}/comb-z/r`)))).toBeUndefined();
  });
});

// ---- R1-M3: write targets, exact ----

describe("tmp write targets", () => {
  const refused: Array<[string, string]> = [
    ["echo x > /tmp/probe.out", "/tmp/probe.out"],
    ["echo x >/tmp/probe.out", "/tmp/probe.out"],
    ["echo x >> /tmp/probe.out", "/tmp/probe.out"],
    ["bun test 2>/tmp/err.txt", "/tmp/err.txt"],
    ["bun test &> /tmp/all.txt", "/tmp/all.txt"],
    ["echo x >| /tmp/probe.out", "/tmp/probe.out"],
    ["echo x > '/tmp/probe.out'", "/tmp/probe.out"],
    ["echo x > \"/tmp/probe.out\"", "/tmp/probe.out"],
    ["ls | tee /tmp/list.txt", "/tmp/list.txt"],
    ["ls | tee -a /tmp/list.txt", "/tmp/list.txt"],
    ["ls | tee out.txt /tmp/second", "/tmp/second"],
    ["curl -o /tmp/page.html https://example.com", "/tmp/page.html"],
    ["curl -o/tmp/page.html https://example.com", "/tmp/page.html"],
    ["wget -O /tmp/page.html https://example.com", "/tmp/page.html"],
    ["wget --output-document=/tmp/page.html https://example.com", "/tmp/page.html"],
    ["oxlint --output /tmp/lint.txt", "/tmp/lint.txt"],
    ["oxlint --output=/tmp/lint.txt", "/tmp/lint.txt"],
    ["cargo build --log-file /tmp/build.log", "/tmp/build.log"],
    ["gcc -o /tmp/a.out x.c", "/tmp/a.out"],
    ["mkdir -p /tmp/comb-x", "/tmp/comb-x"],
    ["touch /tmp/marker", "/tmp/marker"],
    ["true; mkdir /tmp/y", "/tmp/y"],
    ["env FOO=1 touch /tmp/m", "/tmp/m"],
    ["mktemp -d /tmp/comb.XXXX", "/tmp/comb.XXXX"],
    ["mktemp -p /tmp", "/tmp"],
    ["mktemp --tmpdir=/tmp x.XXXX", "/tmp"],
    ["dd if=/dev/zero of=/tmp/b bs=1 count=1", "/tmp/b"],
    ["cd repo && git diff > /tmp/diff.patch", "/tmp/diff.patch"],
    ["cat > /tmp/notes <<'EOF'\nhello\nEOF", "/tmp/notes"],
  ];
  for (const [cmd, target] of refused) test(`refuses ${JSON.stringify(cmd)} at ${target}`, () => expect(tmpWriteTarget(cmd)).toBe(target));

  const allowed = [
    "cat /tmp/probe.out",
    "ls -la /tmp/",
    "grep -r foo /tmp/comb-x < /tmp/in.txt",
    "echo x > /home/alex/.cache/agent-tmp/t/probe.out",
    "echo x > \"$TMPDIR/probe.out\"",
    "mktemp -d",
    "bun test 2>&1 | tail -5",
    "echo x >/dev/null",
    "mv /tmp/probe.out /home/alex/.cache/agent-tmp/t/",
    "echo '/tmp/not-a-target'",
    "printf '%s' 'echo x > /tmp/example'",
    "cat <<'TEXT'\necho x > /tmp/example\nTEXT",
    "cat <<-EOF\n\ttee /tmp/x\n\tEOF",
    "git commit -m 'never write > /tmp/foo'",
    "rg --fixed-strings 'tee /tmp/example' src",
    "grep -o /tmp/x log.txt",
    "rg -o '/tmp/[a-z]+' log",
    "rg mkdir /tmp/x.log",
    "rg touch /tmp/x.log",
    "ssh h 'cat > /tmp/remote'",
    "echo x > /tmpfoo",
    "echo x > /var/tmp/x",
    "tee /dev/null < notes",
  ];
  for (const cmd of allowed) test(`allows ${JSON.stringify(cmd)}`, () => expect(tmpWriteTarget(cmd)).toBeUndefined());
});

// ---- the wall on tool calls: R1-M4 (no rewrite), R1-M2 (repaired arguments) ----

describe("the wall on a reader's tool calls", () => {
  test("a reader's /tmp write is replaced by a refusal naming the root, in plain words", () => {
    const root = join(base, "comb-x/p1");
    const walled = wallToolCalls(readerRequest(root), exec("echo x > /tmp/probe.out"));
    const cmd = cmdOf(walled);
    expect(cmd).not.toContain("echo x >");
    // Only words, quotes and && (codex-rs shell-command/src/bash.rs:29-94), so Codex's
    // exec policy still splits it like any plain command.
    expect(cmd).toMatch(/^printf '%s\\n' '[^']*' && false$/);
    const run = Bun.spawnSync(["bash", "-c", cmd]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(`Scratch root: ${root}`);
    expect(run.stdout.toString()).toContain("/tmp/probe.out");
    expect(JSON.parse(walled.toolCalls[0].arguments).yield_time_ms).toBe(1000);
  });

  test("a reader's other commands are passed on byte for byte: no TMPDIR prefix (R1-M4)", () => {
    const root = join(base, "comb-x/p1");
    for (const cmd of ["git push --force origin main", "apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF", `echo x > ${root}/probe.out`]) {
      const output = exec(cmd);
      expect(wallToolCalls(readerRequest(root), output).toolCalls[0]).toBe(output.toolCalls[0]);
    }
  });

  test("a raw-newline cmd that writes /tmp is refused on the arguments responses.ts emits (R1-M2)", () => {
    const root = join(base, "comb-x/p1");
    const request = readerRequest(root);
    const raw: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "exec_command", arguments: '{"cmd":"echo first\necho x > /tmp/bypass.out"}', callId: "call_raw" }] };
    expect(() => JSON.parse(raw.toolCalls[0].arguments)).toThrow();
    const response = responseObject(request, wallToolCalls(request, raw));
    const item = response.output.find((entry) => entry.type === "function_call") as { arguments: string };
    const cmd = JSON.parse(item.arguments).cmd as string;
    expect(cmd).toContain("scratch-tmp-wall: refused");
    expect(cmd).toContain("/tmp/bypass.out");
    expect(cmd).not.toContain("echo first");
  });

  test("a chat without a declared root is untouched, byte for byte", () => {
    const output = exec("echo x > /tmp/probe.out");
    expect(wallToolCalls(plainRequest(), output)).toBe(output);
  });

  test("a later relayed declaration does not wall an ordinary chat (R1-H1)", () => {
    const output = exec("cargo test 2>/tmp/err.txt");
    const relay = `<codex_delegation><input>\nScratch root: ${base}/comb-x/p1\n</input></codex_delegation>`;
    expect(wallToolCalls(plainRequest([user(relay)]), output)).toBe(output);
  });

  test("tools other than exec_command pass through", () => {
    const root = join(base, "comb-x/p1");
    const output: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "apply_patch", arguments: "*** Begin Patch\n*** End Patch\n" }] };
    expect(wallToolCalls(readerRequest(root), output).toolCalls).toEqual(output.toolCalls);
  });
});

// ---- R1-H2: the sweep reports and moves nothing; R1-L1 ----

describe("the exit sweep", () => {
  const past = () => Date.now() - 60_000;
  const collect = () => {
    const logged: Violation[] = [];
    return { logged, log: async (v: Violation) => { logged.push(v); return true; } };
  };

  test("reports the reader's own new /tmp entries, left in place, in one violation", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    mkdirSync(join(fakeTmp, "p1-render"));
    writeFileSync(join(fakeTmp, "p1-render", "a.yaml"), "a: 1");
    const { logged, log } = collect();
    const request = readerRequest(root, [...call("echo x > /tmp/probe.out"), ...call("helm template . --output-dir /tmp/p1-render/sub", "", "c2")]);
    const result = await sweepReaderTmp(request, final(), { runStart: past, log });
    expect(result?.left.sort()).toEqual([join(fakeTmp, "p1-render"), join(fakeTmp, "probe.out")]);
    expect(readFileSync(join(fakeTmp, "probe.out"), "utf8")).toBe("x");
    expect(readFileSync(join(fakeTmp, "p1-render", "a.yaml"), "utf8")).toBe("a: 1");
    expect(existsSync(join(root, "tmp-swept"))).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0].rule).toBe("Scratch goes under ~/.cache/agent-tmp/<task>; /tmp is RAM tmpfs");
    expect(logged[0].threadId).toBe("01a2-reader-thread");
    expect(logged[0].evidence).toContain("left in place");
    expect(logged[0].evidence).toContain("probe.out");
    expect(logged[0].evidence).toContain("p1-render");
  });

  test("names only in tool output or the answer are not candidates", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "seen-in-output"), "x");
    writeFileSync(join(fakeTmp, "seen-in-answer"), "x");
    const { logged, log } = collect();
    const request = readerRequest(root, call("ps -eo args", "bun /tmp/seen-in-output/x"));
    expect(await sweepReaderTmp(request, final("I saw /tmp/seen-in-answer"), { runStart: past, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
  });

  test("entries another process holds open or uses as cwd are skipped", async () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(join(fakeTmp, "live-build"));
    writeFileSync(join(fakeTmp, "live-log"), "");
    const cwdHolder = Bun.spawn(["sleep", "30"], { cwd: join(fakeTmp, "live-build") });
    const fdHolder = Bun.spawn(["bash", "-c", `exec 3>>'${join(fakeTmp, "live-log")}'; sleep 30`]);
    try {
      await Bun.sleep(150);
      const { logged, log } = collect();
      const request = readerRequest(root, [...call("cat /tmp/live-build/status > /tmp/live-log")]);
      expect(await sweepReaderTmp(request, final(), { runStart: past, log })).toBeUndefined();
      expect(logged).toHaveLength(0);
    } finally {
      cwdHolder.kill();
      fdHolder.kill();
    }
  });

  test("born before the run and only modified during it: skipped (R1-L1)", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "old.txt"), "old");
    const born = statSync(join(fakeTmp, "old.txt")).birthtimeMs;
    expect(born).toBeGreaterThan(0);
    const start = born + 10_000;
    utimesSync(join(fakeTmp, "old.txt"), new Date(start + 5_000), new Date(start + 5_000));
    const { logged, log } = collect();
    const request = readerRequest(root, call("echo >> /tmp/old.txt"));
    expect(await sweepReaderTmp(request, final(), { runStart: () => start, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
  });

  test("no birth time, another owner, or not a file, directory or link: skipped (R1-L1)", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    Bun.spawnSync(["mkfifo", join(fakeTmp, "pipe")]);
    const { logged, log } = collect();
    const request = readerRequest(root, call("echo > /tmp/probe.out"));
    // 0 or NaN: what a filesystem without birth times reports.
    for (const birth of [0, Number.NaN]) {
      const noBirth = (path: string) => {
        const stat = statSync(path);
        Object.defineProperty(stat, "birthtimeMs", { value: birth });
        return stat;
      };
      expect(await sweepReaderTmp(request, final(), { runStart: past, log, lstat: noBirth })).toBeUndefined();
    }
    expect(await sweepReaderTmp(request, final(), { runStart: past, log, uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
    const onlyPipe = readerRequest(root, call("echo > /tmp/pipe"));
    expect(await sweepReaderTmp(onlyPipe, final(), { runStart: past, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
    // The same entry with its birth time, this uid and a regular type is reported.
    expect((await sweepReaderTmp(request, final(), { runStart: past, log }))?.left).toEqual([join(fakeTmp, "probe.out")]);
  });

  test("at most 50 entries are looked at and 12 named, with a count of the rest", async () => {
    const root = join(base, "comb-x/p1");
    const cmds: ResponseInputItem[] = [];
    for (let i = 0; i < 60; i++) {
      const name = `f${String(i).padStart(2, "0")}`;
      writeFileSync(join(fakeTmp, name), "x");
      cmds.push(...call(`touch /tmp/${name}`, "", `c${i}`));
    }
    let stats = 0;
    const lstat = (path: string) => (stats++, statSync(path));
    const { logged, log } = collect();
    const result = await sweepReaderTmp(readerRequest(root, cmds), final(), { runStart: past, log, lstat });
    expect(stats).toBeLessThanOrEqual(50);
    expect(result?.left).toHaveLength(50);
    expect(logged[0].evidence).toContain("and 38 more");
  });

  test("not a final answer, or no declaration: nothing", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    const { logged, log } = collect();
    expect(await sweepReaderTmp(readerRequest(root, call("echo > /tmp/probe.out")), exec("ls"), { runStart: past, log })).toBeUndefined();
    expect(await sweepReaderTmp(plainRequest(call("echo > /tmp/probe.out")), final(), { runStart: past, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
  });
});

// ---- R1-L1: run start ----

describe("run start", () => {
  test("a declared reader's first sight is its run start, and later sights keep it", () => {
    const root = join(base, "comb-x/p1");
    const request = readerRequest(root, [], "01a2-run-start");
    noteReaderRun(request, 1_000_000);
    noteReaderRun(request, 2_000_000);
    expect(defaultRunStart("01a2-run-start", request)).toBe(1_000_000);
    noteReaderRun(plainRequest(), 3_000_000);
    expect(runStarts.has("01a2-plain-chat")).toBe(false);
  });

  test("the oldest run is dropped past MAX_RUNS", () => {
    runStarts.clear();
    const root = join(base, "comb-x/p1");
    for (let i = 0; i <= MAX_RUNS; i++) noteReaderRun(readerRequest(root, [], `01a2-evict-${i}`), i);
    expect(runStarts.size).toBe(MAX_RUNS);
    expect(runStarts.has("01a2-evict-0")).toBe(false);
    expect(runStarts.get(`01a2-evict-${MAX_RUNS}`)).toBe(MAX_RUNS);
  });
});

// ---- R1-L3: logViolation against a fake daemon ----

describe("logViolation", () => {
  const violation = { rule: "r", evidence: "e", threadId: "01a2-t", proposedCheck: "p" };
  const fakeDaemon = (reply: string) => {
    const bin = join(work, "fake-today-daemon");
    const seen = join(work, "seen");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > '${seen}.argv'\ncat > '${seen}.stdin'\n${reply}\n`);
    chmodSync(bin, 0o700);
    return { bin, seen };
  };

  test("sends initialize, initialized and one tools/call, and reads the id 2 reply", async () => {
    // id 1 (initialize) answers with an error here, so only reading id 2 can succeed.
    const { bin, seen } = fakeDaemon(`printf '%s\\n' '{"jsonrpc":"2.0","id":1,"error":{"code":0,"message":"not the call"}}' '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}'`);
    expect(await logViolation(violation, { bin, socket: "/run/fake.sock", allowInTest: true })).toBe(true);
    expect(readFileSync(`${seen}.argv`, "utf8").trim()).toBe("mcp --socket /run/fake.sock");
    const lines = readFileSync(`${seen}.stdin`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(lines[2].params).toEqual({ name: "log_rule_violation", arguments: violation });
  });

  test("an error reply, an isError result or no reply is false", async () => {
    for (const reply of [
      `printf '%s\\n' '{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"no"}}'`,
      `printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"isError":true}}'`,
      "exit 0",
    ]) {
      const { bin } = fakeDaemon(reply);
      expect(await logViolation(violation, { bin, socket: "/run/fake.sock", allowInTest: true })).toBe(false);
    }
  });

  test("never runs under test without the explicit opt-in", async () => {
    const { bin, seen } = fakeDaemon("exit 0");
    expect(await logViolation(violation, { bin, socket: "/run/fake.sock" })).toBe(false);
    expect(existsSync(`${seen}.stdin`)).toBe(false);
  });
});
