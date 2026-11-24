/**
 * Hygiene tools for the gym MCP server (gym-mcp.ts): read the gate, and excuse
 * (skip) or un-excuse one day's photo requirement when an agent judges Alex's
 * reason sound. Served by the already registered `gym` server, so no Codex
 * config change is needed.
 *
 * Bedtime approval/denial is restricted to Bubble's stamped calling chat and
 * reaches separate local routes, never the Cairn API. Other tools cannot mint
 * a bypass or read its words. Status is rebuilt from an allowlist of fields.
 *
 * `by` is the calling chat: Codex stamps `_meta.threadId` on every tools/call,
 * over anything a model writes (the model controls only `arguments`). Codex
 * spawns this process per thread with no thread id in its environment, so the
 * per-call stamp is the only identity there is. Without one, `by` says so.
 */
import { summarizeScreenTime } from "./hygiene-screen-time";
import { BEDTIME_OWNER } from "./hygiene-bedtime";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { proxyBase } from "./gym-client";
import { RECURRING_ITEMS } from "./hygiene";
import { dayKey, wallTime } from "./zone";

const ITEMS = RECURRING_ITEMS as readonly string[];
const DAY_TARGET = /^(\d{4}-\d{2}-\d{2})\/([a-z-]+)$/;

/** The only gate routes these tools may reach. */
export const ROUTES = {
  status: { method: "GET", path: "/hygiene/status" },
  skip: { method: "POST", path: "/hygiene/skip" },
  unskip: { method: "POST", path: "/hygiene/unskip" },
  bedtimeApprove: { method: "POST", path: "/hygiene/bedtime/approve" },
  bedtimeDeny: { method: "POST", path: "/hygiene/bedtime/deny" },
} as const;
export type Route = keyof typeof ROUTES;

const TARGET_PROPS = {
  target: { type: "string", description: `"YYYY-MM-DD/<item>" for a given gate-local day. Give target or item, not both.` },
  item: { type: "string", enum: [...RECURRING_ITEMS], description: "An item for today (the gate's local day, in the phone's zone)." },
} as const;

export const HYGIENE_TOOLS = [
  ...["approve", "deny"].map(action => ({
    name: `bedtime_unlock_${action}`,
    description: `Bubble only: ${action} a pending Cairn bedtime permission request by id. Approval grants 15 minutes from now and is logged as a bypass with an open debt; denial grants nothing. Requests expire after 15 minutes.`,
    inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string", description: "Your reason for this decision." } }, required: ["id", "reason"], additionalProperties: false },
  })),
  {
    name: "hygiene_status",
    description:
      "Alex's hygiene gate today: its state, each photo item's status (outstanding, due later, excused, paused, credited or not due), what locks now, skips, the bypass count and how many debts are open. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hygiene_skip",
    description:
      "Excuse one day's photo requirement so it never locks the gate. Use it only when you judge Alex's reason sound (sick, injured, an emergency, no shower where he is), the same standard as a justified BYPASS ruling; a later time today is Cairn's Move, not a skip. Logged with your chat and reason, and shown in gate status. Gym plans: gym_plan_skip.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        reason: { type: "string", description: "Why, in one line, e.g. 'Alex has a fever, no shower tonight'." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "hygiene_unskip",
    description: "Undo a skip made by mistake: the requirement is due again.",
    inputSchema: {
      type: "object",
      properties: { ...TARGET_PROPS, reason: { type: "string", description: "Optional, logged only." } },
      additionalProperties: false,
    },
  },
] as const;

export const HYGIENE_TOOL_NAMES: readonly string[] = HYGIENE_TOOLS.map((t) => t.name);

type Reply = { status: number; body: any };
export type Fetcher = (route: Route, body?: Record<string, unknown>) => Promise<Reply>;

/** Talks to the local proxy exactly like gymCall: loopback, PROXY_API_KEY when set. */
export const gateFetch: Fetcher = async (route, body) => {
  const { method, path } = ROUTES[route];
  const key = process.env.PROXY_API_KEY;
  const reply = await fetch(`${proxyBase()}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await reply.text();
  try {
    return { status: reply.status, body: JSON.parse(text) };
  } catch {
    return { status: reply.status, body: { error: text.slice(0, 300) } };
  }
};

let fetcher: Fetcher = gateFetch;
/** For tests. */
export function setHygieneFetcher(next: Fetcher = gateFetch): void {
  fetcher = next;
}

/** The calling chat as Codex stamped it on this call, or null. */
export function callingChat(meta: unknown): string | null {
  const id = (meta as { threadId?: unknown } | null | undefined)?.threadId;
  if (typeof id !== "string") return null;
  const t = id.trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(t) ? t : null;
}

/** What the gate records as `by`: the chat when Codex stamped one, else a label marked unattributed. */
export function byLabel(chat: string | null): string {
  return chat ? `chat:${chat}` : `${(process.env.GYM_BY || "mcp").slice(0, 60)} (unattributed)`;
}

export function logPath(): string {
  const dir =
    process.env.PROXY_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "claude-codex-proxy");
  return join(dir, "hygiene-mcp.jsonl");
}

function log(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    mkdirSync(dirname(logPath()), { recursive: true });
    appendFileSync(logPath(), `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`hygiene-mcp: log write failed: ${(error as Error).message}`);
  }
  // Codex keeps MCP stderr in its own log.
  console.error(`hygiene-mcp: ${line}`);
}

