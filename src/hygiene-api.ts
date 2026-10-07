/**
 * Hygiene API for Cairn: submit a proof photo, read status, list and fetch
 * the daily photos. Contract: docs/hygiene-api.md.
 *
 * Auth is the Cairn relay's own: the caller's bearer token is checked with
 * the relay's GET /v1/whoami, so the proxy holds no Cairn secret. Phone,
 * admin and plate devices are allowed; agent devices are not, so no agent
 * can submit proofs. Results are cached by token hash for five minutes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { addDays, localTime, type ProofKind } from "./hygiene";
import { gateDisabled, gateStatus, proofDays, proofFile, submitProof, type ProofTarget } from "./hygiene-gate";

export const API_PREFIX = "/hygiene/api/v1";

const ALLOWED_ROLES = new Set(["phone", "admin", "plate"]);
const AUTH_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type Device = { id: string; name: string; role: string };
export type Authenticator = (token: string) => Promise<Device | null>;

function relayUrls(): string[] {
  const configured = process.env.HYGIENE_CAIRN_RELAYS;
  if (configured) return configured.split(",").map((u) => u.trim()).filter(Boolean);
  return ["https://truenas-scale.taildf19.ts.net:8787", "https://cairn.alexng.dev"];
}

/** Asks the relay who owns this token. Null for unknown or revoked tokens. */
export const relayAuthenticator: Authenticator = async (token) => {
  let lastError: unknown;
  for (const base of relayUrls()) {
    try {
      const reply = await fetch(new URL("/v1/whoami", base), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (reply.status === 401 || reply.status === 403) return null;
      if (!reply.ok) throw new Error(`relay answered ${reply.status}`);
      const body = (await reply.json()) as { device?: Device };
      return body.device ?? null;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no relay configured");
};

let authenticate: Authenticator = relayAuthenticator;
const authCache = new Map<string, { device: Device | null; until: number }>();

/** For tests. */
export function setAuthenticator(next: Authenticator = relayAuthenticator): void {
  authenticate = next;
  authCache.clear();
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function device(request: Request): Promise<Device | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const key = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  let cached = authCache.get(key);
  if (!cached || cached.until <= now) {
    try {
      cached = { device: await authenticate(token), until: now + AUTH_TTL_MS };
    } catch {
      return json({ error: "relay unreachable; cannot check the token" }, 503);
    }
    // Unknown tokens are not cached, so a newly added device works at once.
    if (cached.device) authCache.set(key, cached);
  }
  if (!cached.device) return json({ error: "unauthorized" }, 401);
  if (!ALLOWED_ROLES.has(cached.device.role)) return json({ error: "forbidden for this device role" }, 403);
  return cached.device;
}

const TARGETS: Record<string, ProofTarget> = {
  shower: { kind: "shower" as ProofKind, slot: (s) => s.endsWith("/shower") },
  teeth_night: { kind: "teeth" as ProofKind, slot: (s) => s.endsWith("/night-teeth") },
  teeth_morning: { kind: "teeth" as ProofKind, slot: (s) => s.endsWith("/morning-teeth") },
};

function decodeImage(body: { image?: unknown; media_type?: unknown }): { mediaType: string; bytes: Buffer } | null {
  if (typeof body.image !== "string" || !body.image) return null;
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(body.image);
  const mediaType = dataUrl?.[1] ?? (typeof body.media_type === "string" ? body.media_type : "image/jpeg");
  if (!/^image\/[a-zA-Z0-9.+-]+$/.test(mediaType)) return null;
  const bytes = Buffer.from(dataUrl?.[2] ?? body.image, "base64");
  return bytes.length ? { mediaType, bytes } : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function status() {
  const s = gateStatus();
  return {
    enabled: s.enabled,
    state: s.state,
    now: s.now,
    today: localTime(Date.parse(s.now)).day,
    outstanding: s.outstanding,
    due_today: s.dueToday,
    bypass: { count: s.bypass.count, active_until: s.bypass.activeUntil },
    delay: s.delay,
    open_debts: s.openDebts,
  };
}

/** Routes under /hygiene/api/v1. Null for other paths. */
export async function handleHygieneApi(request: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  const who = await device(request);
  if (who instanceof Response) return who;
  const path = url.pathname.slice(API_PREFIX.length);

  if (path === "/status" && request.method === "GET") return json(status());

  if (path === "/proofs" && request.method === "POST") {
    if (gateDisabled()) return json({ error: "hygiene gate is disabled" }, 503);
    let body: { kind?: unknown; image?: unknown; media_type?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const target = typeof body.kind === "string" ? TARGETS[body.kind] : undefined;
    if (!target) return json({ error: "kind must be shower, teeth_night or teeth_morning" }, 400);
    const image = decodeImage(body);
    if (!image) return json({ error: "image must be base64 or a data: URL" }, 400);
    if (image.bytes.length > MAX_IMAGE_BYTES) return json({ error: "image is larger than 25 MB" }, 413);
    const result = await submitProof(image, target);
    return json({ ...result, gate: status() });
  }

  if (path === "/photos" && request.method === "GET") {
    const today = localTime(Date.now()).day;
    const to = url.searchParams.get("to") ?? today;
    const from = url.searchParams.get("from") ?? addDays(to, -29);
    if (!DAY.test(from) || !DAY.test(to) || from > to) return json({ error: "from and to must be YYYY-MM-DD, from <= to" }, 400);
    const days = proofDays(from, to).map(({ day, photos }) => ({
      day,
      photos: photos.map((p) => ({ ...p, url: `${API_PREFIX}/photos/${p.sha256}` })),
    }));
    return json({ from, to, days });
  }

  const photo = /^\/photos\/([0-9a-f]{64})$/.exec(path);
  if (photo && request.method === "GET") {
    const file = proofFile(photo[1]);
    if (!file) return json({ error: "not found" }, 404);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return json({ error: "photo file is missing" }, 404);
    }
    const ext = file.split(".").pop()?.toLowerCase();
    const type = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic" }[ext ?? ""] ?? "application/octet-stream";
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" },
    });
  }

  return json({ error: "not found" }, 404);
}
