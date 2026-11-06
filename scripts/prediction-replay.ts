/**
 * Offline replay of composer predictions against what Alex actually sent next.
 *
 * Cases are real turn ends from Today's log (read-only): a completed turn Alex caused,
 * followed by his own next message before any other turn began. For each one the
 * harness rebuilds what the proxy is given (predictions.rs recent_context, the corpus
 * examples older than the turn) and asks the predictors of this checkout:
 *
 *   haiku  the production guarded Haiku call (src/prediction-route.ts)
 *   fork   the fork prompt (src/prediction-fork.ts) on the chat's own model, over its
 *          history rebuilt from the Codex rollout (old Claude transcripts are pruned,
 *          so a real fork of a past turn is not possible). Uncached: spends quota.
 *
 * Raw text is written only to 0600 files under REPLAY_DIR (default
 * ~/.cache/prediction-bias, 0700). Usage:
 *   bun scripts/prediction-replay.ts extract            # cases.jsonl
 *   bun scripts/prediction-replay.ts run haiku LABEL    # LABEL-haiku.jsonl
 *   bun scripts/prediction-replay.ts run fork LABEL     # LABEL-fork.jsonl
 *   bun scripts/prediction-replay.ts score LABEL...     # table, text-free
 * Env: REPLAY_THREADS (comma list, default Bubble + the chats Alex wrote most in),
 * REPLAY_DAYS (5), REPLAY_MAX (per thread, 80), REPLAY_FORK_MAX (fork cases, 40),
 * REPLAY_SPLIT (dev|held|all for run, default all), REPLAY_FORK_BUDGET (50000),
 * REPLAY_ACCOUNT (fork account), REPLAY_IDS (file of case ids for fork).
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, listAccounts } from "../src/accounts";
import { STRIPPED_ENV } from "../src/claude-env";
import { createScrubber } from "../src/scrub.mjs";
import { PredictionCorpus } from "../src/prediction-corpus";
import { FORK_PREDICTION_PROMPT, parseForkResult, type ForkOutcome } from "../src/prediction-fork";
import { guardedModelPrediction } from "../src/prediction-route";
import { closePredictionModel, prewarmPredictionModel } from "../src/prediction-model";
import { closePredictionPreparation, guardPredictionReply } from "../src/prediction-preparation";
import * as predictions from "../src/predictions";

const dir = process.env.REPLAY_DIR ?? join(homedir(), ".cache/prediction-bias");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const todayDb = process.env.TODAY_DB_PATH ?? join(homedir(), ".local/state/today/daemon.sqlite");
const proxyState = join(homedir(), ".local/state/claude-codex-proxy");

function privateWrite(name: string, lines: unknown[]): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = constants;
  const fd = openSync(join(dir, name), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${name} is not a regular file`);
    fchmodSync(fd, 0o600);
    writeSync(fd, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  } finally {
    closeSync(fd);
  }
}
const readLines = <T>(name: string): T[] =>
  readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);

export type Case = {
  id: string;
  thread: string;
  title: string;
  turn: string;
  completedAt: number;
  cutoff: number;
  split: "dev" | "held";
  context: string;
  lastAnswer: string;
  reference: string;
  /** The chat's Codex thread when the turn ran, whose rollout the fork replay reads. */
  engine?: string;
};
export type Result = {
  id: string;
  predictor: string;
  /** What the composer would show; null means nothing shown. */
  shown: string | null;
  /** The model's raw text, before any screening. */
  raw?: string | null;
  kind?: string;
  ms: number;
  tokens?: Record<string, number>;
};

// ---- scoring (pure, also used by tests) ----