/** The gate's local day now, from its own status (`now` and `zone`), never this process's clock zone. */
export function gateDay(status: any): string | null {
  const ms = Date.parse(status?.now);
  if (!Number.isFinite(ms) || typeof status?.zone !== "string") return null;
  return dayKey(ms, status.zone);
}

type Item = { item: string; status: string; at?: string; by?: string; reason?: string; label?: string };

const slotItem = (slot: string) => slot.split("/")[1]?.replace(/-walk-start$/, "-walk") ?? slot;
const slotDay = (slot: string) => slot.split("/")[0];
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Today's view, rebuilt from allowlisted fields only. */
export function summarize(status: any) {
  const day = gateDay(status) ?? "unknown";
  const outstanding = list(status?.outstanding);
  const dueToday = list(status?.dueToday);
  const skips = list(status?.skips);
  const proofs = list(status?.lastProofs);
  const cancellations = status?.cancellations && typeof status.cancellations === "object" ? status.cancellations : {};
  const suspensions = list(status?.suspensions);
  const onDay = (r: any, item: string) => typeof r?.slot === "string" && slotDay(r.slot) === day && slotItem(r.slot) === item;
  const items: Item[] = ITEMS.map((item) => {
    const skip = skips.find((s) => s?.day === day && s?.item === item);
    if (skip) return { item, status: "excused", at: str(skip.at), by: str(skip.by), reason: str(skip.reason) };
    if (cancellations[item] || suspensions.some((s) => s?.item === item)) return { item, status: "paused" };
    const now = outstanding.find((r) => onDay(r, item));
    if (now) return { item, status: "outstanding", label: str(now.label) };
    const later = dueToday.find((r) => onDay(r, item));
    if (later) return { item, status: "due later", label: str(later.label) };
    // lastProofs keeps the newest five accepted photos, so an older credit reads as "not due".
    const proof = [...proofs].reverse().find((p) => onDay(p, item));
    if (proof) return { item, status: "credited", at: str(proof.at) };
    return { item, status: "not due" };
  });
  const labels = (rs: any[]) => rs.map((r) => `${str(r?.label) ?? "?"} [${str(r?.slot) ?? "?"}]`);
  return {
    screen_time: summarizeScreenTime(status?.screen_time),
    day,
    zone: str(status?.zone) ?? null,
    now: str(status?.now) ?? null,
    state: str(status?.state) ?? "unknown",
    items,
    locksNow: labels(outstanding),
    dueLater: labels(dueToday),
    skips: skips.map((s) => ({ target: str(s?.target), by: str(s?.by), reason: str(s?.reason), at: str(s?.at) })),
    bypassCount: typeof status?.bypass?.count === "number" ? status.bypass.count : null,
    openDebts: Array.isArray(status?.openDebts) ? status.openDebts.length : null,
  };
}

