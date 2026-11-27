import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ScratchViolation,
  declaredScratchRoot,
  sweepReaderTmp,
  tmpWriteTarget,
  wallToolCalls,
} from "../src/scratch-wall";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "../src/types";

// Every path here lives under the preload's private TMPDIR: the real /tmp is only
// ever named in command strings, never touched.
let base: string;
let fakeTmp: string;
const saved = { base: process.env.SCRATCH_WALL_BASE, tmp: process.env.SCRATCH_WALL_TMP };

beforeEach(() => {
  const root = mkdtempSync(join(process.env.TMPDIR!, "scratch-wall-"));
  base = join(root, "agent-tmp");
  fakeTmp = join(root, "fake-tmp");
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
const readerRequest = (root: string, extra: ResponseInputItem[] = [], thread = "01a2-reader-thread"): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: thread,
  tools,
  input: [user(`Your complete task is in ${root}/prompt.md. Read it completely and follow it exactly.\nScratch root: ${root}`), ...extra],
});
const plainRequest = (extra: ResponseInputItem[] = []): ResponsesRequest => ({
  model: "claude-opus-5-5",
  prompt_cache_key: "01a2-plain-chat",
  tools,
  input: [user("Please look at the build."), ...extra],
});
const exec = (cmd: string): ProxyOutput => ({
  text: "",
  toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd, yield_time_ms: 1000 }), callId: "call_1" }],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const cmdOf = (output: ProxyOutput, index = 0) => JSON.parse(output.toolCalls[index].arguments).cmd as string;
const final = (text = "NONCE abc\nSTATUS: COMPLETE"): ProxyOutput => ({ text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });

