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
 * The switch is a line `Scratch root: /abs/path` in the chat's own task, seen on
 * the thread's first request: the task is the last input item after Codex's
 * injected context and nothing has run yet. The task is the v1 spawn message (not a
 * relayed <codex_delegation> or a <subagent_notification>, and not inside a fenced
 * block of 3+ backticks or tildes), or a v2 NEW_TASK served from its validated task
 * file. The decision is recorded with the run start (runs); a thread first seen on
 * a later request (a proxy restart, a compacted history, a brief mid-history) is
 * undeclared. Later messages, child replies and tool output declare nothing, and
 * the path must lie strictly inside ~/.cache/agent-tmp. A chat without a
 * declaration is untouched, byte for byte.
 *
 * The text match is a tripwire, not a sandbox (a quote-aware tokenizer is ticket
 * scratch-wall-tokenizer): cp, mv, tar, language-level writes, `cd /tmp` then a
 * relative path, variables, double-quoted shell text, write_stdin and apply_patch
 * get through (b); (c) still counts them when the command named the /tmp path.
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
const RELAY = /<codex_delegation[\s>]|<subagent_notification[\s>]/;

/** Drop fenced blocks: 3+ backticks or tildes, closed by the same character at least as long. */
function stripFences(text: string): string {
  const out: string[] = [];
  let open: { char: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === "") open = undefined;
      continue;
    }
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      open = { char: fence[1][0], length: fence[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

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

/**
 * The text of the chat's own task on its first request, or undefined: the task must
 * be the last input item after Codex's context, so nothing has run yet.
 */
function firstTaskText(request: ResponsesRequest): string | undefined {
  const input: ResponseInputItem[] =
    typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input;
  let index = leadingContextCount(input);
  while (index < input.length && (input[index].role === "developer" || input[index].role === "system")) index++;
  if (index !== input.length - 1) return undefined;
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

function taskDeclaration(request: ResponsesRequest): string | undefined {
  const text = firstTaskText(request);
  if (text === undefined) return undefined;
  for (const match of stripFences(text).matchAll(DECLARATION)) if (validRoot(match[1])) return match[1];
  return undefined;
}

type Run = { start: number; root: string; reported: Set<string> };
/** Per thread, decided on first sight: a declared reader's run, or null (undeclared). */
const runs = new Map<string, Run | null>();
const MAX_RUNS = 2000;

const threadOf = (request: ResponsesRequest): string | undefined =>
  typeof request.prompt_cache_key === "string" && request.prompt_cache_key ? request.prompt_cache_key : undefined;

/** Decide a thread on its first sight; call on every request, before wallToolCalls. */
export function noteReaderRun(request: ResponsesRequest, now = Date.now()): void {
  const thread = threadOf(request);
  if (!thread || runs.has(thread)) return;
  const root = taskDeclaration(request);
  if (runs.size >= MAX_RUNS) runs.delete(runs.keys().next().value!);
  runs.set(thread, root ? { start: now, root, reported: new Set() } : null);
}

function declaredScratchRoot(request: ResponsesRequest): string | undefined {
  const thread = threadOf(request);
  return thread ? runs.get(thread)?.root : undefined;
}

// ---- (b) write targets under /tmp ----

/** The heredoc delimiter word at `start`: quotes and backslashes removed, as the shell does. */
function delimiterAt(line: string, start: number): { word: string; end: number } {
  let word = "";
  let k = start;
  while (k < line.length && !/[\s;|&<>()]/.test(line[k])) {
    const char = line[k];
    if (char === "'" || char === '"') {
      const close = line.indexOf(char, k + 1);
      if (close < 0) return { word: "", end: line.length };
      word += line.slice(k + 1, close);
      k = close + 1;
    } else if (char === "\\") {
      word += line[k + 1] ?? "";
      k += 2;
    } else {
      word += char;
      k++;
    }
  }
  return { word, end: k };
}

/**
 * Drop heredoc bodies and their delimiter lines; the operator line stays. A `<<`
 * counts only outside quotes and comments; `<<-` strips leading tabs, and the
 * delimiter may be quoted or backslashed (`<<'EOF'`, `<<"EOF"`, `<<\EOF`).
 */
function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  const pending: Array<{ delimiter: string; dash: boolean }> = [];
  let quote: "'" | '"' | undefined;
  for (const line of cmd.split("\n")) {
    const open = pending[0];
    if (open && quote === undefined) {
      if ((open.dash ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
      continue;
    }
    out.push(line);
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote === "'") {
        if (char === "'") quote = undefined;
        continue;
      }
      if (quote === '"') {
        if (char === "\\") i++;
        else if (char === '"') quote = undefined;
        continue;
      }
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      // A comment starts a word and runs to the end of the line.
      if (char === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
      if (char === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
        let j = i + 2;
        const dash = line[j] === "-";
        if (dash) j++;
        while (line[j] === " " || line[j] === "\t") j++;
        const { word, end } = delimiterAt(line, j);
        if (word) pending.push({ delimiter: word, dash });
        i = end - 1;
      }
    }
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
/** Wrappers that run the next command, with the options of theirs that take a value. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir"],
  env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n", "--adjustment"],
  command: [],
  exec: ["-a"],
  time: ["-f", "-o", "--format", "--output"],
  nohup: [],
  builtin: [],
};
/** Commands whose short -o/-O takes the output path; curl and wget may cluster it (-sSo). */
const CLUSTERED_O = new Set(["curl", "wget"]);
const COMPILERS = new Set(["cc", "gcc", "clang", "g++", "c++", "clang++"]);
const LONG_OUTPUT = /^--(?:output(?:-[a-z]+)?|log-file|outdir|outfile|target-dir)(?:=(.*))?$/;
/** Options that take a value, per command, so the value is not an operand. */
const VALUE_OPTIONS: Record<string, string[]> = {
  touch: ["-r", "-d", "-t", "--reference", "--date"],
  mkdir: ["-m", "--mode", "--context"],
  tee: [],
  mktemp: ["-p", "--tmpdir", "--suffix"],
};

const operandsOf = (args: string[], valueOptions: string[]): string[] => {
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (valueOptions.includes(args[k])) k++;
    else if (!args[k].startsWith("-")) operands.push(args[k]);
  }
  return operands;
};

function commandTarget(words: string[]): string | undefined {
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return undefined;
    const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(word);
    if (assignment) {
      // CARGO_TARGET_DIR=/tmp/t cargo build: a *_DIR pointed into /tmp is a write target.
      if (assignment[1].endsWith("_DIR") && TMP_WORD.test(assignment[2])) return assignment[2];
      i++;
      continue;
    }
    const valueOptions = Object.hasOwn(WRAPPERS, word) ? WRAPPERS[word] : undefined;
    if (!valueOptions) break;
    i++;
    while (words[i]?.startsWith("-")) i += valueOptions.includes(words[i]) ? 2 : 1;
    // timeout's first operand is its duration, not the command.
    if (word === "timeout") i++;
  }
  const name = basename(words[i]);
  const args = words.slice(i + 1);
  for (const [index, arg] of args.entries()) {
    const long = LONG_OUTPUT.exec(arg);
    if (long) {
      const value = long[1] ?? args[index + 1];
      if (value !== undefined && TMP_WORD.test(value)) return value;
    }
  }
  const operands = operandsOf(args, VALUE_OPTIONS[name] ?? []);
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
  for (const [index, arg] of args.entries()) {
    // -o PATH, -oPATH, and for curl and wget also a cluster ending in o/O: -sSo PATH, -sSoPATH.
    const short = CLUSTERED_O.has(name) ? /^-[A-Za-z]*?[oO](.*)$/.exec(arg) : COMPILERS.has(name) ? /^-o(.*)$/.exec(arg) : null;
    if (!short) continue;
    const value = short[1] === "" ? args[index + 1] : short[1];
    if (value !== undefined && TMP_WORD.test(value)) return value;
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
    // The same repair responses.ts applies, so the wall sees what Codex will run;
    // silent, because responses.ts logs it for the call it emits.
    const repaired = repairToolArguments(call.arguments, { tool: call.name, threadId, silent: true });
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

function defaultRunStart(thread: string, _request: ResponsesRequest): number | undefined {
  return runs.get(thread)?.start;
}

// Entries that belong to the session or other daemons, never to a reader.
const NEVER_REPORTED = /^(?:\.|systemd-private-|tmux-|ssh-|claude-|bun-|today-|snap-private|pulse-)/;
const NAME = "[A-Za-z0-9._@+-]+";
const MAX_LOOKS = 50;
const MAX_NAMED = 12;
// A small margin for clock granularity between first sight and the first write.
const START_SLACK_MS = 1000;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The reader's own commands: exec_command cmd strings with heredoc bodies stripped,
 * and from apply_patch only the paths of its Add File, Update File and Move to
 * headers. Other tools' arguments (a message naming /tmp/x) are not commands.
 */
function ownCommands(request: ResponsesRequest): string[] {
  if (!Array.isArray(request.input)) return [];
  const texts: string[] = [];
  for (const item of request.input) {
    if (item.type === "function_call" && item.name === "exec_command" && typeof item.arguments === "string") {
      let args: { cmd?: unknown } | undefined;
      try {
        args = JSON.parse(repairToolArguments(item.arguments, { tool: item.name, silent: true }));
      } catch {
        continue;
      }
      if (typeof args?.cmd === "string") texts.push(stripHeredocs(args.cmd));
    } else if (item.type === "custom_tool_call" && item.name === "apply_patch" && typeof item.input === "string") {
      for (const header of item.input.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) texts.push(header[1].trim());
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
  // Each leftover is reported once per thread.
  const run = runs.get(thread);
  const unreported = fresh.filter((path) => !run?.reported.has(path));
  if (unreported.length === 0) return undefined;
  const busy = await busyPaths();
  const left = unreported.filter((path) => {
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
  // Only a report that reached the ledger counts; a failed one is tried again next time.
  if (logged) for (const path of left) run?.reported.add(path);
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

type LogOptions = { bin?: string; socket?: string; allowInTest?: boolean; deadlineMs?: number };

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
  const reader = child.stdout.getReader();
  // One deadline for the whole call: it kills the child and cancels the read, which
  // a descendant holding stdout open would otherwise keep waiting on.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reader.cancel().catch(() => {});
      resolve(false);
    }, options.deadlineMs ?? 15_000);
  });
  const work = (async () => {
    const decoder = new TextDecoder();
    let stdout = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    for (const line of stdout.split("\n")) {
      try {
        const reply = JSON.parse(line);
        if (reply.id === 2) return !reply.error && reply.result?.isError !== true;
      } catch {}
    }
    return false;
  })().catch(() => false);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Internals for the tests only. */
export const __test = {
  declaredScratchRoot,
  tmpWriteTarget,
  sweepReaderTmp,
  runs,
  defaultRunStart,
  MAX_RUNS,
  logViolation,
  sweeps,
};