export function describeSummary(s: ReturnType<typeof summarize>): string {
  let clock = "";
  const ms = s.now ? Date.parse(s.now) : NaN;
  if (Number.isFinite(ms) && s.zone) {
    const w = wallTime(ms, s.zone);
    clock = ` ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  }
  const lines = [`Gate ${s.state}; ${s.day}${clock} ${s.zone ?? ""}`.trimEnd()];
  for (const i of s.items)
    lines.push(
      `${i.item}: ${i.status}${i.label ? ` (${i.label})` : ""}${i.by ? ` by ${i.by}` : ""}${i.reason ? `: ${i.reason}` : ""}${i.status === "credited" && i.at ? ` at ${i.at}` : ""}`,
    );
  lines.push(`Locks now: ${s.locksNow.length ? s.locksNow.join("; ") : "nothing"}`);
  if (s.dueLater.length) lines.push(`Due later today: ${s.dueLater.join("; ")}`);
  lines.push(`Bypasses: ${s.bypassCount ?? "?"}; open debts: ${s.openDebts ?? "?"}`);
  if (s.screen_time) {
    const t = s.screen_time;
    lines.push(`Screen Time ${t.stale ? "stale" : "current"}; device ${t.device_id}; build ${JSON.stringify(t.build)}; received ${t.received_at}; authorization ${t.authorization}; zone ${t.time_zone}; bedtime ${t.bedtime_enabled}; late/full/wake minutes ${t.late_start_minute}/${t.full_start_minute}/${t.wake_minute}; late app/category/web counts ${t.late_app_count}/${t.late_category_count}/${t.late_web_count}; allowlist app/category/web counts ${t.allowlist_app_count}/${t.allowlist_category_count}/${t.allowlist_web_count}; scheduled ${t.scheduled_at ?? "never"}; adult filter enabled ${t.adult_filter_enabled}, applied ${t.adult_filter_applied}; phone-reported unlock ${t.adult_filter_unlock_until ?? "none"}.`);
  }
  return lines.join("\n");
}

type Result = { text: string; isError: boolean; structuredContent?: Record<string, unknown> };

async function resolveTarget(args: Record<string, unknown>): Promise<{ target: string } | { error: string }> {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const item = typeof args.item === "string" ? args.item.trim() : "";
  if (target && item) return { error: "give target or item, not both" };
  if (target) {
    const m = DAY_TARGET.exec(target);
    if (!m || !ITEMS.includes(m[2]))
      return { error: `target must be YYYY-MM-DD/<item> with item one of ${ITEMS.join(", ")} (gym plans: gym_plan_skip)` };
    return { target };
  }
  if (!item) return { error: "give target or item" };
  if (!ITEMS.includes(item)) return { error: `item must be one of ${ITEMS.join(", ")}` };
  const status = await fetcher("status");
  if (status.status >= 400) return { error: status.body?.error ?? `gate status failed (${status.status})` };
  const day = gateDay(status.body);
  if (!day) return { error: "the gate did not report its local day" };
  return { target: `${day}/${item}` };
}

export async function callHygieneTool(name: string, args: Record<string, unknown>, meta?: unknown): Promise<Result> {
  const chat = callingChat(meta);
  const by = byLabel(chat);
  const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 300) : "";
  // The target once known, so a call that throws is still logged with it.
  let target: string | undefined;
  const done = (r: Result, extra: Record<string, unknown> = {}) => {
    log({
      tool: name, chat, by, ...(target ? { target } : {}), ...(reason ? { reason: reason.slice(0, 120) } : {}), ...extra,
      ok: !r.isError, ...(r.isError ? { error: r.text.slice(0, 200) } : {}),
    });
    return r;
  };
  try {
    switch (name) {
      case "bedtime_unlock_approve":
      case "bedtime_unlock_deny": {
        if (chat !== BEDTIME_OWNER) return done({ text: "only Bubble may decide a bedtime request", isError: true });
        if (typeof args.id !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(args.id) || !reason)
          return done({ text: "id and reason are required", isError: true });
        target = args.id;
        const r = await fetcher(name === "bedtime_unlock_approve" ? "bedtimeApprove" : "bedtimeDeny", { id: target, reason, by });
        if (r.status >= 400 || r.body?.ok === false) return done({ text: r.body?.error ?? `failed (${r.status})`, isError: true });
        return done({ text: r.body?.message ?? "done", isError: false });
      }
      case "hygiene_status": {
        const r = await fetcher("status");
        if (r.status >= 400) return done({ text: r.body?.error ?? `failed (${r.status})`, isError: true });
        const s = summarize(r.body);
        return done({ text: describeSummary(s), isError: false, structuredContent: s });
      }
      case "hygiene_skip":
      case "hygiene_unskip": {
        const undo = name === "hygiene_unskip";
        // Refused before any gate call: a skip is a judgement, and its reason is the record.
        if (!undo && !reason) return done({ text: "a skip needs a reason", isError: true });
        const resolved = await resolveTarget(args);
        if ("error" in resolved) return done({ text: resolved.error, isError: true });
        target = resolved.target;
        const r = await fetcher(undo ? "unskip" : "skip", { target, by, ...(reason ? { reason } : {}) });
        if (r.status >= 400 || r.body?.ok === false)
          return done({ text: r.body?.error ?? `failed (${r.status})`, isError: true }, { status: r.status });
        return done({ text: `${r.body?.message ?? "done"} (gate ${r.body?.gate?.state ?? "?"})`, isError: false }, { status: r.status });
      }
      default:
        return done({ text: `unknown tool ${name}`, isError: true });
    }
  } catch (error) {
    // Refused, timed out: still one audit line with the calling chat (message only, no stack).
    return done({ text: `gate unreachable: ${String((error as Error)?.message ?? error).slice(0, 180)}`, isError: true });
  }
}
