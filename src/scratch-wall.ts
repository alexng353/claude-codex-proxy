/**
 * The scratch wall (q scratch-tmp-wall, Nov 27): a reader that declares a scratch
 * root is refused its writes under /tmp, which is RAM tmpfs on Forge and Arch, and
 * whatever it still leaves there is counted.
 *
 * Nov 23-24 nine comb and bench readers (violations #83-#94, all Claude readers,
 * p1-p4_claude__<key>) wrote probes, renders and lint output to /tmp. Their shell
 * commands are Codex exec_command calls that this proxy writes (responses.ts), so
 * the wall lives here:
 *
 * (b) a command whose write target is under /tmp (a redirection, tee, mkdir,
 *     touch, mktemp, dd of=, -o/-O after curl/wget/cc, --output*, --log-file) is
 *     replaced by a refusal that names the root, so nothing of it runs;
 * (c) after the reader's final answer, /tmp entries named in its own commands that
 *     are this user's, born after its run started and not held open or used as a
 *     cwd by any process are reported in one log_rule_violation, and LEFT IN PLACE.
 *     Nothing is moved: owner and times cannot tell one of Alex's jobs from another,
 *     and mv from tmpfs to disk copies and unlinks under a live writer (round 1).
 *
 * (a) TMPDIR is not set here. Codex 0.171 has no env field on exec_command
 * (codex-rs core/src/tools/handlers/unified_exec.rs:67-90), and any prefix on cmd
 * changes how Codex sees the command: exec policy splits a `zsh -lc` script only
 * when it is plain words (shell-command/src/bash.rs:29-94, used by
 * core/src/exec_policy.rs:974-1003), so a redirect or `export` hides the command
 * from today-hard-block.rules; and shell-form apply_patch is intercepted only as
 * the script's single statement (apply-patch/src/invocation.rs:262,285-336). The
 * reader prompt (comb skill) names the root and its tmp folder instead. Commands
 * that pass the wall go out byte for byte; the refusal itself is plain words.
 *
 * The switch is a line `Scratch root: /abs/path` in the chat's own task only: the
 * first item after Codex's injected context, which is the v1 spawn message (not a
 * relayed <codex_delegation> or a <subagent_notification>, and not inside a fenced
 * block), or a v2 NEW_TASK served from its validated task file. Later messages,
 * child replies and tool output declare nothing, and the path must lie strictly
 * inside ~/.cache/agent-tmp. A chat without a declaration is untouched, byte for
 * byte.
 *
 * The text match is a tripwire, not a sandbox: cp, mv, tar, language-level writes,
 * `cd /tmp` then a relative path, variables, write_stdin and apply_patch get
 * through (b); (c) still counts them when the command named the /tmp path.
 */
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { repairToolArguments } from "./args-json";
import { STRIPPED_ENV } from "./claude-env";
import { agentMessagePayload, leadingContextCount, requestTools, toolDescriptors } from "./request";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "./types";

const SCRATCH_RULE = "Scratch goes under ~/.cache/agent-tmp/<task>; /tmp is RAM tmpfs";

type ScratchViolation = { rule: string; evidence: string; threadId: string; proposedCheck: string };
type SweepDeps = {
  /** When this reader's run started (ms), or undefined when unknown. */
  runStart?: (threadId: string, request: ResponsesRequest) => number | undefined;
  log?: (violation: ScratchViolation) => Promise<boolean>;
  lstat?: (path: string) => Stats;
  uid?: number;
};
type SweepResult = { root: string; left: string[]; logged: boolean };

const scratchBase = () => normalize(process.env.SCRATCH_WALL_BASE || join(homedir(), ".cache", "agent-tmp"));
const tmpDir = () => normalize(process.env.SCRATCH_WALL_TMP || "/tmp");

// ---- the declaration ----

// Only plain path characters: the root is pasted into a refusal and a violation,
// and a placeholder like `<scratch>/r/<name>` must not count.
const ROOT_CHARS = /^[A-Za-z0-9._/@+-]+$/;
const DECLARATION = /^Scratch root: (\S+)[ \t]*$/gm;
const RELAY = /<codex_delegation>|<subagent_notification>/;
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;

function validRoot(path: string): boolean {
  if (!isAbsolute(path) || !ROOT_CHARS.test(path)) return false;
  if (normalize(path) !== path || path.endsWith("/")) return false;
  return path.startsWith(`${scratchBase()}/`);
}

