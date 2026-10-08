/**
 * Hygiene gate: state, decisions and HTTP routes. See hygiene.ts for the
 * rules and README "Hygiene gate" for the operator view.
 *
 * One process owns the state: this proxy. The Codex model router asks it
 * about GPT turns through POST /hygiene/gate; Claude turns are gated inline
 * in /v1/responses. Decisions for new human turns are serialized so two
 * chats cannot spend the same photo or bypass.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BYPASS_MS,
  DELAY_END_MINUTE,
  DELAY_MS,
  EXIF_FUTURE_SLACK_MS,
  EXIF_MAX_AGE_MS,
  MIN_CONFIDENCE,
  MORNING_MINUTE,
  NEAR_DUPLICATE_BITS,
  addDays,
  bypassActive,
  candidateSlots,
  classifyTurn,
  clockLabel,
  delayActive,
  delayNoteText,
  dueToday,
  emptyState,
  hasNote,
  imageMarker,
  isDelayText,
  isWithheld,
  localTime,
  lockedText,
  messageKeys,
  noteText,
  outstanding,
  partsOf,
  slotLabel,
  wantedKinds,
  zonedTime,
  type Debt,
  type GateState,
  type ImageRecord,
  type ProofKind,
} from "./hygiene";
import {
  archivePhoto,
  captureTime,
  claudeClassifier,
  decodeDataUrl,
  dhash,
  hammingDistance,
  sha256,
  type Classifier,
} from "./hygiene-proof";
import { stateDir } from "./sessions";
import type { ResponseInputItem, ResponsesRequest } from "./types";

export type GateDeps = {
  now: () => number;
  classify: Classifier;
  dhash: (bytes: Buffer) => Promise<string | null>;
  captureTime: (bytes: Buffer) => Promise<number | null>;
  /** Saves an accepted photo and returns its path. */
  archive: typeof archivePhoto;
  /** Base URL the model uses for the ruling endpoint. */
  baseUrl: string;
};

const defaults: GateDeps = {
  now: () => Date.now(),
  classify: claudeClassifier,
  dhash,
  captureTime,
  archive: archivePhoto,
  baseUrl: `http://127.0.0.1:${process.env.PORT ?? 3456}`,
};
let deps: GateDeps = { ...defaults };

/** For tests: swap the clock, classifier or hashers. */
export function setGateDeps(overrides: Partial<GateDeps>): void {
  deps = { ...defaults, ...overrides };
}

// ---- Files ----

/** Terminal escape hatch: when this file exists the gate does nothing at all. */
export function killSwitchPath(): string {
  return (
    process.env.HYGIENE_GATE_DISABLED_FILE ??
    join(import.meta.dir, "..", "hygiene-gate", "disabled")
  );
}

export const gateDisabled = () => existsSync(killSwitchPath());

export function statePath(): string {
  return process.env.HYGIENE_GATE_STATE ?? join(stateDir(), "hygiene-gate.json");
}

/** First arm for a fresh state file: the next 05:00. */
function defaultStartsAt(now: number): string {
  const { day, minutes } = localTime(now);
  const morning = zonedTime(minutes < MORNING_MINUTE ? day : addDays(day, 1), MORNING_MINUTE);
  return new Date(morning).toISOString();
}

let cache: { path: string; mtimeMs: number; state: GateState } | null = null;

/** Re-read when the file changes, so a hand edit (e.g. startsAt) applies without a restart. */
export function loadState(): GateState {
  const path = statePath();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {}
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.state;
  let state: GateState;
  if (mtimeMs < 0) state = emptyState(defaultStartsAt(deps.now()));
  else {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateState>;
    if (!raw || typeof raw !== "object") throw new Error("state file is not a JSON object");
    state = { ...emptyState(raw.startsAt ?? defaultStartsAt(deps.now())), ...raw } as GateState;
  }
  cache = { path, mtimeMs, state };
  return state;
}

const RETAIN_MS = 400 * 86_400_000;

function saveState(state: GateState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cutoff = deps.now() - RETAIN_MS;
  state.images = state.images.filter((image) => Date.parse(image.at) >= cutoff);
  state.bypass.history = state.bypass.history.filter((at) => Date.parse(at) >= cutoff);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  cache = { path, mtimeMs: statSync(path).mtimeMs, state };
}

