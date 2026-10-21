/**
 * One hygiene gate for every machine. Today on Forge and Codex Desktop on arch
 * each run a proxy; with two gate states, proofs sent to arch never reached
 * Forge, and Forge's gate locked Today all afternoon (Oct 21). Forge's gate is
 * the authority. A proxy with HYGIENE_GATE_REMOTE set (arch: an SSH tunnel to
 * Forge's 127.0.0.1:3456) keeps no gate of its own: it asks Forge about every
 * turn and passes the /hygiene routes and Cairn's hygiene API through.
 *
 * Forge unreachable means turns go through untouched, as a local gate failure
 * does: a gate outage must never stop Alex's chats.
 */
import type { GateState } from "./hygiene";
import type { GateDecision } from "./hygiene-gate";
import type { ResponsesRequest } from "./types";

/** Asks /hygiene/gate for the decision only, without the skill preload. */
export const GATE_ONLY_HEADER = "x-hygiene-gate-only";

const DECISION_TIMEOUT_MS = 60_000;
/** A proof is classified by a model before the answer comes back. */
const PASS_THROUGH_TIMEOUT_MS = 180_000;
const STATE_TTL_MS = 30_000;

/** The authority's base URL, or null when this proxy is the gate. */
export function remoteGate(): string | null {
  const url = process.env.HYGIENE_GATE_REMOTE?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** The authority's decision for one Responses request; forwards untouched if it can't answer. */
export async function remoteGateRequest(base: string, request: ResponsesRequest): Promise<GateDecision> {
  try {
    const reply = await fetch(`${base}/hygiene/gate`, {
      method: "POST",
      headers: { "content-type": "application/json", [GATE_ONLY_HEADER]: "1" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!reply.ok) throw new Error(`answered ${reply.status}`);
    const body = (await reply.json()) as { action?: string; text?: unknown; request?: unknown };
    if (body.action === "respond" && typeof body.text === "string") return { action: "respond", text: body.text };
    if (body.action === "forward")
      return { action: "forward", request: (body.request as ResponsesRequest | undefined) ?? request };
    throw new Error("unexpected answer");
  } catch (error) {
    console.error("hygiene-gate: remote gate failed open:", (error as Error).message);
    return { action: "forward", request };
  }
}

/**
 * The same request, sent to the authority: method, path, query, body and the
 * caller's bearer token (Cairn's API checks it there). Never proxy-hop headers:
 * the authority must see a local caller, as the tunnel makes it one.
 */
export async function passThrough(base: string, request: Request, url: URL): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const reply = await fetch(`${base}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      signal: AbortSignal.timeout(PASS_THROUGH_TIMEOUT_MS),
    });
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": reply.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return Response.json({ error: `hygiene gate unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}

let remoteState: { state: GateState | null; at: number; pending: boolean } = { state: null, at: 0, pending: false };

/**
 * The authority's state for readers that can't wait (plate activity): the last
 * copy fetched, refreshed in the background every 30 s. Null until the first
 * fetch lands.
 */
export function cachedRemoteState(base: string, now = Date.now()): GateState | null {
  if (!remoteState.pending && now - remoteState.at >= STATE_TTL_MS) {
    remoteState.pending = true;
    void fetch(`${base}/hygiene/state`, { signal: AbortSignal.timeout(10_000) })
      .then(async (reply) => {
        if (!reply.ok) throw new Error(`answered ${reply.status}`);
        remoteState = { state: (await reply.json()) as GateState, at: Date.now(), pending: false };
      })
      .catch((error) => {
        console.error("hygiene-gate: remote state unavailable:", (error as Error).message);
        remoteState = { ...remoteState, at: Date.now(), pending: false };
      });
  }
  return remoteState.state;
}

/** For tests. */
export function resetRemoteState(): void {
  remoteState = { state: null, at: 0, pending: false };
}
