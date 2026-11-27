import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repairToolArguments } from "../src/args-json";
import { __test, noteReaderRun, wallToolCalls } from "../src/scratch-wall";
import { responseObject } from "../src/responses";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "../src/types";

const { declaredScratchRoot, tmpWriteTarget, sweepReaderTmp, runs, defaultRunStart, MAX_RUNS, logViolation } = __test;
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

let threadSeq = 0;
const newThread = () => `01a2-thread-${++threadSeq}-${Math.random().toString(16).slice(2, 8)}`;
const tools = [{ type: "function", name: "exec_command", parameters: {} }, { type: "custom", name: "apply_patch" }];
const user = (text: string): ResponseInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const context: ResponseInputItem[] = [
  { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] },
  user("# AGENTS.md instructions for /home/alex\n\nScratch root: /home/alex/.cache/agent-tmp/never-from-context"),
  user("<environment_context>\n  <cwd>/home/alex</cwd>\n</environment_context>"),
];
const spawnMessage = (root: string) =>
  `Your complete task is in ${root}/prompt.md. Read it completely and follow it exactly.\nScratch root: ${root}`;
const request = (thread: string, input: ResponseInputItem[]): ResponsesRequest => ({ model: "claude-opus-5-5", prompt_cache_key: thread, tools, input });
/** A v1 reader: its first request (context, then the spawn message last) is seen first. */
const readerRequest = (root: string, extra: ResponseInputItem[] = [], thread = newThread(), start = Date.now() - 60_000): ResponsesRequest => {
  noteReaderRun(request(thread, [...context, user(spawnMessage(root))]), start);
  return request(thread, [...context, user(spawnMessage(root)), ...extra]);
};
/** Whether this request, seen first on a fresh thread, declares a root. */
const declares = (input: ResponseInputItem[]): string | undefined => {
  const first = request(newThread(), input);
  noteReaderRun(first);
  return declaredScratchRoot(first);
};
const plainRequest = (extra: ResponseInputItem[] = []): ResponsesRequest => {
  const thread = newThread();
  noteReaderRun(request(thread, [...context, user("Please look at the build.")]));
  return request(thread, [...context, user("Please look at the build."), ...extra]);
};
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

// ---- the declaration: the chat's own task, on its first request (R1-H1, R2-M1) ----