describe("declared scratch root", () => {
  test("a reader's task message declares it", () => {
    const root = join(base, "comb-x/p1_claude__abcdef012345");
    expect(declaredScratchRoot(readerRequest(root))).toBe(root);
  });

  test("a v2 task-file reader declares it from the task file text", () => {
    const tasks = mkdtempSync(join(process.env.TMPDIR!, "tasks-"));
    const previous = process.env.AGENT_TASKS_DIR;
    process.env.AGENT_TASKS_DIR = tasks;
    try {
      const root = join(base, "comb-y/p2_claude__0123456789ab");
      writeFileSync(join(tasks, "p2_claude__0123456789ab.md"), `Handshake nonce: 1\nScratch root: ${root}\n`, { mode: 0o600 });
      const request: ResponsesRequest = {
        model: "claude-opus-5-5",
        prompt_cache_key: "01a2-v2",
        input: [{
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

  test("no declaration, a placeholder, a path outside the base, or one only in tool output: none", () => {
    expect(declaredScratchRoot(plainRequest())).toBeUndefined();
    expect(declaredScratchRoot({ ...plainRequest(), input: [user("Scratch root: <scratch>/r/<name>")] })).toBeUndefined();
    expect(declaredScratchRoot({ ...plainRequest(), input: [user("Scratch root: /tmp/comb-x")] })).toBeUndefined();
    expect(declaredScratchRoot({ ...plainRequest(), input: [user(`Scratch root: ${base}/../escape`)] })).toBeUndefined();
    expect(declaredScratchRoot({ ...plainRequest(), input: [user(`Scratch root: ${base}`)] })).toBeUndefined();
    // A file the chat merely read (the comb skill, a reply) declares nothing.
    expect(declaredScratchRoot(plainRequest([
      { type: "function_call", name: "exec_command", call_id: "c", arguments: "{\"cmd\":\"cat x\"}" },
      { type: "function_call_output", call_id: "c", output: `Scratch root: ${base}/comb-z/r` },
    ]))).toBeUndefined();
  });
});

describe("tmp write targets", () => {
  for (const cmd of [
    "echo x > /tmp/probe.out",
    "echo x >/tmp/probe.out",
    "echo x >> /tmp/probe.out",
    "bun test 2>/tmp/err.txt",
    "bun test &> /tmp/all.txt",
    "echo x >| /tmp/probe.out",
    "echo x > '/tmp/probe.out'",
    "echo x > \"/tmp/probe.out\"",
    "ls | tee /tmp/list.txt",
    "ls | tee -a /tmp/list.txt",
    "curl -o /tmp/page.html https://example.com",
    "curl -o/tmp/page.html https://example.com",
    "wget --output-document=/tmp/page.html https://example.com",
    "oxlint --output /tmp/lint.txt",
    "oxlint --output=/tmp/lint.txt",
    "mkdir -p /tmp/comb-x",
    "touch /tmp/marker",
    "mktemp -d /tmp/comb.XXXX",
    "mktemp -p /tmp",
    "mktemp --tmpdir=/tmp x.XXXX",
    "cd repo && git diff > /tmp/diff.patch",
  ])
    test(`refuses: ${cmd}`, () => expect(tmpWriteTarget(cmd)).toBeDefined());

  for (const cmd of [
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
  ])
    test(`allows: ${cmd}`, () => expect(tmpWriteTarget(cmd)).toBeUndefined());
});

describe("the wall on a reader's tool calls", () => {
  test("a reader's /tmp write is replaced by a refusal naming the root", async () => {
    const root = join(base, "comb-x/p1");
    const walled = wallToolCalls(readerRequest(root), exec("echo x > /tmp/probe.out"));
    const cmd = cmdOf(walled);
    expect(cmd).not.toContain("echo x >");
    expect(cmd).toContain(root);
    // Run the refusal itself: it prints the message and fails without writing anything.
    const run = Bun.spawnSync(["bash", "-c", cmd]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain(`Scratch root: ${root}`);
    expect(run.stderr.toString()).toContain("/tmp/probe.out");
    // The other arguments survive.
    expect(JSON.parse(walled.toolCalls[0].arguments).yield_time_ms).toBe(1000);
  });

  test("a reader's other commands run with TMPDIR inside the root", () => {
    const root = join(base, "comb-x/p1");
    const walled = wallToolCalls(readerRequest(root), exec("mktemp -d; printf '%s' \"$TMPDIR\""));
    const run = Bun.spawnSync(["bash", "-c", cmdOf(walled)]);
    expect(run.exitCode).toBe(0);
    const [made, tmpdir] = run.stdout.toString().split("\n");
    expect(tmpdir).toBe(join(root, "tmp"));
    expect(made.startsWith(join(root, "tmp") + "/")).toBe(true);
    expect(existsSync(made)).toBe(true);
  });

  test("a write under the scratch root runs unchanged apart from TMPDIR", () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(root, { recursive: true });
    const walled = wallToolCalls(readerRequest(root), exec(`echo x > ${root}/probe.out`));
    expect(Bun.spawnSync(["bash", "-c", cmdOf(walled)]).exitCode).toBe(0);
    expect(readFileSync(join(root, "probe.out"), "utf8")).toBe("x\n");
  });

  test("a chat without a declared root is untouched, byte for byte", () => {
    const output = exec("echo x > /tmp/probe.out");
    expect(wallToolCalls(plainRequest(), output)).toBe(output);
  });

  test("tools other than exec_command pass through", () => {
    const root = join(base, "comb-x/p1");
    const output: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "apply_patch", arguments: "*** Begin Patch\n*** End Patch\n" }] };
    expect(wallToolCalls(readerRequest(root), output).toolCalls).toEqual(output.toolCalls);
  });

  test("unparseable arguments pass through for the normal repair path", () => {
    const root = join(base, "comb-x/p1");
    const output: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "exec_command", arguments: "{not json" }] };
    expect(wallToolCalls(readerRequest(root), output).toolCalls).toEqual(output.toolCalls);
  });
});

