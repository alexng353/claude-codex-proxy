/**
 * The scratch wall (q scratch-tmp-wall, Nov 27): a reader that declares a scratch
 * root keeps its scratch out of /tmp, which is RAM tmpfs on Forge and Arch.
 *
 * Nov 23-24 nine comb and bench readers (violations #83-#94, all Claude readers,
 * p1-p4_claude__<key>) wrote probes, renders and lint output to /tmp, and the
 * prompts telling them not to did not hold. Every one of their shell commands is a
 * Codex exec_command call that this proxy writes (responses.ts), so the wall lives
 * here, where it applies to every Claude reader whichever host spawned it:
 *
 * (a) every exec_command of a reader runs with TMPDIR=<root>/tmp, so mktemp, Bun,
 *     Python's tempfile and the like land inside the root;
 * (b) a command whose write target is under /tmp (a redirection, tee, -o/--output,
 *     mkdir, touch, mktemp with an explicit /tmp) is replaced by a refusal that
 *     names the root, so nothing of it runs;
 * (c) when the reader gives its final answer, /tmp entries it named that are this
 *     user's own and newer than its run are moved (never deleted) to
 *     <root>/tmp-swept/ and counted with log_rule_violation, so a miss shows.
 *
 * The switch is a line `Scratch root: /abs/path` in the reader's task: a user
 * message or a multi-agent v2 task (task file included). The comb skill writes it
 * into every reader prompt and spawn message. Text a chat only read (a tool
 * output, a skill file) declares nothing, and the path must lie strictly inside
 * ~/.cache/agent-tmp. A chat without a declaration is untouched, byte for byte.
 *
 * (c) moves only entries the reader itself named, in its commands, their outputs
 * or its answer: other chats write to /tmp at the same time, and a bare "newer than
 * the run" would carry their live files off.
 */
import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { STRIPPED_ENV } from "./claude-env";
import { agentMessagePayload, requestTools, toolDescriptors } from "./request";
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from "./types";

export const SCRATCH_RULE = "Scratch goes under ~/.cache/agent-tmp/<task>; /tmp is RAM tmpfs";

export type ScratchViolation = { rule: string; evidence: string; threadId: string; proposedCheck: string };
export type SweepDeps = {
  /** When this reader's run started (ms), or undefined when unknown. */
  runStart?: (threadId: string, request: ResponsesRequest) => number | undefined;
  log?: (violation: ScratchViolation) => Promise<boolean>;
};
export type SweepResult = { root: string; moved: Array<{ from: string; to: string }>; logged: boolean };

const scratchBase = () => normalize(process.env.SCRATCH_WALL_BASE || join(homedir(), ".cache", "agent-tmp"));
const tmpDir = () => normalize(process.env.SCRATCH_WALL_TMP || "/tmp");

// Only plain path characters: the root is pasted into shell commands (quoted) and
// messages, and a placeholder like `<scratch>/r/<name>` must not count.
const ROOT_CHARS = /^[A-Za-z0-9._/@+-]+$/;
const DECLARATION = /^Scratch root: (\S+)[ \t]*$/gm;

function validRoot(path: string): boolean {
  if (!isAbsolute(path) || !ROOT_CHARS.test(path)) return false;
  if (normalize(path) !== path || path.endsWith("/")) return false;
  const base = scratchBase();
  return path.startsWith(`${base}/`);
}