/** For tests: forget the cached state so a new HYGIENE_GATE_STATE takes effect. */
export function resetGateCache(): void {
  cache = null;
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

// ---- Request rewriting (applied to every forwarded request) ----

function cloneItem(item: ResponseInputItem): ResponseInputItem {
  return { ...item, content: partsOf(item).map((part) => ({ ...part })) };
}

/**
 * Puts back everything the gate ever changed in this thread's history, the
 * same way every time: withheld proof photos become their marker, and each
 * hidden note returns to the message it was first attached to.
 */
export function reapply(request: ResponsesRequest, state: GateState): ResponsesRequest {
  if (!Array.isArray(request.input)) return request;
  const withheld = new Map<string, ImageRecord>();
  for (const record of state.images)
    if (isWithheld(record) && !withheld.has(record.sha256)) withheld.set(record.sha256, record);
  const thread = request.prompt_cache_key;
  const notes = thread ? state.notes.filter((n) => n.thread === thread) : [];
  if (!withheld.size && !notes.length) return request;

  let input: ResponseInputItem[] | null = null;
  const edit = (index: number) => {
    input ??= (request.input as ResponseInputItem[]).slice();
    if (input[index] === (request.input as ResponseInputItem[])[index]) input[index] = cloneItem(input[index]);
    return input[index];
  };
  const original = request.input;
  if (withheld.size) {
    original.forEach((item, index) => {
      if (item?.role !== "user") return;
      partsOf(item).forEach((part, partIndex) => {
        if (part.type !== "input_image" || typeof part.image_url !== "string") return;
        const decoded = decodeDataUrl(part.image_url);
        const record = decoded && withheld.get(sha256(decoded.bytes));
        if (!record) return;
        const target = edit(index);
        (target.content as ReturnType<typeof partsOf>)[partIndex] = {
          type: "input_text",
          text: imageMarker(record, state),
        };
      });
    });
  }
  if (notes.length) {
    const keys = messageKeys(original);
    for (const [index, key] of keys) {
      const attached = notes.filter((n) => n.key === key);
      if (!attached.length || hasNote(original[index])) continue;
      const target = edit(index);
      target.content = [...partsOf(target), ...attached.map((n) => ({ type: "input_text", text: n.text }))];
    }
  }
  return input ? { ...request, input } : request;
}

// ---- Decisions ----

export type GateDecision =
  | { action: "forward"; request: ResponsesRequest }
  | { action: "respond"; text: string };

const forward = (request: ResponsesRequest): GateDecision => ({ action: "forward", request });

type ImageOutcome = { line: string | null; record?: ImageRecord };

/** Restricts a check to one requirement type (Cairn says which proof it sends). */
export type ProofTarget = { kind: ProofKind; slot: (name: string) => boolean };

async function checkImageRecorded(
  state: GateState,
  url: string,
  source: { thread: string; key: string },
  now: number,
  only?: ProofTarget,
): Promise<ImageOutcome> {
  const before = state.images.length;
  const outcome = await checkImage(state, url, source, now, only);
  return outcome.record || state.images.length === before ? outcome : { ...outcome, record: state.images.at(-1) };
}

async function checkImage(
  state: GateState,
  url: string,
  source: { thread: string; key: string },
  now: number,
  only?: ProofTarget,
): Promise<ImageOutcome> {
  const decoded = decodeDataUrl(url);
  if (!decoded) return { line: null };
  const hash = sha256(decoded.bytes);
  // A retry or replay of the same message keeps its first verdict.
  const previous = state.images.find(
    (r) => r.sha256 === hash && r.source.thread === source.thread && r.source.key === source.key,
  );
  if (previous) return { line: null, record: previous };
  const slotsFor = (kind: ProofKind) =>
    candidateSlots(state, kind, now).filter((name) => !only || (kind === only.kind && only.slot(name)));
  const kinds = only ? (slotsFor(only.kind).length ? [only.kind] : []) : wantedKinds(state, now);
  if (!kinds.length) return { line: only ? "❌ nothing of that kind is due right now." : null };
  const record: ImageRecord = {
    sha256: hash,
    dhash: null,
    at: new Date(now).toISOString(),
    source,
    kind: null,
    verdict: "rejected",
    // Read before this photo can fill anything: was it sent to unlock the gate?
    locked: outstanding(state, now).length > 0 && !bypassActive(state, now),
  };
  // Only passed proofs count: a retake right after a rejected photo must not collide with it.
  const proofs = state.images.filter((r) => r.verdict === "accepted" || r.verdict === "unneeded");
  if (proofs.some((r) => r.sha256 === hash)) {
    state.images.push({ ...record, verdict: "duplicate", reason: "exact copy of an earlier photo" });
    return { line: "❌ photo rejected: it is a copy of an earlier proof photo." };
  }
  record.dhash = await deps.dhash(decoded.bytes);
  if (record.dhash) {
    const near = proofs.find(
      (r) => r.dhash && hammingDistance(r.dhash, record.dhash!) <= NEAR_DUPLICATE_BITS,
    );
    if (near) {
      state.images.push({ ...record, verdict: "duplicate", reason: "near-copy of an earlier photo" });
      return { line: "❌ photo rejected: it is a near-copy of an earlier proof photo." };
    }
  }
  const taken = await deps.captureTime(decoded.bytes);
  if (taken !== null && (now - taken > EXIF_MAX_AGE_MS || taken - now > EXIF_FUTURE_SLACK_MS)) {
    const minutes = Math.round((now - taken) / 60_000);
    state.images.push({ ...record, verdict: "stale", reason: `taken ${minutes} min before sending` });
    return { line: `❌ photo rejected: its camera timestamp is ${minutes} minutes old (limit 30).` };
  }
  const penance = state.debts.find((d) => d.status === "penance" && d.penance && !d.penance.paidAt);
  let verdict;
  try {
    verdict = await deps.classify(decoded, {
      kinds,
      penance: kinds.includes("penance") ? penance?.penance?.description : undefined,
    });
  } catch (error) {
    // Not recorded: the same photo can be retried once the checker works.
    console.error("hygiene-gate: classifier failed:", (error as Error).message);
    return { line: "⚠️ couldn't check the photo (classifier error). Send it again, or reply BYPASS." };
  }
  record.kind = verdict.kind;
  record.reason = verdict.reason;
  if (verdict.kind === "none" || !kinds.includes(verdict.kind as ProofKind)) {
    state.images.push(record);
    return {
      line:
        verdict.kind === "none"
          ? `❌ photo not accepted: ${verdict.reason || "no hygiene proof visible"}`
          : `❌ photo looks like ${verdict.kind}, which isn't due right now.`,
    };
  }
  if (verdict.confidence < MIN_CONFIDENCE) {
    state.images.push(record);
    return { line: `❌ photo not clear enough to accept: ${verdict.reason || "low confidence"}` };
  }
  const target = slotsFor(verdict.kind as ProofKind)[0];
  if (!target) {
    state.images.push({ ...record, verdict: "unneeded" });
    return { line: null };
  }
  state.filled[target] = record.at;
  if (target.startsWith("penance/")) {
    const debt = state.debts.find((d) => `penance/${d.id}` === target);
    if (debt?.penance) {
      debt.penance.paidAt = record.at;
      debt.status = "paid";
    }
  }
  let file: string | undefined;
  try {
    file = deps.archive(decoded, verdict.kind, now, hash);
  } catch (error) {
    // The proof still counts; only the keepsake copy is missing.
    console.error("hygiene-gate: could not save the photo:", (error as Error).message);
  }
  state.images.push({ ...record, verdict: "accepted", slot: target, ...(file ? { file } : {}) });
  return { line: `✅ ${slotLabel(target, state)} photo accepted.` };
}

function bypassReply(state: GateState, now: number): string {
  if (bypassActive(state, now))
    return `🚪 bypass already open until ${clockLabel(Date.parse(state.bypass.until!))}.`;
  const due = outstanding(state, now);
  if (!due.length) return "✅ gate is already clear; no bypass used.";
  const at = new Date(now).toISOString();
  state.bypass.count += 1;
  state.bypass.until = new Date(now + BYPASS_MS).toISOString();
  state.bypass.history.push(at);
  const debt: Debt = {
    id: `${localTime(now).day}-${state.bypass.count}`,
    at,
    skipped: due.map((r) => r.label),
    status: "open",
  };
  state.debts.push(debt);
  return `🚪 bypass #${state.bypass.count}: gate open until ${clockLabel(now + BYPASS_MS)}. Your next turn will ask why.`;
}

function delayReply(state: GateState, now: number): string {
  const { day, minutes } = localTime(now);
  const due = outstanding(state, now);
  const morningOnly = due.length === 1 && due[0].slot === `${day}/morning-teeth`;
  if (delayActive(state, now))
    return `⏰ delay already open until ${clockLabel(Date.parse(state.delay.until!))}. Send the teeth photo when you can.`;
  if (!due.length) return "✅ gate is already clear; no delay used.";
  if (!morningOnly || minutes < MORNING_MINUTE || minutes >= DELAY_END_MINUTE)
    return "DELAY only postpones the morning teeth photo (05:00 to 12:00). For anything else, send the photo or reply BYPASS.";
  if (state.delay.history.includes(day))
    return "DELAY was already used this morning. Send the teeth photo, or reply BYPASS.";
  state.delay.count += 1;
  state.delay.until = new Date(now + DELAY_MS).toISOString();
  state.delay.day = day;
  state.delay.history.push(day);
  return `⏰ delay: gate open until ${clockLabel(now + DELAY_MS)}. Send the teeth photo before then.`;
}

/**
 * The gate's answer for one Responses request. Never throws: a bug here must
 * not take down inference, so failures forward the request untouched.
 */
export async function gateRequest(request: ResponsesRequest): Promise<GateDecision> {
  if (gateDisabled()) return forward(request);
  try {
    const state = loadState();
    const turn = classifyTurn(request, state.extraGatedTriggers);
    if (turn.type !== "human") return forward(reapply(request, state));
    return await serialized(() => decideHumanTurn(request, turn));
  } catch (error) {
    console.error("hygiene-gate: failed open:", (error as Error).message);
    return forward(request);
  }
}

async function decideHumanTurn(
  request: ResponsesRequest,
  turn: Extract<ReturnType<typeof classifyTurn>, { type: "human" }>,
): Promise<GateDecision> {
  const state = structuredClone(loadState());
  const now = deps.now();
  const input = request.input as ResponseInputItem[];
  const thread = request.prompt_cache_key ?? "";
  const keys = messageKeys(input);
  let dirty = false;

  if (turn.text === "BYPASS" && !turn.images.length) {
    const text = bypassReply(state, now);
    saveState(state);
    return { action: "respond", text };
  }
  if (isDelayText(turn.text) && !turn.images.length) {
    const text = delayReply(state, now);
    saveState(state);
    return { action: "respond", text };
  }

  const lines: string[] = [];
  for (const image of turn.images) {
    const before = state.images.length;
    const outcome = await checkImageRecorded(state, image.url, { thread, key: keys.get(image.item) ?? "" }, now);
    if (outcome.line) lines.push(outcome.line);
    if (state.images.length !== before) dirty = true;
  }

  const due = outstanding(state, now);
  if (due.length && !bypassActive(state, now)) {
    if (dirty) saveState(state);
    return { action: "respond", text: lockedText(due, lines) };
  }

  // Let the turn through, once per thread telling the model about open debts.
  const newestKey = keys.get(turn.newest);
  if (newestKey && thread) {
    const noted = (id: string) => state.notes.some((n) => n.thread === thread && n.key === newestKey && n.debtId === id);
    if (delayActive(state, now) && !noted(`delay:${state.delay.day}`)) {
      state.notes.push({
        thread,
        key: newestKey,
        debtId: `delay:${state.delay.day}`,
        text: delayNoteText(Date.parse(state.delay.until!)),
      });
      dirty = true;
    }
    for (const debt of state.debts.filter((d) => d.status === "open")) {
      if (state.notes.some((n) => n.thread === thread && n.debtId === debt.id)) continue;
      if (Date.parse(debt.at) >= now) continue;
      state.notes.push({ thread, key: newestKey, debtId: debt.id, text: noteText(debt, deps.baseUrl) });
      dirty = true;
    }
  }
  if (dirty) saveState(state);
  return forward(reapply(request, state));
}

// ---- Status and ruling ----

export function gateStatus() {
  const now = deps.now();
  const disabled = gateDisabled();
  const state = loadState();
  const due = outstanding(state, now);
  const bypass = bypassActive(state, now);
  return {
    enabled: !disabled,
    armed: !disabled && due.length > 0 && !bypass,
    state: disabled ? "disabled" : due.length === 0 ? "clear" : bypass ? "bypassed" : "armed",
    now: new Date(now).toISOString(),
    startsAt: state.startsAt,
    outstanding: due.map(({ slot, kind, label }) => ({ slot, kind, label })),
    dueToday: dueToday(state, now).map(({ slot, kind, label }) => ({ slot, kind, label })),
    bypass: { count: state.bypass.count, activeUntil: bypass ? state.bypass.until : null },
    delay: {
      active: delayActive(state, now),
      expires_at: delayActive(state, now) ? state.delay.until : null,
      count: state.delay.count,
    },
    openDebts: state.debts
      .filter((d) => d.status === "open" || d.status === "penance")
      .map(({ id, at, skipped, status, penance }) => ({ id, at, skipped, status, penance })),
    lastProofs: state.images
      .filter((r) => r.verdict === "accepted")
      .slice(-5)
      .map(({ at, kind, slot }) => ({ at, kind, slot })),
    killSwitch: killSwitchPath(),
  };
}

export async function resolveDebt(
  id: string,
  body: { verdict?: unknown; reason?: unknown; penance?: unknown },
): Promise<{ status: number; body: unknown }> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const debt = state.debts.find((d) => d.id === id);
    if (!debt) return { status: 404, body: { error: "no such debt" } };
    if (debt.status !== "open") return { status: 409, body: { error: `debt already ${debt.status}` } };
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
    const now = new Date(deps.now()).toISOString();
    if (body.verdict === "justified") {
      Object.assign(debt, { status: "justified", reason, ruledAt: now });
    } else if (body.verdict === "unjustified") {
      const penance = typeof body.penance === "string" ? body.penance.trim() : "";
      if (!penance || penance.length > 200)
        return { status: 400, body: { error: "unjustified needs a penance description (1-200 chars)" } };
      Object.assign(debt, { status: "penance", reason, ruledAt: now, penance: { description: penance, setAt: now } });
    } else return { status: 400, body: { error: 'verdict must be "justified" or "unjustified"' } };
    saveState(state);
    return { status: 200, body: { ok: true, debt } };
  });
}

