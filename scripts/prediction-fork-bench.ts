/**
 * Side-by-side measurement of composer predictions: the Haiku path in production
 * versus an invisible fork of the chat's own Claude session (src/prediction-fork.ts).
 *
 * Points come from live, parked proxy workers on this machine (their exact launch
 * arguments are read from /proc, so the fork reads the chat's prompt cache) and the
 * Today log: a completed turn that Alex caused, and, when he answered, his next
 * human message as the reference. The Haiku context is rebuilt as the daemon builds
 * it (predictions.rs recent_context) and sent through the production guarded call.
 *
 * Spends subscription quota. Raw text goes only to a private 0600 JSONL file:
 *   BENCH_OUTPUT=/private/path.jsonl bun scripts/prediction-fork-bench.ts
 * Optional: BENCH_MAX (points, default 24), BENCH_WINDOW_MS (default 55 min),
 * BENCH_EFFORT (override the fork's effort, to test what that does to the cache).
 */
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { accountEnv, listAccounts, type Account } from "../src/accounts";
import { STRIPPED_ENV } from "../src/claude-env";
import { FORK_PREDICTION_PROMPT, forkArgs, parseForkResult, type ForkOutcome } from "../src/prediction-fork";
import { guardedModelPrediction } from "../src/prediction-route";
import { closePredictionModel, prewarmPredictionModel } from "../src/prediction-model";
import { closePredictionPreparation, guardPredictionReply } from "../src/prediction-preparation";

const out = process.env.BENCH_OUTPUT ?? join(homedir(), ".cache/composer-predictions/fork-bench.jsonl");

/** Raw chat text only ever goes to a 0600 file. A missing directory is made 0700; an
 * existing one is left as it is (it may be the checkout, home or /tmp). */
function privateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  // Anything but a regular file we can append to is refused here, before quota is spent.
  if (!statSync(path).isFile()) throw new Error(`bench output ${path} is not a regular file`);
  chmodSync(path, 0o600);
  appendFileSync(path, "");
}
function privateAppend(path: string, text: string): void {
  privateFile(path);
  appendFileSync(path, text);
}
function privateWrite(path: string, text: string): void {
  privateFile(path);
  writeFileSync(path, text);
}
const maxPoints = Number(process.env.BENCH_MAX ?? 24);
const windowMs = Number(process.env.BENCH_WINDOW_MS ?? 55 * 60_000);
const effortOverride = process.env.BENCH_EFFORT;
// Latency and cache only: also take the latest turn of chats Alex did not cause.
const anyTurn = !!process.env.BENCH_ANY || !!process.env.BENCH_WATCH;
// Every completed turn in the window, not only each chat's latest (its prefix is still cached).
const allTurns = !!process.env.BENCH_ALL;
const todayDb = process.env.TODAY_DB_PATH ?? join(homedir(), ".local/state/today/daemon.sqlite");
const usagePath = join(homedir(), ".local/state/claude-codex-proxy/usage.jsonl");
const claudeCwd = process.env.CLAUDE_CWD ?? join(homedir(), ".local/share/claude-codex-proxy");
const now = Date.now();

type Worker = { pid: number; args: string[]; bin: string; sessionId: string; account: Account };

