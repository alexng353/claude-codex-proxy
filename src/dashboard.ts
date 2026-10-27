import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

type Sample = {
  t: number;
  a: string;
  w: Record<string, { v: number; r: string | null; t: number }>;
};
type Turn = {
  t: number;
  a: string;
  m: string;
  e: number;
  i: number | null;
  o: number | null;
  cr: number | null;
  cw: number | null;
  c: number | null;
};
const DAY = 86_400_000;

export function dashboardData(directory: string, now = Date.now()) {
  const samples: Sample[] = [];
  const history = join(directory, "limits-history.jsonl");
  if (existsSync(history)) {
    const fd = openSync(history, "r");
    try {
      // Bound reads for a recorder that runs indefinitely. Skip the cut first line.
      const size = fstatSync(fd).size,
        start = Math.max(0, size - 16 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytes).toString("utf8");
      for (const line of (start
        ? text.slice(text.indexOf("\n") + 1)
        : text
      ).split("\n")) {
        try {
          const row = JSON.parse(line),
            t = Date.parse(row.recordedAt);
          if (
            !Number.isFinite(t) ||
            t < now - DAY ||
            t > now ||
            typeof row.account !== "string"
          )
            continue;
          const w: Sample["w"] = {};
          for (const [key, value] of Object.entries(row.windows ?? {})) {
            const window = value as {
              usedPercent?: number;
              resetsAt?: string;
              observedAt?: string;
            } | null;
            if (
              !window ||
              typeof window.usedPercent !== "number" ||
              !Number.isFinite(window.usedPercent)
            )
              continue;
            const observedAt = Date.parse(
              window.observedAt ?? row.observedAt ?? row.recordedAt,
            );
            w[key] = {
              v: window.usedPercent,
              r:
                typeof window.resetsAt === "string" &&
                Number.isFinite(Date.parse(window.resetsAt))
                  ? window.resetsAt
                  : null,
              t: Number.isFinite(observedAt) ? observedAt : t,
            };
          }
          samples.push({ t, a: row.account, w });
        } catch {
          /* The recorder may still be appending the final line. */
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  samples.sort((a, b) => a.t - b.t);
  let turns: Turn[] = [];
  const path = join(directory, "usage.sqlite");
  if (existsSync(path)) {
    const db = new Database(path, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      turns = db
        .query(
          `SELECT ts AS t, coalesce(account, 'default') AS a, model AS m,
        is_error AS e, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr,
        cache_write_tokens AS cw, cost_usd AS c FROM turns WHERE ts >= ? AND ts <= ? ORDER BY ts`,
        )
        .all(now - DAY, now) as Turn[];
    } finally {
      db.close();
    }
  }
  return { samples, turns, at: now };
}

export function dashboardHandler(directory: string) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== url.origin)
    ) {
      return new Response("Forbidden", { status: 403, headers });
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405, headers });
    if (url.pathname === "/health")
      return Response.json({ status: "ok" }, { headers });
    if (!["/", "/data"].includes(url.pathname))
      return new Response("Not found", { status: 404, headers });
    try {
      const data = dashboardData(directory);
      if (url.pathname === "/data") return Response.json(data, { headers });
      const template = readFileSync(
        join(import.meta.dir, "dashboard.html"),
        "utf8",
      );
      // Telemetry names are text, never executable markup.
      const safeData = JSON.stringify(data).replaceAll("<", "\\u003c");
      return new Response(
        template.replace("__QUOTA_DATA__", () => safeData),
        {
          headers: { ...headers, "content-type": "text/html; charset=utf-8" },
        },
      );
    } catch (cause) {
      console.error(
        "Unable to read dashboard telemetry:",
        cause instanceof Error ? cause.message : String(cause),
      );
      return new Response(
        "Unable to read usage telemetry. Retry shortly or check the dashboard service log.",
        { status: 503, headers },
      );
    }
  };
}
