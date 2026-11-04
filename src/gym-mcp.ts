#!/usr/bin/env bun
/**
 * MCP server (stdio, JSON-RPC 2.0) for gym plans on the hygiene gate. Lets a
 * chat (Bubble) add, move and cancel the sessions Alex tells it about. Hand
 * credit is deliberately absent: it stays on the CLI.
 *
 * Register in Codex: [mcp_servers.gym] command = "bun", args = ["<repo>/src/gym-mcp.ts"].
 */
import { describeReport, gymCall, startArg } from "./gym-client";

const WHEN =
  'Wall time "YYYY-MM-DD HH:MM" in the phone\'s current zone (e.g. "2026-11-04 18:00"; Vancouver unless Cairn reports another), or with a zone name for a time elsewhere ("2026-12-05 18:00 America/Vancouver"), or ISO with an offset. Must be in the future. The reply shows the zone when it isn\'t Vancouver.';

export const TOOLS = [
  {
    name: "gym_status",
    description:
      "Alex's planned gym sessions and what Uplifting reported: each plan's id, start, status (upcoming, in-progress, kept, missed, made-up, cancelled) and deadline.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gym_plan_add",
    description:
      "Plan a gym session Alex told you about. If he hasn't tapped Start in Uplifting at Gold's by start + grace, his hygiene gate locks until he logs a qualifying session or replies the lock's BYPASS phrase. Only add plans Alex stated.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: WHEN },
        grace_min: { type: "integer", minimum: 0, maximum: 360, description: "Minutes after start before the gate locks (default 30)." },
        note: { type: "string", description: "Why or what, in Alex's words (logged)." },
      },
      required: ["start"],
      additionalProperties: false,
    },
  },
  {
    name: "gym_plan_move",
    description: "Move a plan before its start, at Alex's request. Refused once the planned start has passed.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, start: { type: "string", description: WHEN }, note: { type: "string" } },
      required: ["id", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "gym_plan_cancel",
    description:
      "Cancel a plan at Alex's request. Before its start it is removed; after its start the cancel is logged but still counts as a miss.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

const by = () => process.env.GYM_BY || "mcp";

export async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const note = typeof args.note === "string" ? args.note : undefined;
  const result = (r: { status: number; body: any }) =>
    r.status >= 400 || r.body?.ok === false
      ? { text: r.body?.error ?? `failed (${r.status})`, isError: true }
      : { text: r.body?.message ? `${r.body.message} (plan ${r.body.plan?.id})` : describeReport(r.body), isError: false };
  switch (name) {
    case "gym_status":
      return result(await gymCall(""));
    case "gym_plan_add": {
      const start = startArg(String(args.start ?? ""));
      if (!start) return { text: `start must be ${WHEN}`, isError: true };
      return result(await gymCall("/plans", { start, by: by(), note, ...(args.grace_min !== undefined ? { grace_min: args.grace_min } : {}) }));
    }
    case "gym_plan_move": {
      const start = startArg(String(args.start ?? ""));
      if (!start) return { text: `start must be ${WHEN}`, isError: true };
      return result(await gymCall(`/plans/${encodeURIComponent(String(args.id ?? ""))}/move`, { start, by: by(), note }));
    }
    case "gym_plan_cancel":
      return result(await gymCall(`/plans/${encodeURIComponent(String(args.id ?? ""))}/cancel`, { by: by(), note }));
    default:
      return { text: `unknown tool ${name}`, isError: true };
  }
}

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };

export async function handle(message: Rpc): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  if (message.id === undefined) return null; // notifications
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "gym", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const { text, isError } = await callTool(String(message.params?.name), message.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text }], isError });
      } catch (error) {
        return reply({ content: [{ type: "text", text: `gate unreachable: ${(error as Error).message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } };
  }
}

if (import.meta.main) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Rpc;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        continue;
      }
      const response = await handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