export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokens = (text: string) => (normalize(text) ? normalize(text).split(" ") : []);
export function tokenF1(a: string, b: string): number {
  const x = tokens(a),
    y = tokens(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const t of y) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of x) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      common++;
      counts.set(t, n - 1);
    }
  }
  if (!common) return 0;
  const p = common / x.length,
    r = common / y.length;
  return (2 * p * r) / (p + r);
}
/** Near match: token F1 >= 0.6, or the same first three words. */
export function nearMatch(prediction: string, actual: string): boolean {
  const p = tokens(prediction),
    a = tokens(actual);
  if (tokenF1(prediction, actual) >= 0.6) return true;
  return p.length >= 3 && a.length >= 3 && p.slice(0, 3).join(" ") === a.slice(0, 3).join(" ");
}
const STOP = new Set(
  "the a an and or but to of in on for with is are was be it its this that do does did i im you your me my we our so if not no just can will would should what when how why where who which there then than also about from at as by have has had get got like ok okay yes yeah".split(" "),
);
/** On topic: shares a content word (4+ letters, not a stop word) with the actual message. */
export function onTopic(prediction: string, actual: string): boolean {
  const words = (s: string) => new Set(tokens(s).filter((t) => t.length >= 4 && !STOP.has(t)));
  const a = words(actual);
  for (const t of words(prediction)) if (a.has(t)) return true;
  return false;
}
/** Scorer's own bare-ack test, independent of the code under test. */
const ACK_WORDS = new Set(
  ("ok okay k kk okk sounds sound good great cool nice thanks thank you thx ty tysm gn goodnight night nite " +
    "yes yep yeah yea ya yup sure perfect got it will do alright aight bet lgtm done np noted fine sg sgtm awesome " +
    "sweet makes sense go ahead true fair agreed mhm lol haha for now then all right that works me heading to bed " +
    "sleep going off im ill i").split(" "),
);
export function scorerBareAck(text: string): boolean {
  const t = tokens(text);
  return t.length > 0 && t.length <= 8 && t.every((w) => ACK_WORDS.has(w));
}
/** The answer ends on something to agree to: a question, an offer, or a bedtime/sign-off. */
export function closingAsk(answer: string): boolean {
  const tail = answer.trim().split(/\n+/).at(-1) ?? "";
  return /\?\s*\W*$/.test(tail) || /\b(want me|shall i|should i|say "|bed\b|good ?night|go ahead)/i.test(tail);
}

// ---- extraction ----

const RELAYED = new Set(["phone", "email", "plate", "jarvis"]);
const alexClient = (client: unknown) =>
  typeof client === "string" &&
  (client === "today-gpui" || client.startsWith("today-gpui@") || client === "window" || RELAYED.has(client));

function openToday() {
  return new Database(todayDb, { readonly: true });
}

function humanCaused(db: Database, thread: string, turn: string, cutoff: number): boolean {
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

/** predictions.rs read_prediction_events + recent_context, byte for byte. */
function recentContext(db: Database, thread: string, cutoff: number): string {
  const rows = db
    .query("SELECT actor, body FROM events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 128")
    .all(thread, cutoff + 1) as Array<{ actor: string; body: string }>;
  const page: Array<{ actor: string; body: Record<string, unknown> }> = [];
  let total = 0;
  for (const row of rows) {
    const body = JSON.parse(row.body);
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

function extract(): void {
  const db = openToday();
  const days = Number(process.env.REPLAY_DAYS ?? 5);
  const since = Date.now() - days * 86_400_000;
  const perThread = Number(process.env.REPLAY_MAX ?? 80);
  const threads = (process.env.REPLAY_THREADS ?? "").split(",").filter(Boolean);
  if (!threads.length) {
    // Bubble plus the other chats Alex wrote in most, excluding throwaway tests.
    const rows = db
      .query(
        `SELECT e.thread_id AS id, t.title AS title, count(*) AS n FROM events e JOIN threads t USING(thread_id)
         WHERE e.actor = 'me' AND e.at_ms >= ? AND e.body GLOB '{"type":"user_message",*'
         GROUP BY 1 ORDER BY 3 DESC LIMIT 12`,
      )
      .all(since) as Array<{ id: string; title: string; n: number }>;
    for (const row of rows) if (!/throwaway|^comb |^btw:/i.test(row.title) && row.n >= 4) threads.push(row.id);
  }
  const cases: Case[] = [];
  for (const thread of threads) {
    const title = (db.query("SELECT title FROM threads WHERE thread_id = ?").get(thread) as { title: string }).title;
    const replies = db
      .query(
        `SELECT seq, at_ms, body FROM events WHERE thread_id = ? AND at_ms >= ? AND actor = 'me'
         AND body GLOB '{"type":"user_message",*' ORDER BY seq`,
      )
      .all(thread, since) as Array<{ seq: number; at_ms: number; body: string }>;
    const found: Case[] = [];
    for (const reply of replies) {
      const message = JSON.parse(reply.body);
      if (!alexClient(message.client) || message.generated_origin) continue;
      if (/<(?:codex_delegation|system-reminder|automation)[\s>]/i.test(message.text ?? "")) continue;
      let completion: { seq: number; at: number; turn: string } | undefined;
      let answer: string | undefined;
      for (const row of db
        .query("SELECT seq, at_ms, body FROM events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT 400")
        .all(thread, reply.seq) as Array<{ seq: number; at_ms: number; body: string }>) {
        if (row.body.startsWith('{"type":"turn_started"') || row.body.startsWith('{"type":"user_message"')) break;
        if (row.body.startsWith('{"type":"turn_completed"')) {
          const body = JSON.parse(row.body);
          if (body.status === "completed") completion = { seq: row.seq, at: row.at_ms, turn: body.turn_id };
          break;
        }
      }
      if (!completion || !humanCaused(db, thread, completion.turn, completion.seq)) continue;
      for (const row of db
        .query("SELECT body FROM events WHERE thread_id = ? AND seq < ? AND body GLOB '{\"type\":\"item\",*' ORDER BY seq DESC LIMIT 50")
        .all(thread, completion.seq) as Array<{ body: string }>) {
        const body = JSON.parse(row.body);
        if (body.role?.kind === "agent" && body.turn_id === completion.turn && typeof body.text === "string") {
          answer = body.text;
          break;
        }
      }
      if (!answer?.trim()) continue;
      const context = recentContext(db, thread, completion.seq);
      const binding = db
        .query("SELECT engine_thread_id FROM engine_bindings WHERE thread_id = ? AND bound_at_ms <= ? ORDER BY bound_at_ms DESC LIMIT 1")
        .get(thread, completion.at) as { engine_thread_id: string } | null;
      found.push({
        id: `${thread.slice(0, 8)}:${completion.turn}`,
        thread,
        title,
        turn: completion.turn,
        completedAt: completion.at,
        cutoff: completion.seq,
        split: "dev",
        context,
        lastAnswer: answer,
        reference: String(message.text),
        engine: binding?.engine_thread_id,
      });
    }
    cases.push(...found.slice(-perThread));
  }
  // Held-out slice: the newest 30% of each thread's cases, never looked at while tuning.
  for (const thread of threads) {
    const own = cases.filter((c) => c.thread === thread).sort((a, b) => a.completedAt - b.completedAt);
    own.slice(Math.floor(own.length * 0.7)).forEach((c) => (c.split = "held"));
  }
  privateWrite("cases.jsonl", cases);
  const byThread = new Map<string, number>();
  for (const c of cases) byThread.set(c.title, (byThread.get(c.title) ?? 0) + 1);
  console.log(`cases: ${cases.length}`);
  for (const [title, n] of byThread) console.log(`  ${n}\t${title}`);
}

// ---- predictors ----

/** What the checkout's route shows for a fork outcome (no Haiku fallback here). */
function forkShown(outcome: ForkOutcome, safe: boolean): string | null {
  const screen = (predictions as Record<string, unknown>).screenPrediction as ((text: string) => string | null) | undefined;
  if (outcome.kind !== "suggested" || !safe) return null;
  return screen ? screen(outcome.text) : outcome.text;
}

let rollouts: Map<string, string> | undefined;
function rolloutOf(engine: string): string | undefined {
  if (!rollouts) {
    rollouts = new Map();
    const root = join(homedir(), ".local/state/today/codex-home/sessions");
    for (const path of new Bun.Glob("**/rollout-*.jsonl").scanSync(root)) {
      const id = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1];
      if (id) rollouts.set(id, join(root, path));
    }
  }
  return rollouts.get(engine);
}

/**
 * The chat's model-visible history at the turn end, rebuilt from its Codex rollout,
 * fitted to REPLAY_FORK_BUDGET tokens (default 50,000: the newest part of the chat)
 * and sent cold to the chat's model with the fork prompt. A live fork sees the whole
 * session from cache; this sees less, so its text is the comparable part, not its cost.
 */
async function runFork(c: Case): Promise<Result> {
  const started = performance.now();
  const fail = (kind: string): Result => ({ id: c.id, predictor: "fork", shown: null, kind, ms: Math.round(performance.now() - started) });
  const rollout = c.engine ? rolloutOf(c.engine) : undefined;
  if (!rollout) return fail("skip:no rollout");
  const { fitReplay, replayTokens } = await import("../src/budget");
  const { conversationRequest, prepareClaudePrompt, leadingContextCount } = await import("../src/request");
  const { buildClaudeArgs } = await import("../src/claude");
  let model: string | undefined;
  let instructions: string | undefined;
  const items: Record<string, unknown>[] = [];
  for (const line of readFileSync(rollout, "utf8").split("\n")) {
    if (!line) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (Date.parse(entry.timestamp) > c.completedAt + 1000) break;
    if (entry.type === "session_meta") instructions = entry.payload?.base_instructions?.text;
    else if (entry.type === "turn_context") model = entry.payload?.model;
    else if (entry.type === "compacted") items.length = 0;
    else if (entry.type === "response_item") items.push(entry.payload);
  }
  if (!model?.startsWith("claude-") || items.length < 2) return fail(`skip:${items.length < 2 ? "short" : `model ${model}`}`);
  const budget = Number(process.env.REPLAY_FORK_BUDGET ?? 50_000);
  const request = { model, instructions, input: items, tools: [], reasoning: { effort: "medium" } } as never;
  let fitted = fitReplay(request, budget);
  if (!fitted.fits && Array.isArray(fitted.request.input)) {
    const input = fitted.request.input;
    const lead = leadingContextCount(input);
    let from = lead;
    const cut = () => ({ ...fitted.request, input: [...input.slice(0, lead), ...input.slice(from)] });
    while (from < input.length - 2 && replayTokens(cut()) > budget) from += Math.max(1, Math.floor((input.length - from) / 20));
    fitted = { ...fitted, request: cut(), tokens: replayTokens(cut()) };
  }
  const prepared = await prepareClaudePrompt(conversationRequest(fitted.request));
  const live = process.env.PROXY_STATE_DIR;
  process.env.PROXY_STATE_DIR = join(dir, "scratch-state");
  let args: string[];
  try {
    args = buildClaudeArgs(fitted.request);
  } finally {
    if (live === undefined) delete process.env.PROXY_STATE_DIR;
    else process.env.PROXY_STATE_DIR = live;
  }
  const accounts = listAccounts();
  const account = accounts.find((a) => a.name === process.env.REPLAY_ACCOUNT) ?? accounts.find((a) => a.isDefault)!;
  const env = { ...process.env } as Record<string, string>;
  for (const key of STRIPPED_ENV) delete env[key];
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  const versions = join(homedir(), ".local/share/claude/versions");
  const bin = process.env.CLAUDE_BIN ?? join(versions, readdirSync(versions).sort().at(-1)!);
  mkdirSync(join(dir, "scratch-cwd"), { recursive: true, mode: 0o700 });
  const child = Bun.spawn([bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    cwd: join(dir, "scratch-cwd"),
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
  const raw = outcome.kind === "suggested" ? outcome.text : null;
  const safe = raw ? await guardPredictionReply(raw) : false;
  return {
    id: c.id,
    predictor: "fork",
    shown: forkShown(outcome, safe),
    raw,
    kind: outcome.kind === "failed" ? `failed:${outcome.reason}` : outcome.kind,
    ms: Math.round(performance.now() - started),
    tokens: outcome.usage as Record<string, number> | undefined,
  };
}

const scrubber = createScrubber();
async function runHaiku(c: Case, corpus: PredictionCorpus | undefined): Promise<Result> {
  // Production retrieves examples itself; here only rows older than the turn, so
  // Alex's actual reply can never be an example for its own case.
  const examples = corpus ? corpus.examples(c.context, 0, c.completedAt) : [];
  const started = performance.now();
  let tokens: Record<string, number> | undefined;
  try {
    const shown = await guardedModelPrediction(c.context, examples, AbortSignal.timeout(20000), Date.now() + 20000, undefined, undefined, (m) => {
      tokens = m.tokens as Record<string, number> | undefined;
    });
    return { id: c.id, predictor: "haiku", shown, ms: Math.round(performance.now() - started), tokens };
  } catch (error) {
    return { id: c.id, predictor: "haiku", shown: null, kind: `error:${String(error).slice(0, 60)}`, ms: Math.round(performance.now() - started) };
  }
}

async function run(predictor: string, label: string): Promise<void> {
  const split = process.env.REPLAY_SPLIT ?? "all";
  let cases = readLines<Case>("cases.jsonl").filter((c) => split === "all" || c.split === split);
  const results: Result[] = [];
  if (predictor === "fork") {
    const max = Number(process.env.REPLAY_FORK_MAX ?? 40);
    const only = process.env.REPLAY_IDS ? new Set(readFileSync(process.env.REPLAY_IDS, "utf8").split("\n").filter(Boolean)) : undefined;
    cases = cases.filter((c) => c.engine && (!only || only.has(c.id)));
    // An even sample over time, so both splits are represented.
    cases = cases.sort((a, b) => a.completedAt - b.completedAt);
    if (cases.length > max) cases = Array.from({ length: max }, (_, i) => cases[Math.floor((i * cases.length) / max)]!);
    for (const [index, c] of cases.entries()) {
      const r = await runFork(c);
      results.push(r);
      console.error(`fork ${index + 1}/${cases.length} ${r.kind} ${r.ms} ms read ${r.tokens?.cacheReadTokens} write ${r.tokens?.cacheWriteTokens}`);
    }
  } else {
    prewarmPredictionModel();
    const index = join(homedir(), ".local/state/today/composer-predictions.sqlite");
    const corpus = existsSync(index) ? new PredictionCorpus(new Database(index, { readonly: true }), (t) => scrubber.scrub(t), false) : undefined;
    for (const [i, c] of cases.entries()) {
      const r = await runHaiku(c, corpus);
      results.push(r);
      if (i % 10 === 0) console.error(`haiku ${i + 1}/${cases.length} ${r.ms} ms`);
    }
    await closePredictionModel();
  }
  closePredictionPreparation();
  privateWrite(`${label}-${predictor}.jsonl`, results);
}

// ---- scoring ----

export function summarize(cases: Case[], results: Result[]) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = results.filter((r) => byId.has(r.id));
  const shown = rows.filter((r) => r.shown);
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "–");
  const count = (f: (r: Result, c: Case) => boolean) => shown.filter((r) => f(r, byId.get(r.id)!)).length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const out = (t: Record<string, number> | undefined) => t?.outputTokens ?? 0;
  return {
    n: rows.length,
    shown: pct(shown.length, rows.length),
    exact: count((r, c) => normalize(r.shown!) === normalize(c.reference)),
    near: count((r, c) => nearMatch(r.shown!, c.reference)),
    onTopic: count((r, c) => onTopic(r.shown!, c.reference)),
    acks: count((r) => scorerBareAck(r.shown!)),
    ackShare: pct(count((r) => scorerBareAck(r.shown!)), shown.length),
    nearOfAll: pct(count((r, c) => nearMatch(r.shown!, c.reference)), rows.length),
    nearOfShown: pct(count((r, c) => nearMatch(r.shown!, c.reference)), shown.length),
    onTopicOfShown: pct(count((r, c) => onTopic(r.shown!, c.reference)), shown.length),
    p50ms: ms[Math.floor(ms.length / 2)] ?? 0,
    p90ms: ms[Math.floor(ms.length * 0.9)] ?? 0,
    meanOutTokens: rows.length ? Math.round(rows.reduce((s, r) => s + out(r.tokens), 0) / rows.length) : 0,
    meanInTokens: rows.length
      ? Math.round(rows.reduce((s, r) => s + (r.tokens?.inputTokens ?? 0) + (r.tokens?.cacheReadTokens ?? 0) + (r.tokens?.cacheWriteTokens ?? 0), 0) / rows.length)
      : 0,
  };
}

function score(labels: string[]): void {
  const cases = readLines<Case>("cases.jsonl");
  const base = (list: Case[]) => ({
    n: list.length,
    acks: list.filter((c) => scorerBareAck(c.reference)).length,
    asks: list.filter((c) => closingAsk(c.lastAnswer)).length,
    acksAfterAsks: list.filter((c) => closingAsk(c.lastAnswer) && scorerBareAck(c.reference)).length,
  });
  for (const split of ["dev", "held", "all"] as const) {
    const own = cases.filter((c) => split === "all" || c.split === split);
    const b = base(own);
    console.log(
      `\n## ${split}: ${b.n} cases; Alex's own next messages that are bare acks: ${b.acks} (${((100 * b.acks) / (b.n || 1)).toFixed(1)}%); ` +
        `turns ending on a closing ask: ${b.asks}, after which Alex sent a bare ack: ${b.acksAfterAsks}`,
    );
    console.log("| run | n | shown | exact | near | near/all | near/shown | on-topic/shown | bare acks shown | ack share of shown | p50 ms | p90 ms | in tok | out tok |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const label of labels) {
      if (!existsSync(join(dir, label))) continue;
      const s = summarize(own, readLines<Result>(label));
      console.log(
        `| ${label.replace(/\.jsonl$/, "")} | ${s.n} | ${s.shown} | ${s.exact} | ${s.near} | ${s.nearOfAll} | ${s.nearOfShown} | ${s.onTopicOfShown} | ${s.acks} | ${s.ackShare} | ${s.p50ms} | ${s.p90ms} | ${s.meanInTokens} | ${s.meanOutTokens} |`,
      );
    }
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "extract") extract();
  else if (command === "run") await run(rest[0]!, rest[1]!);
  else if (command === "score") score(rest);
  else console.error("usage: extract | run haiku|fork LABEL | score FILE...");
  process.exit(0);
}