const partsText = (content: ResponseInputItem["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => ["input_text", "output_text", "text"].includes(part.type ?? ""))
        .map((part) => part.text ?? "")
        .join("\n");

/** The text of the chat's own task, or undefined when its first item is not one. */
function taskText(request: ResponsesRequest): string | undefined {
  const input: ResponseInputItem[] =
    typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input;
  let index = leadingContextCount(input);
  while (index < input.length && (input[index].role === "developer" || input[index].role === "system")) index++;
  const item = input[index];
  if (!item) return undefined;
  if (item.type === "agent_message") {
    const payload = agentMessagePayload(item);
    return payload.kind === "task-file" ? payload.file.text : undefined;
  }
  if ((item.type === undefined || item.type === "message") && item.role === "user") {
    const text = partsText(item.content);
    return RELAY.test(text) ? undefined : text;
  }
  return undefined;
}

function declaredScratchRoot(request: ResponsesRequest): string | undefined {
  const text = taskText(request);
  if (text === undefined) return undefined;
  for (const match of text.replace(FENCED, "").matchAll(DECLARATION)) if (validRoot(match[1])) return match[1];
  return undefined;
}

// ---- (b) write targets under /tmp ----

/** Drop heredoc bodies and their delimiter lines; the operator line stays. */
function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  const pending: Array<{ delimiter: string; dash: boolean }> = [];
  for (const line of cmd.split("\n")) {
    const open = pending[0];
    if (open) {
      if ((open.dash ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
      continue;
    }
    out.push(line);
    for (const match of line.matchAll(/(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/g))
      pending.push({ delimiter: match[3], dash: match[1] === "-" });
  }
  return out.join("\n");
}

const BARE_TMP = /^\/tmp(?:\/[^\s'"]*)?$/;
/** Quoted text is data, except a quoted /tmp path on its own, which is a path. */
const stripQuotes = (cmd: string) =>
  cmd
    .replace(/'([^']*)'/g, (_, body: string) => (BARE_TMP.test(body) ? body : "''"))
    .replace(/"([^"\\$`]*)"/g, (whole, body: string) => (BARE_TMP.test(body) ? body : whole));

const TMP_WORD = /^\/tmp(?:\/|$)/;
const REDIRECT = /(?:^|[^<>&0-9])(?:[0-9]+|&)?>{1,2}\|?[ \t]*(\/tmp(?:\/[^\s'"`;|&<>()]*)?)(?=[\s'"`;|&<>()]|$)/;
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nice", "nohup", "builtin"]);
const SHORT_O: Record<string, string[]> = {
  curl: ["-o", "-O"], wget: ["-o", "-O"],
  cc: ["-o"], gcc: ["-o"], clang: ["-o"], "g++": ["-o"], "c++": ["-o"], "clang++": ["-o"],
};
const LONG_OUTPUT = /^--(?:output(?:-[a-z]+)?|log-file)(?:=(.*))?$/;

function commandTarget(words: string[]): string | undefined {
  let i = 0;
  let wrapped = false;
  while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]) || (wrapped && words[i].startsWith("-")))) {
    wrapped ||= WRAPPERS.has(words[i]);
    i++;
  }
  if (i >= words.length) return undefined;
  const name = basename(words[i]);
  const args = words.slice(i + 1);
  for (const [index, arg] of args.entries()) {
    const long = LONG_OUTPUT.exec(arg);
    if (long) {
      const value = long[1] ?? args[index + 1];
      if (value !== undefined && TMP_WORD.test(value)) return value;
    }
  }
  const operands = args.filter((arg) => !arg.startsWith("-"));
  switch (name) {
    case "mkdir":
    case "touch":
    case "tee":
      return operands.find((arg) => TMP_WORD.test(arg));
    case "mktemp":
      for (const [index, arg] of args.entries()) {
        if ((arg === "-p" || arg === "--tmpdir") && TMP_WORD.test(args[index + 1] ?? "")) return args[index + 1];
        const attached = /^(?:-p|--tmpdir=)(\/tmp(?:\/.*)?)$/.exec(arg);
        if (attached) return attached[1];
      }
      return operands.find((arg) => TMP_WORD.test(arg));
    case "dd":
      for (const arg of args) if (arg.startsWith("of=") && TMP_WORD.test(arg.slice(3))) return arg.slice(3);
      return undefined;
  }
  const flags = SHORT_O[name];
  if (flags)
    for (const [index, arg] of args.entries())
      for (const flag of flags) {
        if (arg === flag && TMP_WORD.test(args[index + 1] ?? "")) return args[index + 1];
        if (arg.startsWith(flag) && TMP_WORD.test(arg.slice(flag.length))) return arg.slice(flag.length);
      }
  return undefined;
}

/** The first write target under /tmp in a shell command, or undefined. */
function tmpWriteTarget(cmd: string): string | undefined {
  const text = stripQuotes(stripHeredocs(cmd));
  const redirect = REDIRECT.exec(text);
  if (redirect) return redirect[1];
  for (const segment of text.split(/\|\||&&|[;|&\n(){}]/)) {
    const target = commandTarget(segment.trim().split(/\s+/).filter(Boolean));
    if (target) return target;
  }
  return undefined;
}

/** Plain words, quotes and && only, so Codex's exec policy parses it like any command. */
function refusalCommand(target: string, root: string): string {
  const message = (
    `scratch-tmp-wall: refused a write under /tmp (${target}); nothing of this command ran. ` +
    `/tmp is RAM tmpfs. Scratch root: ${root}. Write there instead, temporary files under ${root}/tmp.`
  ).replace(/['\n\r]/g, "");
  return `printf '%s\\n' '${message}' && false`;
}

const isExecCommand = (request: ResponsesRequest, name: string): boolean => {
  if (name === "exec_command") return true;
  const descriptor = toolDescriptors(requestTools(request)).find((tool) => tool.proxyName === name);
  return descriptor?.name === "exec_command" && descriptor.type !== "custom";
};

/** (b) on one response's tool calls. Returns `output` itself when nothing applies. */
export function wallToolCalls(request: ResponsesRequest, output: ProxyOutput): ProxyOutput {
  if (output.toolCalls.length === 0) return output;
  const root = declaredScratchRoot(request);
  if (!root) return output;
  const threadId = typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined;
  let changed = false;
  const toolCalls = output.toolCalls.map((call) => {
    if (!isExecCommand(request, call.name)) return call;
    // The same repair responses.ts applies, so the wall sees what Codex will run.
    const repaired = repairToolArguments(call.arguments, { tool: call.name, threadId });
    let args: unknown;
    try {
      args = JSON.parse(repaired);
    } catch {
      return call;
    }
    if (!args || typeof args !== "object" || typeof (args as { cmd?: unknown }).cmd !== "string") return call;
    const target = tmpWriteTarget((args as { cmd: string }).cmd);
    if (!target) return call;
    changed = true;
    return { ...call, arguments: JSON.stringify({ ...(args as object), cmd: refusalCommand(target, root) }) };
  });
  return changed ? { ...output, toolCalls } : output;
}

// ---- (c) the exit report ----

const runStarts = new Map<string, number>();
const MAX_RUNS = 2000;

/** Remember when a declared reader was first seen; call on every request. */
export function noteReaderRun(request: ResponsesRequest, now = Date.now()): void {
  const thread = request.prompt_cache_key;
  if (typeof thread !== "string" || !thread || runStarts.has(thread)) return;
  if (!declaredScratchRoot(request)) return;
  if (runStarts.size >= MAX_RUNS) runStarts.delete(runStarts.keys().next().value!);
  runStarts.set(thread, now);
}

function defaultRunStart(thread: string, _request: ResponsesRequest): number | undefined {
  return runStarts.get(thread);
}

// Entries that belong to the session or other daemons, never to a reader.
const NEVER_REPORTED = /^(?:\.|systemd-private-|tmux-|ssh-|claude-|bun-|today-|snap-private|pulse-)/;
const NAME = "[A-Za-z0-9._@+-]+";
const MAX_LOOKS = 50;
const MAX_NAMED = 12;
// A small margin for clock granularity between first sight and the first write.
const START_SLACK_MS = 1000;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reader's own commands: exec_command cmd strings, decoded, and apply_patch input. */
function ownCommands(request: ResponsesRequest): string[] {
  if (!Array.isArray(request.input)) return [];
  const texts: string[] = [];
  for (const item of request.input) {
    if (item.type === "function_call" && typeof item.arguments === "string") {
      try {
        const args = JSON.parse(repairToolArguments(item.arguments, { tool: item.name ?? "" }));
        texts.push(typeof args?.cmd === "string" ? args.cmd : JSON.stringify(args));
      } catch {
        texts.push(item.arguments);
      }
    } else if (item.type === "custom_tool_call" && typeof item.input === "string") {
      texts.push(item.input);
    }
  }
  return texts;
}

/** Top-level /tmp names in the reader's own commands, at most MAX_LOOKS of them. */
function namedTmpEntries(request: ResponsesRequest): string[] {
  const prefixes = [...new Set(["/tmp", tmpDir()])].map(escapeRegExp).join("|");
  const pattern = new RegExp(String.raw`(?:^|[^\w.~/-])(?:${prefixes})\/(${NAME})`, "g");
  const names = new Set<string>();
  for (const text of ownCommands(request))
    for (const match of text.matchAll(pattern)) {
      if (match[1] === ".." || NEVER_REPORTED.test(match[1])) continue;
      names.add(match[1]);
      if (names.size >= MAX_LOOKS) return [...names];
    }
  return [...names];
}

/** Every path some process holds open or uses as its cwd (Linux /proc). */
async function busyPaths(): Promise<string[]> {
  const paths: string[] = [];
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return paths;
  }
  for (const pid of pids) {
    try {
      paths.push(await readlink(`/proc/${pid}/cwd`));
    } catch {}
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds)
      try {
        paths.push(await readlink(`/proc/${pid}/fd/${fd}`));
      } catch {}
  }
  return paths;
}

/**
 * (c) After a declared reader's final answer, report (never move) its own new /tmp
 * entries in one violation. Undefined when nothing applies.
 */
async function sweepReaderTmp(
  request: ResponsesRequest,
  output: ProxyOutput,
  deps: SweepDeps = {},
): Promise<SweepResult | undefined> {
  if (output.compaction !== undefined || output.toolCalls.length > 0) return undefined;
  const thread = request.prompt_cache_key;
  if (typeof thread !== "string" || !thread) return undefined;
  const root = declaredScratchRoot(request);
  if (!root) return undefined;
  const start = (deps.runStart ?? defaultRunStart)(thread, request);
  if (start === undefined) return undefined;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const lstat = deps.lstat ?? lstatSync;
  const tmp = tmpDir();
  const fresh: string[] = [];
  for (const name of namedTmpEntries(request)) {
    const path = join(tmp, name);
    let stat: Stats;
    try {
      stat = lstat(path);
    } catch {
      continue;
    }
    if (uid !== undefined && stat.uid !== uid) continue;
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue;
    // Born after the run started; no birth time, no claim.
    if (!(stat.birthtimeMs > 0) || stat.birthtimeMs < start - START_SLACK_MS) continue;
    fresh.push(path);
  }
  if (fresh.length === 0) return undefined;
  const busy = await busyPaths();
  const left = fresh.filter((path) => {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {}
    return !busy.some((open) => open === real || open.startsWith(`${real}/`));
  });
  if (left.length === 0) return undefined;
  const names = left.map((path) => path.slice(tmp.length + 1));
  const listed = names.slice(0, MAX_NAMED).join(", ");
  const more = names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : "";
  const violation: ScratchViolation = {
    rule: SCRATCH_RULE,
    threadId: thread,
    evidence:
      `scratch-tmp-wall exit report (claude-codex-proxy): reader thread ${thread} with scratch root ${root} ` +
      `named ${names.length} /tmp entr${names.length === 1 ? "y" : "ies"} in its own commands that it owns, ` +
      `born after its run started ${new Date(start).toISOString()} and held by no process, left in place (nothing was moved): ${listed}${more}.`,
    proposedCheck:
      "scratch-tmp-wall refuses redirection/tee/mkdir/touch/mktemp/dd/-o/--output writes under /tmp for declared " +
      "readers; extend tmpWriteTarget for the command shape that got through.",
  };
  const logged = await (deps.log ?? ((v: ScratchViolation) => logViolation(v)))(violation).catch((cause) => {
    console.error("scratch-wall: logging the violation failed:", (cause as Error).message);
    return false;
  });
  return { root, left, logged };
}

const sweeps: Array<Promise<SweepResult | undefined>> = [];

/**
 * Run the exit report after the response is built, off the request path: only a
 * declared reader's final answer schedules one.
 */
export function scheduleSweep(request: ResponsesRequest, output: ProxyOutput): void {
  if (output.compaction !== undefined || output.toolCalls.length > 0) return;
  if (!declaredScratchRoot(request)) return;
  setTimeout(() => {
    const run = sweepReaderTmp(request, output).catch((cause) => {
      console.error("scratch-wall: sweep failed:", (cause as Error).message);
      return undefined;
    });
    sweeps.push(run);
    if (sweeps.length > 20) sweeps.shift();
  }, 0);
}

type LogOptions = { bin?: string; socket?: string; allowInTest?: boolean };

/** log_rule_violation through Today's own stdio MCP server; never from a test unless asked. */
async function logViolation(violation: ScratchViolation, options: LogOptions = {}): Promise<boolean> {
  if ((process.env.NODE_ENV === "test" && !options.allowInTest) || process.env.SCRATCH_WALL_LOG === "off") return false;
  const bin = options.bin ?? process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon");
  const socket = options.socket ?? `/run/user/${process.getuid!()}/today/daemon.sock`;
  const lines =
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-codex-proxy-scratch-wall", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "log_rule_violation", arguments: violation } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn([bin, "mcp", "--socket", socket], { env, stdin: new TextEncoder().encode(lines), stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    for (const line of stdout.split("\n")) {
      try {
        const reply = JSON.parse(line);
        if (reply.id === 2) return !reply.error && reply.result?.isError !== true;
      } catch {}
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Internals for the tests only. */
export const __test = {
  declaredScratchRoot,
  tmpWriteTarget,
  sweepReaderTmp,
  noteReaderRun,
  defaultRunStart,
  runStarts,
  MAX_RUNS,
  logViolation,
  sweeps,
};