const partsText = (content: ResponseInputItem["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => ["input_text", "output_text", "text"].includes(part.type ?? ""))
        .map((part) => part.text ?? "")
        .join("\n");

/** The texts that carry a chat's task: its user messages and agent messages. */
function taskTexts(request: ResponsesRequest): string[] {
  if (typeof request.input === "string") return [request.input];
  const texts: string[] = [];
  for (const item of request.input) {
    if (item.type === "agent_message") {
      const payload = agentMessagePayload(item);
      texts.push(payload.plain);
      if (payload.kind === "task-file") texts.push(payload.file.text);
    } else if ((item.type === undefined || item.type === "message") && item.role === "user") {
      texts.push(partsText(item.content));
    }
  }
  return texts;
}

/** The chat's declared scratch root, or undefined: then the wall does nothing. */
export function declaredScratchRoot(request: ResponsesRequest): string | undefined {
  for (const text of taskTexts(request))
    for (const match of text.matchAll(DECLARATION)) if (validRoot(match[1])) return match[1];
  return undefined;
}

// ---- (b) write targets under /tmp ----

const END = String.raw`(?=[\s'"\x60;|&<>()]|$)`;
const TMP_PATH = String.raw`(\/tmp(?:\/[^\s'"\x60;|&<>()]*)?)`;
const WRITE_PATTERNS = [
  // > >> >| &> &>> 2> 2>> with or without a space, quoted or not.
  new RegExp(String.raw`(?:^|[^<>&0-9])(?:[0-9]+|&)?>{1,2}\|?\s*['"]?` + TMP_PATH + END),
  new RegExp(String.raw`\btee\b(?:\s+-[-\w]+)*\s+['"]?` + TMP_PATH + END),
  new RegExp(String.raw`(?:^|\s)(?:-o|--output(?:-document|-file)?|--log-file)(?:=|\s+)?['"]?` + TMP_PATH + END),
  new RegExp(String.raw`\b(?:mkdir|touch)\b[^;&|\n]*?\s['"]?` + TMP_PATH + END),
  new RegExp(String.raw`\bmktemp\b[^;&|\n]*?[\s=]['"]?` + TMP_PATH + END),
];

/** The first write target under /tmp in a shell command, or undefined. */
export function tmpWriteTarget(cmd: string): string | undefined {
  for (const pattern of WRITE_PATTERNS) {
    const match = pattern.exec(cmd);
    if (match) return match[1];
  }
  return undefined;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function refusalCommand(target: string, root: string): string {
  const message =
    `scratch-tmp-wall: refused a write under /tmp (${target}); nothing of this command ran. ` +
    `/tmp is RAM tmpfs. Scratch root: ${root}. Write there instead; TMPDIR=${root}/tmp is set for every command.`;
  return `printf '%s\\n' ${shellQuote(message)} >&2; exit 1`;
}

/** (a) TMPDIR inside the root, made if missing, then the reader's own command unchanged. */
export function withScratchTmpdir(cmd: string, root: string): string {
  const tmp = shellQuote(`${root}/tmp`);
  return `mkdir -p -- ${tmp} 2>/dev/null; export TMPDIR=${tmp}\n${cmd}`;
}

const isExecCommand = (request: ResponsesRequest, name: string): boolean => {
  if (name === "exec_command") return true;
  const descriptor = toolDescriptors(requestTools(request)).find((tool) => tool.proxyName === name);
  return descriptor?.name === "exec_command" && descriptor.type !== "custom";
};

/** (a) and (b) on one response's tool calls. Returns `output` itself when nothing applies. */
export function wallToolCalls(request: ResponsesRequest, output: ProxyOutput): ProxyOutput {
  if (output.toolCalls.length === 0) return output;
  const root = declaredScratchRoot(request);
  if (!root) return output;
  let changed = false;
  const toolCalls = output.toolCalls.map((call) => {
    if (!isExecCommand(request, call.name)) return call;
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      return call; // responses.ts repairs or rejects it as before
    }
    if (!args || typeof args !== "object" || typeof (args as { cmd?: unknown }).cmd !== "string") return call;
    const cmd = (args as { cmd: string }).cmd;
    const target = tmpWriteTarget(cmd);
    changed = true;
    const next = target ? refusalCommand(target, root) : withScratchTmpdir(cmd, root);
    return { ...call, arguments: JSON.stringify({ ...(args as object), cmd: next }) };
  });
  return changed ? { ...output, toolCalls } : output;
}

// ---- (c) the exit sweep ----

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

/** The earlier of first sight and the v2 task file's mtime (written right before the spawn). */
function defaultRunStart(thread: string, request: ResponsesRequest): number | undefined {
  let start = runStarts.get(thread);
  if (Array.isArray(request.input))
    for (const item of request.input) {
      if (item.type !== "agent_message") continue;
      const payload = agentMessagePayload(item);
      if (payload.kind !== "task-file") continue;
      try {
        const mtime = statSync(payload.file.path).mtimeMs;
        start = start === undefined ? mtime : Math.min(start, mtime);
      } catch {}
    }
  return start;
}

// Entries that belong to the session or other daemons, never to a reader.
const NEVER_SWEPT = /^(?:\.|systemd-private-|tmux-|ssh-|claude-|bun-|today-|snap-private|pulse-)/;
const NAME = "[A-Za-z0-9._@+-]+";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function itemTexts(item: ResponseInputItem): string[] {
  const texts: string[] = [];
  for (const value of [item.arguments, item.input]) if (typeof value === "string") texts.push(value);
  if (item.output !== undefined) texts.push(typeof item.output === "string" ? item.output : JSON.stringify(item.output));
  return texts;
}

/** Top-level /tmp names the reader named in its commands, their outputs or its answer. */
export function namedTmpEntries(request: ResponsesRequest, output: ProxyOutput): Set<string> {
  const prefixes = [...new Set(["/tmp", tmpDir()])].map(escapeRegExp).join("|");
  const pattern = new RegExp(String.raw`(?:^|[^\w.~/-])(?:${prefixes})\/(${NAME})`, "g");
  const texts = [output.text];
  if (Array.isArray(request.input)) for (const item of request.input) texts.push(...itemTexts(item));
  const names = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(pattern))
      if (match[1] !== ".." && !NEVER_SWEPT.test(match[1])) names.add(match[1]);
  return names;
}

function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  for (let n = 1; ; n++) if (!existsSync(join(dir, `${name}.${n}`))) return join(dir, `${name}.${n}`);
}

