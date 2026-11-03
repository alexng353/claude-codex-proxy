/**
 * Client for the gate's gym routes (hygiene-gate.ts), shared by the CLI
 * (scripts/gym.ts) and the MCP server (gym-mcp.ts). Talks to the local proxy,
 * which forwards to the gate's authority when it is a follower.
 */
import { zonedTime } from "./hygiene";

export function proxyBase(): string {
  return (process.env.GYM_PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3456}`).replace(/\/+$/, "");
}

/**
 * A start time: "YYYY-MM-DD HH:MM" (or with a T) is Vancouver wall time; an ISO
 * time with Z or an offset is taken as is. Returns ISO, or null.
 */
export function parseStart(text: string): string | null {
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (local) {
    const [h, m] = [Number(local[2]), Number(local[3])];
    if (h > 23 || m > 59) return null;
    return new Date(zonedTime(local[1], h * 60 + m)).toISOString();
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text.trim())) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function gymCall(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const key = process.env.PROXY_API_KEY;
  const reply = await fetch(`${proxyBase()}/hygiene/gym${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await reply.text();
  try {
    return { status: reply.status, body: JSON.parse(text) };
  } catch {
    return { status: reply.status, body: { error: text.slice(0, 300) } };
  }
}

/** A plan or report as short lines for a person or a model to read. */
export function describeReport(report: any): string {
  const lines: string[] = [];
  lines.push(
    `Uplifting: ${report.syncError ? `error (${report.syncError})` : report.syncedAt ? `read ${report.syncedAt}` : "never read"}${report.token ? "" : ", no token configured"}`,
  );
  lines.push(`Defaults: grace ${report.settings.graceMin} min, at least ${report.settings.minMinutes} min and ${report.settings.minSets} sets, within ${report.settings.gym.radiusM} m of ${report.settings.gym.name}`);
  if (report.settings.proof === "workout-tag")
    lines.push(`Proof: a synced Uplifting workout tagged with a gym containing "${report.settings.tagPattern}" (no check-ins needed)`);
  for (const p of report.pauses ?? [])
    if (Date.parse(p.to) > Date.parse(report.now)) lines.push(`Paused ${p.from} to ${p.to}: ${p.reason} (${p.id})`);
  // Plans cancelled before their start no longer matter; a late cancel shows as missed.
  const plans = (report.plans ?? []).filter((p: any) => p.status !== "cancelled");
  if (!plans.length) lines.push("No plans.");
  for (const p of plans)
    lines.push(
      `${p.id}: ${p.startLabel} (${p.status}${p.reason ? `: ${p.reason}` : ""}; start by ${p.deadlineLabel})${p.note ? ` - ${p.note}` : ""}`,
    );
  return lines.join("\n");
}