/** /hygiene/* routes. Returns null for paths that are not ours. */
export async function handleHygieneRoute(request: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/hygiene/")) return null;
  if (url.pathname === "/hygiene/status" && request.method === "GET") return Response.json(gateStatus());
  const ruling = /^\/hygiene\/debt\/([A-Za-z0-9-]+)\/resolve$/.exec(url.pathname);
  if (ruling && request.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    const result = await resolveDebt(ruling[1], body);
    return Response.json(result.body, { status: result.status });
  }
  return null;
}

// ---- Direct submissions (Cairn) ----

export type SubmitResult = {
  result: "pass" | "fail";
  /** One line for the UI, same wording the chat lock uses. */
  message: string;
  verdict: ImageRecord["verdict"] | "not_due" | "error";
  slot: string | null;
  sha256: string;
};

/**
 * Runs the chat checks (reuse, EXIF age, classifier) on a photo sent outside
 * a chat. Resending the same bytes returns the first verdict.
 */
export async function submitProof(image: { mediaType: string; bytes: Buffer }, target: ProofTarget): Promise<SubmitResult> {
  return serialized(async () => {
    const state = structuredClone(loadState());
    const now = deps.now();
    const hash = sha256(image.bytes);
    const url = `data:${image.mediaType};base64,${image.bytes.toString("base64")}`;
    const outcome = await checkImageRecorded(state, url, { thread: "cairn", key: hash }, now, target);
    if (JSON.stringify(state) !== JSON.stringify(loadState())) saveState(state);
    const record = outcome.record;
    const pass = record?.verdict === "accepted";
    return {
      result: pass ? "pass" : "fail",
      message: outcome.line ?? (record ? imageMarker(record, state) : "❌ photo could not be read."),
      verdict: record?.verdict ?? (outcome.line?.startsWith("⚠") ? "error" : "not_due"),
      slot: record?.slot ?? null,
      sha256: hash,
    };
  });
}

/** Accepted proofs grouped by local day, newest day first. */
export function proofDays(from: string, to: string) {
  const days = new Map<string, Array<{ sha256: string; kind: string; slot: string; at: string; manual: boolean }>>();
  for (const r of loadState().images) {
    if (r.verdict !== "accepted" || !r.slot || !r.file) continue;
    const day = localTime(Date.parse(r.at)).day;
    if (day < from || day > to) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push({ sha256: r.sha256, kind: r.kind ?? "", slot: r.slot, at: r.at, manual: !!r.manual });
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, photos]) => ({ day, photos }));
}

export function proofFile(hash: string): string | null {
  const record = loadState().images.find((r) => r.sha256 === hash && r.verdict === "accepted" && r.file);
  return record?.file ?? null;
}