describe("declared scratch root", () => {
  test("v1: the spawn message on the thread's first request declares it, and later requests keep it", () => {
    const root = join(base, "comb-x/p1_claude__abcdef012345");
    const later = readerRequest(root, call("ls"));
    expect(declaredScratchRoot(later)).toBe(root);
    expect(declares([user(spawnMessage(root))])).toBe(root);
  });

  test("v2: the NEW_TASK agent message's validated task file declares it", () => {
    const tasks = mkdtempSync(join(process.env.TMPDIR!, "tasks-"));
    const previous = process.env.AGENT_TASKS_DIR;
    process.env.AGENT_TASKS_DIR = tasks;
    try {
      const root = join(base, "comb-y/p2_claude__0123456789ab");
      writeFileSync(join(tasks, "p2_claude__0123456789ab.md"), `Handshake nonce: 1\nScratch root: ${root}\n`, { mode: 0o600 });
      expect(declares([...context, {
        type: "agent_message", author: "/root", recipient: "/root/p2_claude__0123456789ab",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nTask name: p2_claude__0123456789ab\nPayload:" },
          { type: "encrypted_content", encrypted_content: "gAAAA" },
        ],
      }])).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.AGENT_TASKS_DIR;
      else process.env.AGENT_TASKS_DIR = previous;
    }
  });

  const line = () => `Scratch root: ${base}/comb-q/p1_claude__aaaaaaaaaaaa`;
  test("a later user message declares nothing", () => {
    expect(declaredScratchRoot(plainRequest([user(line())]))).toBeUndefined();
  });
  test("a <codex_delegation> relay declares nothing, later or first, with or without attributes", () => {
    const relay = `<codex_delegation>\n  <input>Brief for the reader:\n${line()}\n</input>\n</codex_delegation>`;
    expect(declaredScratchRoot(plainRequest([user(relay)]))).toBeUndefined();
    expect(declares([...context, user(relay)])).toBeUndefined();
    expect(declares([...context, user(`<codex_delegation source_thread_id="01a2-other">\n${line()}\n</codex_delegation>`)])).toBeUndefined();
    expect(declares([...context, user(`<codex_delegation\nsource_thread_id="x">\n${line()}`)])).toBeUndefined();
  });
  test("a <subagent_notification> declares nothing, later or first", () => {
    const note = `<subagent_notification>\n{"agent":"p1"}\n${line()}\n</subagent_notification>`;
    expect(declaredScratchRoot(plainRequest([user(note)]))).toBeUndefined();
    expect(declares([...context, user(note)])).toBeUndefined();
  });
  test("fences of three or more backticks or tildes declare nothing", () => {
    for (const fence of ["```", "````", "~~~", "~~~~~"])
      expect(declares([...context, user(`Template:\n${fence}text\n${line()}\n${fence}`)])).toBeUndefined();
    // A shorter fence inside a longer one does not close it.
    expect(declares([...context, user(`Template:\n\`\`\`\`md\n\`\`\`\n\`\`\`\n${line()}\n\`\`\`\``)])).toBeUndefined();
    expect(declares([...context, user(`Template:\n\`\`\`\`md\n\`\`\`\n${line()}\n\`\`\`\``)])).toBeUndefined();
    expect(declares([...context, user(`Template:\n~~~~\n~~~\n${line()}\n~~~~`)])).toBeUndefined();
    expect(declaredScratchRoot(plainRequest([user("```text\n" + line() + "\n```")]))).toBeUndefined();
  });
  test("a child's agent_message to its parent declares nothing", () => {
    const child: ResponseInputItem = {
      type: "agent_message", author: "/root/p1_claude__aaaaaaaaaaaa", recipient: "/root",
      content: [{ type: "input_text", text: `Message Type: FINAL\nPayload:\n${line()}` }],
    };
    expect(declaredScratchRoot(plainRequest([child]))).toBeUndefined();
    expect(declares([...context, child])).toBeUndefined();
  });
  test("a brief first seen mid-history declares nothing (a Today-created worker, a proxy restart)", () => {
    expect(declares([...context, user(`Worker brief.\n${line()}`), ...call("ls")])).toBeUndefined();
    // The same chat's next request does not turn it on either.
    const thread = newThread();
    noteReaderRun(request(thread, [...context, user(line()), ...call("ls")]));
    const next = request(thread, [...context, user(line()), ...call("ls"), ...call("pwd", "", "c2")]);
    noteReaderRun(next);
    expect(declaredScratchRoot(next)).toBeUndefined();
    expect(wallToolCalls(next, exec("echo x > /tmp/probe.out")).toolCalls[0].arguments).toBe(exec("echo x > /tmp/probe.out").toolCalls[0].arguments);
  });
  test("an old message that survives a compaction declares nothing", () => {
    expect(declares([...context, user(`Old message.\n${line()}`), user("Another language model started to solve this problem and produced a summary...")])).toBeUndefined();
  });
  test("Codex's own context declares nothing", () => {
    expect(declares([...context])).toBeUndefined();
    expect(declaredScratchRoot(plainRequest())).toBeUndefined();
  });
  test("a placeholder, a path outside the base, the base itself, other characters, or tool output: none", () => {
    const first = (text: string) => declares([...context, user(text)]);
    expect(first("Scratch root: <scratch>/r/<name>")).toBeUndefined();
    expect(first("Scratch root: /tmp/comb-x")).toBeUndefined();
    expect(first(`Scratch root: ${base}/../escape`)).toBeUndefined();
    expect(first(`Scratch root: ${base}`)).toBeUndefined();
    // R2-L5: absolute and inside the base, but with characters outside ROOT_CHARS.
    expect(first(`Scratch root: ${base}/it's`)).toBeUndefined();
    expect(first(`Scratch root: ${base}/café`)).toBeUndefined();
    expect(first(`Scratch root: ${base}/a$b`)).toBeUndefined();
    expect(declaredScratchRoot(plainRequest(call("cat x", `Scratch root: ${base}/comb-z/r`)))).toBeUndefined();
  });
  test("a request without a thread id declares nothing", () => {
    const root = join(base, "comb-x/p1");
    const anonymous: ResponsesRequest = { model: "m", input: [...context, user(spawnMessage(root))] };
    noteReaderRun(anonymous);
    expect(declaredScratchRoot(anonymous)).toBeUndefined();
  });
});