/** mv, which copies and then unlinks across filesystems: the entry is moved, never deleted. */
function moveEntry(from: string, to: string): boolean {
  const mv = existsSync("/usr/bin/mv") ? "/usr/bin/mv" : "mv";
  const run = Bun.spawnSync([mv, "-n", "--", from, to], { stdout: "ignore", stderr: "pipe" });
  let gone = false;
  try {
    lstatSync(from);
  } catch {
    gone = true;
  }
  return run.exitCode === 0 && gone && existsSync(to);
}

// A small margin: a file made in the same second as the first request still counts.
const START_SLACK_MS = 2000;

/**
 * (c) On a declared reader's final answer, move its own new /tmp entries into
 * <root>/tmp-swept and log one violation. Undefined when nothing applies.
 */
export async function sweepReaderTmp(
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
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const tmp = tmpDir();
  const due: string[] = [];
  for (const name of namedTmpEntries(request, output)) {
    const path = join(tmp, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (uid !== undefined && stat.uid !== uid) continue;
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue;
    // Both times: a file made before the run and only written during it is someone else's.
    const since = start - START_SLACK_MS;
    if (stat.mtimeMs < since || (stat.birthtimeMs > 0 && stat.birthtimeMs < since)) continue;
    due.push(path);
  }
  if (due.length === 0) return undefined;
  const dest = join(root, "tmp-swept");
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const moved: SweepResult["moved"] = [];
  for (const from of due.sort()) {
    const to = freeName(dest, from.slice(tmp.length + 1));
    if (moveEntry(from, to)) moved.push({ from, to });
    else console.error(`scratch-wall: could not move ${from} to ${to}`);
  }
  if (moved.length === 0) return { root, moved, logged: false };
  const listed = moved.slice(0, 12).map((entry) => entry.from.slice(tmp.length + 1)).join(", ");
  const more = moved.length > 12 ? ` and ${moved.length - 12} more` : "";
  const violation: ScratchViolation = {
    rule: SCRATCH_RULE,
    threadId: thread,
    evidence:
      `scratch-tmp-wall exit sweep (claude-codex-proxy): reader thread ${thread} with scratch root ${root} ` +
      `left ${moved.length} /tmp entr${moved.length === 1 ? "y" : "ies"} made after its run started ` +
      `${new Date(start).toISOString()}: ${listed}${more}. Moved, not deleted, to ${dest}.`,
    proposedCheck:
      "scratch-tmp-wall already refuses redirection/tee/-o/mkdir/touch/mktemp writes under /tmp for declared readers; " +
      "extend tmpWriteTarget for the command shape that got through.",
  };
  const logged = await (deps.log ?? logViolation)(violation).catch((cause) => {
    console.error("scratch-wall: logging the violation failed:", (cause as Error).message);
    return false;
  });
  return { root, moved, logged };
}

/** log_rule_violation through Today's own stdio MCP server; never from a test. */
export async function logViolation(violation: ScratchViolation): Promise<boolean> {
  if (process.env.NODE_ENV === "test" || process.env.SCRATCH_WALL_LOG === "off") return false;
  const bin = process.env.TODAY_DAEMON_BIN ?? join(homedir(), ".local/bin/today-daemon");
  const socket = `/run/user/${process.getuid!()}/today/daemon.sock`;
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-codex-proxy-scratch-wall", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "log_rule_violation", arguments: violation } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const { CODEX_THREAD_ID: _thread, ...env } = process.env;
  for (const key of STRIPPED_ENV) delete env[key];
  const child = Bun.spawn([bin, "mcp", "--socket", socket], { env, stdin: new TextEncoder().encode(lines), stdout: "pipe", stderr: "pipe" });
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