describe("the exit sweep", () => {
  const calls = (cmd: string, out = ""): ResponseInputItem[] => [
    { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd }) },
    { type: "function_call_output", call_id: "c1", output: out },
  ];
  const runStart = Date.now() - 60_000;

  test("moves the reader's new /tmp entries into the root and logs one violation", async () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    mkdirSync(join(fakeTmp, "p1-render"));
    writeFileSync(join(fakeTmp, "p1-render", "a.yaml"), "a: 1");
    const logged: ScratchViolation[] = [];
    const request = readerRequest(root, [
      ...calls("echo x > /tmp/probe.out"),
      ...calls("ls", "made /tmp/p1-render/a.yaml"),
    ]);
    const result = await sweepReaderTmp(request, final(), { runStart: () => runStart, log: async (v) => { logged.push(v); return true; } });
    expect(result?.moved.map((m) => m.from).sort()).toEqual([join(fakeTmp, "p1-render"), join(fakeTmp, "probe.out")]);
    expect(existsSync(join(fakeTmp, "probe.out"))).toBe(false);
    expect(readFileSync(join(root, "tmp-swept", "probe.out"), "utf8")).toBe("x");
    expect(readFileSync(join(root, "tmp-swept", "p1-render", "a.yaml"), "utf8")).toBe("a: 1");
    expect(logged).toHaveLength(1);
    expect(logged[0].rule).toBe("Scratch goes under ~/.cache/agent-tmp/<task>; /tmp is RAM tmpfs");
    expect(logged[0].threadId).toBe("01a2-reader-thread");
    expect(logged[0].evidence).toContain(join(root, "tmp-swept"));
    expect(logged[0].evidence).toContain("probe.out");
  });

  test("leaves entries older than the run, ones the reader never named, and runs that are not final", async () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(fakeTmp, "old.txt"), "old");
    const past = new Date(runStart - 3_600_000);
    utimesSync(join(fakeTmp, "old.txt"), past, past);
    writeFileSync(join(fakeTmp, "someone-else.sock"), "");
    const logged: ScratchViolation[] = [];
    const deps = { runStart: () => runStart, log: async (v: ScratchViolation) => { logged.push(v); return true; } };
    const request = readerRequest(root, calls("cat /tmp/old.txt"));
    expect(await sweepReaderTmp(request, final(), deps)).toBeUndefined();
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    expect(await sweepReaderTmp(readerRequest(root, calls("echo > /tmp/probe.out")), exec("ls"), deps)).toBeUndefined();
    expect(existsSync(join(fakeTmp, "old.txt"))).toBe(true);
    expect(existsSync(join(fakeTmp, "someone-else.sock"))).toBe(true);
    expect(existsSync(join(fakeTmp, "probe.out"))).toBe(true);
    expect(logged).toHaveLength(0);
  });

  test("a chat without a declared root sweeps nothing", async () => {
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    const logged: ScratchViolation[] = [];
    const result = await sweepReaderTmp(plainRequest(calls("echo x > /tmp/probe.out")), final(), {
      runStart: () => runStart, log: async (v) => { logged.push(v); return true; },
    });
    expect(result).toBeUndefined();
    expect(existsSync(join(fakeTmp, "probe.out"))).toBe(true);
    expect(logged).toHaveLength(0);
  });

  test("a name already taken in tmp-swept gets a suffix, never overwrites", async () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(join(root, "tmp-swept"), { recursive: true });
    writeFileSync(join(root, "tmp-swept", "probe.out"), "first");
    writeFileSync(join(fakeTmp, "probe.out"), "second");
    const result = await sweepReaderTmp(readerRequest(root, calls("echo > /tmp/probe.out")), final(), {
      runStart: () => runStart, log: async () => true,
    });
    expect(readFileSync(join(root, "tmp-swept", "probe.out"), "utf8")).toBe("first");
    expect(readFileSync(result!.moved[0].to, "utf8")).toBe("second");
  });
});