// ---- write targets, exact (R1-M3, R2-M2, R2-M3) ----

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
    // R2-M2: a heredoc operator inside quotes or a comment opens no heredoc.
    ["printf '%s\\n' '<<EOF'\necho x > /tmp/plain-after-quote", "/tmp/plain-after-quote"],
    ["printf \"%s\\n\" \"<<EOF\"\necho x > /tmp/after-double", "/tmp/after-double"],
    ["echo 'say <<EOF now'\necho x > /tmp/after-spaced", "/tmp/after-spaced"],
    ["echo \"say <<EOF now\"\necho x > /tmp/after-spaced-double", "/tmp/after-spaced-double"],
    ["# not a heredoc: <<EOF\necho x > /tmp/after-comment", "/tmp/after-comment"],
    ["cat <<\\EOF\nbody > /tmp/in-body\nEOF\necho x > /tmp/after-body", "/tmp/after-body"],
    // R2-M3: clustered short flags, wrappers with option values, long output flags, *_DIR=.
    ["curl -sSo /tmp/x https://example.com", "/tmp/x"],
    ["curl -sSo/tmp/x https://example.com", "/tmp/x"],
    ["curl -fsSL -o /tmp/x https://example.com", "/tmp/x"],
    ["sudo -u alex touch /tmp/x", "/tmp/x"],
    ["env -u FOO touch /tmp/x", "/tmp/x"],
    ["timeout 10 tee /tmp/x", "/tmp/x"],
    ["timeout -s KILL 10 tee /tmp/x", "/tmp/x"],
    ["timeout --signal=KILL 5m mkdir /tmp/x", "/tmp/x"],
    ["cargo test --target-dir /tmp/t", "/tmp/t"],
    ["cargo test --target-dir=/tmp/t", "/tmp/t"],
    ["bun build src/a.ts --outdir /tmp/o", "/tmp/o"],
    ["bun build src/a.ts --outfile=/tmp/o.js", "/tmp/o.js"],
    ["CARGO_TARGET_DIR=/tmp/t cargo build", "/tmp/t"],
    ["env CARGO_TARGET_DIR=/tmp/t cargo build", "/tmp/t"],
    ["touch -r /tmp/ref /tmp/new", "/tmp/new"],
    ["mkdir -m 700 /tmp/x", "/tmp/x"],
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
    "cat <<\\EOF\necho x > /tmp/example\nEOF",
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
    // R2-M3: touch -r reads its reference; a wrapper's option value is not a command.
    "touch -r /tmp/ref existing",
    "touch --reference=/tmp/ref existing",
    "sudo -u alex ls /tmp/x",
    "timeout 10 cat /tmp/x",
    "FOO_DIR=/home/alex/.cache/agent-tmp/t cargo build",
    "curl -sS https://example.com/tmp/x",
  ];
  for (const cmd of allowed) test(`allows ${JSON.stringify(cmd)}`, () => expect(tmpWriteTarget(cmd)).toBeUndefined());
});

// ---- the wall on tool calls: R1-M4 (no rewrite), R1-M2 (repaired arguments), R2-L4 ----