function liveWorkers(): Worker[] {
  const accounts = listAccounts();
  const workers: Worker[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${name}/cmdline`).toString().split("\0").filter((part, i, all) => i < all.length - 1 || part);
    } catch {
      continue;
    }
    if (!argv[0]?.includes("/claude/versions/") || !argv.includes("--json-schema")) continue;
    const at = argv.indexOf("--session-id");
    if (at < 0) continue;
    // Only the account's config dir is read from the environment, never a credential.
    let dir: string | undefined;
    try {
      for (const entry of readFileSync(`/proc/${name}/environ`).toString().split("\0"))
        if (entry.startsWith("CLAUDE_CONFIG_DIR=")) dir = entry.slice("CLAUDE_CONFIG_DIR=".length);
    } catch {
      continue;
    }
    const account = dir ? accounts.find((a) => a.dir === dir) : accounts.find((a) => a.isDefault);
    if (!account) continue;
    workers.push({ pid: Number(name), bin: argv[0], args: argv.slice(1), sessionId: argv[at + 1]!, account });
  }
  return workers;
}

/** sessionId -> thread, from the proxy's usage log (tail only). */
function sessionThreads(): Map<string, string> {
  const text = readFileSync(usagePath, "utf8");
  const map = new Map<string, string>();
  const since = new Date(now - 6 * 3_600_000).toISOString();
  for (const line of text.slice(-80_000_000).split("\n")) {
    if (!line.includes('"sessionId"')) continue;
    try {
      const row = JSON.parse(line);
      if (row.timestamp >= since && row.sessionId && row.threadId) map.set(row.sessionId, row.threadId);
    } catch {}
  }
  return map;
}

type Entry = { uuid: string; at: number; text: string };

/** Accepted StructuredOutput answers in a transcript, with the result entry to resume at. */
function checkpoints(account: Account, sessionId: string): Entry[] {
  const roots = [join(account.dir, "projects"), join(homedir(), ".claude/projects")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const project of readdirSync(root)) {
      const path = join(root, project, `${sessionId}.jsonl`);
      if (!existsSync(path)) continue;
      const outputs = new Map<string, string>();
      const entries: Entry[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        try {
          const entry = JSON.parse(line);
          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;
          if (entry.type === "assistant" && !entry.isApiErrorMessage) {
            for (const block of content)
              if (block.type === "tool_use" && block.name === "StructuredOutput")
                outputs.set(block.id, String(block.input?.text ?? ""));
          } else if (entry.type === "user") {
            for (const block of content)
              if (block.type === "tool_result" && !block.is_error && outputs.has(block.tool_use_id))
                entries.push({ uuid: entry.uuid, at: Date.parse(entry.timestamp), text: outputs.get(block.tool_use_id)! });
          }
        } catch {}
      }
      return entries;
    }
  }
  return [];
}

const db = new Database(todayDb, { readonly: true });
const RELAYED = new Set(["phone", "email", "plate", "jarvis"]);
const alexClient = (client: unknown) =>
  typeof client === "string" &&
  (client === "today-gpui" || client.startsWith("today-gpui@") || client === "window" || RELAYED.has(client));

function humanCaused(thread: string, turn: string, cutoff: number): boolean {
  const rows = db
    .query(
      `WITH deliveries AS MATERIALIZED (
         SELECT seq, json_extract(body, '$.message_seq') AS message_seq FROM events
         WHERE thread_id = ?1 AND seq <= ?3 AND CASE WHEN body GLOB '{"type":"delivery",*' THEN
           json_extract(body, '$.state.turn_id') = ?2 AND json_extract(body, '$.state.state') IN ('started_turn', 'steered')
           ELSE 0 END ORDER BY seq DESC LIMIT 256)
       SELECT m.actor, CASE WHEN m.body GLOB '{"type":"user_message",*' THEN json_extract(m.body, '$.client') END AS client
       FROM deliveries d JOIN events m ON m.thread_id = ?1 AND m.seq = d.message_seq AND m.seq < d.seq`,
    )
    .all(thread, turn, cutoff) as Array<{ actor: string; client: string | null }>;
  return rows.some((row) => row.actor === "me" && alexClient(row.client));
}

/** predictions.rs: newest events under 64 KiB, then the last 8 messages under 15,000 bytes. */
function recentContext(thread: string, cutoff: number): string {
  const rows = db
    .query("SELECT actor, body FROM events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 128")
    .all(thread, cutoff + 1) as Array<{ actor: string; body: string }>;
  const page: Array<{ actor: string; body: Record<string, unknown> }> = [];
  let total = 0;
  for (const row of rows) {
    const body = JSON.parse(row.body);
    // today-store slim_body!: diff notices are counted without their diff.
    let size = Buffer.byteLength(row.body);
    if (row.body.startsWith('{"type":"engine_notice","method":"turn/diff/updated"') && typeof body.params?.diff === "string")
      size -= Buffer.byteLength(JSON.stringify(body.params.diff)) - 40;
    if (page.length && total + size > 64 * 1024) break;
    total += size;
    page.push({ actor: row.actor, body });
  }
  const messages: string[] = [];
  let bytes = 0;
  for (const { actor, body } of page) {
    let message: string;
    if (body.type === "user_message" && actor === "me" && alexClient(body.client)) message = `Alex: ${body.text}`;
    else if (body.type === "item" && (body.role as { kind?: string } | undefined)?.kind === "agent" && typeof body.text === "string")
      message = `Assistant: ${body.text}`;
    else continue;
    const size = Buffer.byteLength(message);
    if (!messages.length && size > 15000) {
      messages.push(Buffer.from(message).subarray(size - 15000).toString());
      break;
    }
    if (bytes + size > 15000) break;
    bytes += size;
    messages.push(message);
    if (messages.length >= 8) break;
  }
  return messages.reverse().join("\n\n");
}

type Point = {
  thread: string;
  turn: string;
  completedAt: number;
  cutoff: number;
  worker: Worker;
  checkpoint: Entry;
  reference?: string;
  latest: boolean;
  human: boolean;
};

function points(since = now - windowMs): Point[] {
  const threads = sessionThreads();
  const found: Point[] = [];
  for (const worker of liveWorkers()) {
    const engine = threads.get(worker.sessionId);
    if (!engine) continue;
    const row = db
      .query("SELECT thread_id FROM threads WHERE engine_thread_id = ? OR thread_id = ? LIMIT 1")
      .get(engine, engine) as { thread_id: string } | null;
    if (!row) continue;
    const thread = row.thread_id;
    const entries = checkpoints(worker.account, worker.sessionId);
    if (!entries.length) continue;
    const events = (
      db
        .query("SELECT seq, actor, at_ms, body FROM events WHERE thread_id = ? AND at_ms >= ? ORDER BY seq")
        .all(thread, since) as Array<{ seq: number; actor: string; at_ms: number; body: string }>
    ).map((event) => ({ ...event, parsed: JSON.parse(event.body) as Record<string, unknown> }));
    const completions = events.filter(
      (event) => event.parsed.type === "turn_completed" && event.parsed.status === "completed",
    );
    for (const [index, completion] of completions.entries()) {
      const turn = String(completion.parsed.turn_id);
      const human = humanCaused(thread, turn, completion.seq);
      const latest = index === completions.length - 1;
      if (!human && !(anyTurn && (latest || allTurns))) continue;
      // The transcript answer that ended this turn: the last one at or before it.
      const checkpoint = entries.filter((entry) => entry.at <= completion.at_ms + 2000).at(-1);
      if (!checkpoint || completion.at_ms - checkpoint.at > 120_000) continue;
      let reference: string | undefined;
      for (const next of events) {
        if (next.seq <= completion.seq) continue;
        if (next.parsed.type === "turn_started") break;
        if (next.parsed.type === "user_message") {
          if (next.actor === "me" && alexClient(next.parsed.client) && !next.parsed.generated_origin)
            reference = String(next.parsed.text);
          break;
        }
      }
      if (!reference && !latest && !allTurns) continue;
      found.push({ thread, turn, completedAt: completion.at_ms, cutoff: completion.seq, worker, checkpoint, reference, latest, human });
    }
  }
  // Points with a reference first (they measure quality too), newest first.
  return found
    .sort((a, b) => Number(!!b.reference) - Number(!!a.reference) || b.completedAt - a.completedAt)
    .slice(0, maxPoints);
}

async function runFork(point: Point, effort = effortOverride) {
  const args = forkArgs(point.worker.args, point.worker.sessionId, point.checkpoint.uuid, effort);
  const env = { ...process.env } as Record<string, string>;
  for (const key of STRIPPED_ENV) delete env[key];
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  const started = performance.now();
  const child = Bun.spawn([point.worker.bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    cwd: claudeCwd,
    env: { ...env, ...accountEnv(point.worker.account) },
  });
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: FORK_PREDICTION_PROMPT }] } }) + "\n");
  child.stdin.flush();
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let initMs: number | undefined;
  let result: Record<string, unknown> | undefined;
  let buffer = "";
  const decoder = new TextDecoder();
  outer: for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "system" && event.subtype === "init") initMs = performance.now() - started;
        if (event.type === "result") {
          result = event;
          break outer;
        }
      } catch {}
    }
  }
  const totalMs = performance.now() - started;
  clearTimeout(timer);
  child.kill("SIGKILL");
  await child.exited;
  const outcome = result ? parseForkResult(result) : ({ kind: "failed", reason: "no result" } as ForkOutcome);
  const text = outcome.kind === "suggested" ? outcome.text : null;
  const safe = text ? await guardPredictionReply(text) : false;
  return {
    kind: outcome.kind,
    reason: outcome.kind === "failed" ? outcome.reason : undefined,
    usage: outcome.usage,
    text: safe ? text : null,
    rawRejected: text && !safe ? true : undefined,
    initMs,
    totalMs,
    effort: args[args.indexOf("--effort") + 1],
  };
}

async function runHaiku(point: Point) {
  const context = recentContext(point.thread, point.cutoff);
  const started = performance.now();
  try {
    const text = await guardedModelPrediction(context, [], AbortSignal.timeout(12000), Date.now() + 12000);
    return { text, totalMs: performance.now() - started, contextChars: context.length };
  } catch (error) {
    return { text: null, totalMs: performance.now() - started, error: String(error), contextChars: context.length };
  }
}

/** Alex's next human message after the turn, if he wrote one before another turn began. */
function reference(thread: string, cutoff: number): string | null {
  const rows = db
    .query("SELECT actor, body FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT 4000")
    .all(thread, cutoff) as Array<{ actor: string; body: string }>;
  for (const row of rows) {
    if (row.body.startsWith('{"type":"turn_started"')) return null;
    if (!row.body.startsWith('{"type":"user_message"')) continue;
    const body = JSON.parse(row.body);
    return row.actor === "me" && alexClient(body.client) && !body.generated_origin ? String(body.text) : null;
  }
  return null;
}

async function measure(point: Point, label: string) {
  const fork = await runFork(point);
  // The same point again at low effort, to compare latency on one context.
  const forkLow = process.env.BENCH_PAIR_LOW ? await runFork(point, "low") : undefined;
  const haiku = await runHaiku(point);
  privateAppend(
    out,
    JSON.stringify({
      at: Date.now(),
      thread: point.thread,
      turn: point.turn,
      cutoff: point.cutoff,
      ageMs: Date.now() - point.completedAt,
      latest: point.latest,
      human: point.human,
      account: point.worker.account.name,
      model: point.worker.args[point.worker.args.indexOf("--model") + 1],
      reference: point.reference ?? null,
      lastAnswer: point.checkpoint.text.slice(-600),
      fork,
      forkLow,
      haiku,
    }) + "\n",
  );
  console.error(
    `bench ${label}: ${point.human ? "human" : "agent"} fork ${Math.round(fork.totalMs)} ms read ${fork.usage?.cacheReadTokens} write ${fork.usage?.cacheWriteTokens} in ${fork.usage?.inputTokens} ${fork.text ? "suggested" : "none"}${forkLow ? `; low ${Math.round(forkLow.totalMs)} ms read ${forkLow.usage?.cacheReadTokens}` : ""}; haiku ${Math.round(haiku.totalMs)} ms ctx ${haiku.contextChars} ${haiku.text ? "suggested" : "none"}`,
  );
}

/**
 * Quality on Alex's real replies from the last BENCH_COLD_HOURS (48): the chat's
 * model-visible history is rebuilt from its Codex rollout up to the turn he answered,
 * fitted to BENCH_COLD_BUDGET tokens (120,000) with the proxy's own replay code, and
 * sent cold to the chat's model with the fork prompt; Haiku gets the daemon's context.
 * Uncached, so its latency and cost say nothing about a real fork; only its text counts.
 */
async function coldQuality() {
  const { fitReplay, replayTokens } = await import("../src/budget");
  const { conversationRequest, prepareClaudePrompt, leadingContextCount } = await import("../src/request");
  const { buildClaudeArgs } = await import("../src/claude");
  const { stateDir } = await import("../src/sessions");
  // Pins are read through a read-only connection; prompt files go to a scratch state dir.
  const pins = new Database(join(stateDir(), "sessions.sqlite"), { readonly: true });
  const pinOf = (thread: string) =>
    (pins.query("SELECT account FROM thread_accounts WHERE thread_id = ?").get(thread) as { account: string } | null)?.account;
  const scratchState = mkdtempSync(join(tmpdir(), "prediction-bench-state-"));
  process.on("exit", () => rmSync(scratchState, { recursive: true, force: true }));
  // A default SIGINT/SIGTERM skips "exit" handlers: exit properly so the cleanup runs.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));
  const launchArgs = (request: Parameters<typeof buildClaudeArgs>[0]) => {
    const live = process.env.PROXY_STATE_DIR;
    process.env.PROXY_STATE_DIR = scratchState;
    try {
      return buildClaudeArgs(request);
    } finally {
      if (live === undefined) delete process.env.PROXY_STATE_DIR;
      else process.env.PROXY_STATE_DIR = live;
    }
  };
  const since = Date.now() - Number(process.env.BENCH_COLD_HOURS ?? 48) * 3_600_000;
  const budget = Number(process.env.BENCH_COLD_BUDGET ?? 120_000);
  const perThread = Number(process.env.BENCH_COLD_PER_THREAD ?? 3);
  const sessionsRoot = join(homedir(), ".local/state/today/codex-home/sessions");
  const rollouts = new Map<string, string>();
  for (const path of new Bun.Glob("**/rollout-*.jsonl").scanSync(sessionsRoot)) {
    const id = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1];
    if (id) rollouts.set(id, join(sessionsRoot, path));
  }
  const replies = db
    .query(
      `SELECT thread_id, seq, at_ms, body FROM events WHERE at_ms >= ? AND actor = 'me'
       AND body GLOB '{"type":"user_message",*' ORDER BY at_ms DESC`,
    )
    .all(since) as Array<{ thread_id: string; seq: number; at_ms: number; body: string }>;
  const taken = new Map<string, number>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);
  let done = 0;
  for (const reply of replies) {
    if (done >= maxPoints) break;
    const message = JSON.parse(reply.body);
    if (!alexClient(message.client) || message.generated_origin) {
      skip("not human");
      continue;
    }
    if ((taken.get(reply.thread_id) ?? 0) >= perThread) continue;
    // The turn he answered: the last completion before his message, with no turn between.
    let completion: { seq: number; at_ms: number; turn: string } | undefined;
    for (const row of db
      .query("SELECT seq, at_ms, body FROM events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 400")
      .all(reply.thread_id, reply.seq) as Array<{ seq: number; at_ms: number; body: string }>) {
      if (row.body.startsWith('{"type":"turn_started"') || row.body.startsWith('{"type":"user_message"')) break;
      if (row.body.startsWith('{"type":"turn_completed"')) {
        const body = JSON.parse(row.body);
        if (body.status === "completed") completion = { seq: row.seq, at_ms: row.at_ms, turn: body.turn_id };
        break;
      }
    }
    if (!completion) {
      skip("no completed turn before");
      continue;
    }
    if (!humanCaused(reply.thread_id, completion.turn, completion.seq)) {
      skip("agent turn");
      continue;
    }
    // The engine thread bound when that turn ran (a chat can be rebound to a fresh one).
    const thread = db
      .query("SELECT engine_thread_id FROM engine_bindings WHERE thread_id = ? AND bound_at_ms <= ? ORDER BY bound_at_ms DESC LIMIT 1")
      .get(reply.thread_id, completion.at_ms) as { engine_thread_id: string } | null;
    const engine = thread?.engine_thread_id;
    const rollout = engine ? rollouts.get(engine) : undefined;
    if (!engine || !rollout) {
      skip("no rollout");
      continue;
    }
    let model: string | undefined;
    let instructions: string | undefined;
    let compacted = false;
    const items: Record<string, unknown>[] = [];
    for (const line of readFileSync(rollout, "utf8").split("\n")) {
      if (!line) continue;
      let entry: Record<string, any>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (Date.parse(entry.timestamp) > completion.at_ms + 1000) break;
      if (entry.type === "session_meta") instructions = entry.payload?.base_instructions?.text;
      else if (entry.type === "turn_context") model = entry.payload?.model;
      else if (entry.type === "compacted") compacted = true;
      else if (entry.type === "response_item") items.push(entry.payload);
    }
    if (compacted || !model?.startsWith("claude-") || items.length < 2) {
      skip(compacted ? "compacted" : items.length < 2 ? "short" : `model ${model}`);
      continue;
    }
    const request = { model, instructions, input: items, tools: [], reasoning: { effort: "low" } } as never;
    let fitted = fitReplay(request, budget);
    // Long chats of messages (Bubble) stay over budget after tool output is trimmed:
    // keep the newest items that fit. A real fork sees all of it, so this is conservative.
    if (!fitted.fits && Array.isArray(fitted.request.input)) {
      const input = fitted.request.input;
      const lead = leadingContextCount(input);
      let start = lead;
      const cut = () => ({ ...fitted.request, input: [...input.slice(0, lead), ...input.slice(start)] });
      while (start < input.length - 2 && replayTokens(cut()) > budget) start += Math.max(1, Math.floor((input.length - start) / 20));
      fitted = { ...fitted, request: cut(), tokens: replayTokens(cut()), omitted: start - lead };
    }
    const prepared = await prepareClaudePrompt(conversationRequest(fitted.request));
    const accounts = listAccounts();
    const account = accounts.find((a) => a.name === pinOf(engine)) ?? accounts.find((a) => a.isDefault)!;
    const env = { ...process.env } as Record<string, string>;
    for (const key of STRIPPED_ENV) delete env[key];
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    const started = performance.now();
    const child = Bun.spawn([process.env.CLAUDE_BIN ?? join(homedir(), ".local/share/claude/versions/2.1.302"), ...launchArgs(fitted.request)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      cwd: join(homedir(), ".cache/composer-predictions"),
      env: { ...env, ...accountEnv(account) },
    });
    const content = [...prepared.content, { type: "text", text: FORK_PREDICTION_PROMPT }];
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    child.stdin.flush();
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    let result: Record<string, unknown> | undefined;
    let buffer = "";
    const decoder = new TextDecoder();
    outer: for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "result") {
            result = event;
            break outer;
          }
        } catch {}
      }
    }
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await prepared.cleanup();
    const outcome = result ? parseForkResult(result) : ({ kind: "failed", reason: "no result" } as ForkOutcome);
    const text = outcome.kind === "suggested" && (await guardPredictionReply(outcome.text)) ? outcome.text : null;
    const haikuContext = recentContext(reply.thread_id, completion.seq);
    const haikuStarted = performance.now();
    let haiku: string | null = null;
    try {
      haiku = await guardedModelPrediction(haikuContext, [], AbortSignal.timeout(12000), Date.now() + 12000);
    } catch {}
    taken.set(reply.thread_id, (taken.get(reply.thread_id) ?? 0) + 1);
    done++;
    privateAppend(
      out,
      JSON.stringify({
        at: Date.now(),
        thread: reply.thread_id,
        turn: completion.turn,
        model,
        account: account.name,
        reference: String(message.text),
        replayTokens: fitted.tokens,
        elided: fitted.elided,
        omitted: fitted.omitted,
        cold: { kind: outcome.kind, reason: outcome.kind === "failed" ? outcome.reason : undefined, text, usage: outcome.usage, totalMs: performance.now() - started },
        haiku: { text: haiku, totalMs: performance.now() - haikuStarted, contextChars: haikuContext.length },
      }) + "\n",
    );
    console.error(`cold ${done}: ${reply.thread_id.slice(0, 8)} replay ${fitted.tokens} tokens; fork ${outcome.kind}${text ? "" : " (no text)"}; haiku ${haiku ? "suggested" : "none"}`);
  }
  console.error(`cold: ${done} points, skipped ${JSON.stringify(skipped)} of ${replies.length} messages`);
}

if (process.env.BENCH_JOIN) {
  // Fill in Alex's reply for watched points, once he has written it.
  const rows = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const joined = rows.map((row) => ({ ...row, reference: row.reference ?? reference(row.thread, row.cutoff) }));
  privateWrite(process.env.BENCH_JOIN, joined.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.error(`joined ${joined.filter((row) => row.reference).length} of ${joined.length} with Alex's reply`);
  process.exit(0);
}

// Fail on an unusable output before any model call spends quota.
if (!process.env.BENCH_DRY) privateFile(out);
prewarmPredictionModel();
await Bun.sleep(3000);

if (process.env.BENCH_COLD) {
  await coldQuality();
  await closePredictionModel();
  closePredictionPreparation();
  process.exit(0);
}

if (process.env.BENCH_WATCH) {
  // Fork as production would: right after a completed turn. Alex's turns always;
  // other chats' turns at most once per BENCH_AGENT_EVERY_MS, for latency and cache only.
  const until = Date.now() + Number(process.env.BENCH_WATCH) * 3_600_000;
  const agentEvery = Number(process.env.BENCH_AGENT_EVERY_MS ?? 300_000);
  const maxHuman = Number(process.env.BENCH_MAX_HUMAN ?? 30);
  const maxAgent = Number(process.env.BENCH_MAX_AGENT ?? 20);
  const seen = new Set<string>();
  let lastAgent = 0,
    humans = 0,
    agents = 0;
  while (Date.now() < until && (humans < maxHuman || agents < maxAgent)) {
    for (const point of points(Date.now() - 90_000)) {
      const key = `${point.thread}:${point.turn}`;
      if (seen.has(key) || !point.latest) continue;
      seen.add(key);
      if (point.human ? humans >= maxHuman : agents >= maxAgent || Date.now() - lastAgent < agentEvery) continue;
      if (point.human) humans++;
      else {
        agents++;
        lastAgent = Date.now();
      }
      try {
        await measure(point, `${humans}h/${agents}a`);
      } catch (error) {
        console.error(`bench: ${String(error)}`);
      }
    }
    await Bun.sleep(15_000);
  }
  await closePredictionModel();
  closePredictionPreparation();
  process.exit(0);
}

const chosen = points();
console.error(`bench: ${chosen.length} points (${chosen.filter((p) => p.reference).length} with Alex's reply)`);
if (process.env.BENCH_DRY) {
  for (const point of chosen) {
    const last = db
      .query("SELECT body FROM events WHERE thread_id = ? AND seq < ? AND body GLOB '{\"type\":\"item\",*' ORDER BY seq DESC LIMIT 1")
      .get(point.thread, point.cutoff) as { body: string } | null;
    const agent = last ? String(JSON.parse(last.body).text ?? "") : "";
    const same = agent.trim().slice(0, 80) === point.checkpoint.text.trim().slice(0, 80);
    console.error(
      `${point.thread.slice(0, 8)} turn ${point.turn.slice(0, 8)} age ${Math.round((now - point.completedAt) / 60000)}m ref ${!!point.reference} latest ${point.latest} acct ${point.worker.account.name} checkpoint-matches-log ${same}`,
    );
  }
  process.exit(0);
}
for (const [index, point] of chosen.entries()) await measure(point, `${index + 1}/${chosen.length}`);
await closePredictionModel();
closePredictionPreparation();
db.close();