describe("the wall on a reader's tool calls", () => {
  test("a reader's /tmp write is replaced by a refusal naming the root, in plain words", () => {
    const root = join(base, "comb-x/p1");
    const walled = wallToolCalls(readerRequest(root), exec("echo x > /tmp/probe.out"));
    const cmd = cmdOf(walled);
    expect(cmd).not.toContain("echo x >");
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
    const reader = readerRequest(root);
    const raw: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "exec_command", arguments: '{"cmd":"echo first\necho x > /tmp/bypass.out"}', callId: "call_raw" }] };
    expect(() => JSON.parse(raw.toolCalls[0].arguments)).toThrow();
    const response = responseObject(reader, wallToolCalls(reader, raw));
    const item = response.output.find((entry) => entry.type === "function_call") as { arguments: string };
    const cmd = JSON.parse(item.arguments).cmd as string;
    expect(cmd).toContain("scratch-tmp-wall: refused");
    expect(cmd).toContain("/tmp/bypass.out");
    expect(cmd).not.toContain("echo first");
  });

  test("the wall's repair logs nothing; responses.ts still logs its own once (R2-L4)", () => {
    const root = join(base, "comb-x/p1");
    const reader = readerRequest(root);
    const raw: ProxyOutput = { ...exec("x"), toolCalls: [{ name: "exec_command", arguments: '{"cmd":"echo first\necho second"}', callId: "call_raw" }] };
    const log = spyOn(console, "log");
    try {
      const walled = wallToolCalls(reader, raw);
      expect(log.mock.calls.filter((args) => String(args[0]).includes("argsRepaired"))).toHaveLength(0);
      responseObject(reader, walled);
      expect(log.mock.calls.filter((args) => String(args[0]).includes("argsRepaired"))).toHaveLength(1);
      log.mockClear();
      expect(repairToolArguments('{"cmd":"a\nb"}', { tool: "exec_command", silent: true })).toBe('{"cmd":"a\\nb"}');
      expect(log.mock.calls).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
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

// ---- the exit report: reports, never moves (R1-H2, R1-L1, R2-L1, R2-L2, R2-L5) ----

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
    const thread = newThread();
    const reader = readerRequest(root, [...call("echo x > /tmp/probe.out"), ...call("helm template . --output-dir /tmp/p1-render/sub", "", "c2")], thread);
    const result = await sweepReaderTmp(reader, final(), { runStart: past, log });
    expect(result?.left.sort()).toEqual([join(fakeTmp, "p1-render"), join(fakeTmp, "probe.out")]);
    expect(readFileSync(join(fakeTmp, "probe.out"), "utf8")).toBe("x");
    expect(readFileSync(join(fakeTmp, "p1-render", "a.yaml"), "utf8")).toBe("a: 1");
    expect(existsSync(join(root, "tmp-swept"))).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0].rule).toBe("Scratch goes under ~/.cache/agent-tmp/<task>; /tmp is RAM tmpfs");
    expect(logged[0].threadId).toBe(thread);
    expect(logged[0].evidence).toContain("left in place");
    expect(logged[0].evidence).toContain("probe.out");
    expect(logged[0].evidence).toContain("p1-render");
  });

  test("names only in tool output or the answer are not candidates", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "seen-in-output"), "x");
    writeFileSync(join(fakeTmp, "seen-in-answer"), "x");
    const { logged, log } = collect();
    const reader = readerRequest(root, call("ps -eo args", "bun /tmp/seen-in-output/x"));
    expect(await sweepReaderTmp(reader, final("I saw /tmp/seen-in-answer"), { runStart: past, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
  });

  test("only exec_command cmd strings without heredoc bodies, and apply_patch file headers, are the reader's (R2-L1)", async () => {
    const root = join(base, "comb-x/p1");
    for (const name of ["x", "other-cmd", "in-body", "patch-body", "added", "updated", "moved"]) writeFileSync(join(fakeTmp, name), "x");
    const { logged, log } = collect();
    const reader = readerRequest(root, [
      { type: "function_call", name: "send_message_to_thread", namespace: "today", call_id: "m1", arguments: JSON.stringify({ threadId: "t", prompt: "Please inspect /tmp/x" }) },
      { type: "function_call_output", call_id: "m1", output: "{}" },
      // Another tool whose arguments happen to carry a cmd is not a shell command either.
      { type: "function_call", name: "preview_command", call_id: "m2", arguments: JSON.stringify({ cmd: "touch /tmp/other-cmd" }) },
      { type: "function_call_output", call_id: "m2", output: "{}" },
      ...call("cat > notes.md <<'EOF'\nsee /tmp/in-body\nEOF", "", "c2"),
      { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: "*** Begin Patch\n*** Add File: /tmp/added\n+mentions /tmp/patch-body\n*** Update File: /tmp/updated\n*** Move to: /tmp/moved\n@@\n-a\n+b\n*** End Patch\n" },
    ]);
    const result = await sweepReaderTmp(reader, final(), { runStart: past, log });
    expect(result?.left.sort()).toEqual(["added", "moved", "updated"].map((name) => join(fakeTmp, name)));
    expect(logged).toHaveLength(1);
  });

  test("each leftover is reported once per thread (R2-L2)", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    const { logged, log } = collect();
    const thread = newThread();
    const reader = readerRequest(root, call("echo > /tmp/probe.out"), thread);
    expect((await sweepReaderTmp(reader, final(), { runStart: past, log }))?.left).toEqual([join(fakeTmp, "probe.out")]);
    expect(await sweepReaderTmp(reader, final("again"), { runStart: past, log })).toBeUndefined();
    // A new leftover on the same thread is still reported, alone.
    writeFileSync(join(fakeTmp, "second.out"), "x");
    const later = request(thread, [...reader.input as ResponseInputItem[], ...call("echo > /tmp/second.out", "", "c9")]);
    expect((await sweepReaderTmp(later, final(), { runStart: past, log }))?.left).toEqual([join(fakeTmp, "second.out")]);
    expect(logged).toHaveLength(2);
  });

  test("entries another process holds open or uses as cwd, at or inside them, are skipped (R2-L5)", async () => {
    const root = join(base, "comb-x/p1");
    mkdirSync(join(fakeTmp, "live-build"));
    writeFileSync(join(fakeTmp, "live-log"), "");
    mkdirSync(join(fakeTmp, "outer-cwd", "inner"), { recursive: true });
    mkdirSync(join(fakeTmp, "outer-fd"));
    writeFileSync(join(fakeTmp, "outer-fd", "held.log"), "");
    const holders = [
      Bun.spawn(["sleep", "30"], { cwd: join(fakeTmp, "live-build") }),
      Bun.spawn(["bash", "-c", `exec 3>>'${join(fakeTmp, "live-log")}'; sleep 30`]),
      Bun.spawn(["sleep", "30"], { cwd: join(fakeTmp, "outer-cwd", "inner") }),
      Bun.spawn(["bash", "-c", `exec 3>>'${join(fakeTmp, "outer-fd", "held.log")}'; sleep 30`]),
    ];
    try {
      await Bun.sleep(150);
      const { logged, log } = collect();
      const reader = readerRequest(root, call("cat /tmp/live-build/status > /tmp/live-log; mkdir -p /tmp/outer-cwd/inner /tmp/outer-fd"));
      expect(await sweepReaderTmp(reader, final(), { runStart: past, log })).toBeUndefined();
      expect(logged).toHaveLength(0);
    } finally {
      for (const holder of holders) holder.kill();
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
    const reader = readerRequest(root, call("echo >> /tmp/old.txt"));
    expect(await sweepReaderTmp(reader, final(), { runStart: () => start, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
  });

  test("no birth time, another owner, or not a file, directory or link: skipped (R1-L1)", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    Bun.spawnSync(["mkfifo", join(fakeTmp, "pipe")]);
    const { logged, log } = collect();
    const thread = newThread();
    const reader = readerRequest(root, call("echo > /tmp/probe.out"), thread);
    for (const birth of [0, Number.NaN]) {
      const noBirth = (path: string) => {
        const stat = statSync(path);
        Object.defineProperty(stat, "birthtimeMs", { value: birth });
        return stat;
      };
      expect(await sweepReaderTmp(reader, final(), { runStart: past, log, lstat: noBirth })).toBeUndefined();
    }
    expect(await sweepReaderTmp(reader, final(), { runStart: past, log, uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
    expect(await sweepReaderTmp(readerRequest(root, call("echo > /tmp/pipe")), final(), { runStart: past, log })).toBeUndefined();
    expect(logged).toHaveLength(0);
    expect((await sweepReaderTmp(reader, final(), { runStart: past, log }))?.left).toEqual([join(fakeTmp, "probe.out")]);
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

  test("the sweep's own repair of history logs nothing (R2-L4)", async () => {
    const root = join(base, "comb-x/p1");
    writeFileSync(join(fakeTmp, "probe.out"), "x");
    const reader = readerRequest(root, [
      { type: "function_call", name: "exec_command", call_id: "r1", arguments: '{"cmd":"echo a\necho > /tmp/probe.out"}' },
      { type: "function_call_output", call_id: "r1", output: "" },
    ]);
    const log = spyOn(console, "log");
    try {
      const result = await sweepReaderTmp(reader, final(), { runStart: past, log: async () => true });
      expect(result?.left).toEqual([join(fakeTmp, "probe.out")]);
      expect(log.mock.calls.filter((args) => String(args[0]).includes("argsRepaired"))).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
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

// ---- run records (R1-L1, R2-M1) ----

describe("run records", () => {
  test("a declared reader's first sight is its run start, and later sights keep it", () => {
    const root = join(base, "comb-x/p1");
    const thread = newThread();
    noteReaderRun(request(thread, [...context, user(spawnMessage(root))]), 1_000_000);
    noteReaderRun(request(thread, [...context, user(spawnMessage(root)), ...call("ls")]), 2_000_000);
    expect(runs.get(thread)?.start).toBe(1_000_000);
    expect(runs.get(thread)?.root).toBe(root);
    expect(defaultRunStart(thread, request(thread, []))).toBe(1_000_000);
  });

  test("a thread first seen undeclared stays undeclared, even if a later request looks like a first one", () => {
    const root = join(base, "comb-x/p1");
    const thread = newThread();
    noteReaderRun(request(thread, [...context, user("Please look at the build.")]));
    // e.g. a history replaced by a view whose only item is a declaring message
    const replaced = request(thread, [...context, user(spawnMessage(root))]);
    noteReaderRun(replaced);
    expect(declaredScratchRoot(replaced)).toBeUndefined();
  });

  test("the oldest run is dropped past MAX_RUNS", () => {
    runs.clear();
    const root = join(base, "comb-x/p1");
    for (let i = 0; i <= MAX_RUNS; i++) noteReaderRun(request(`01a2-evict-${i}`, [...context, user(spawnMessage(root))]), i);
    expect(runs.size).toBe(MAX_RUNS);
    expect(runs.has("01a2-evict-0")).toBe(false);
    expect(runs.get(`01a2-evict-${MAX_RUNS}`)?.start).toBe(MAX_RUNS);
  });
});

// ---- logViolation against a fake daemon (R1-L3, R2-L3) ----

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

  test("one deadline bounds it, even when a descendant keeps stdout open (R2-L3)", async () => {
    const { bin } = fakeDaemon("sleep 4 &\nexit 0");
    const started = Date.now();
    expect(await logViolation(violation, { bin, socket: "/run/fake.sock", allowInTest: true, deadlineMs: 400 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 8_000);

  test("never runs under test without the explicit opt-in", async () => {
    const { bin, seen } = fakeDaemon("exit 0");
    expect(await logViolation(violation, { bin, socket: "/run/fake.sock" })).toBe(false);
    expect(existsSync(`${seen}.stdin`)).toBe(false);
  });
});
