import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { handle } from "../src/gym-mcp";
import { emptyState, zonedTime, type GateState } from "../src/hygiene";
import { resetGateCache, setGateDeps } from "../src/hygiene-gate";
import { callHygieneTool, ROUTES, setHygieneFetcher, type Fetcher } from "../src/hygiene-mcp";

// Alex, Nov 20 08:34: "Just give yourself an mcp for that surely" (Bubble excusing
// hygiene items). Tools: hygiene_status, hygiene_skip, hygiene_unskip on the gym server.

const THREAD = "01a1f999-b87a-7ff2-99ed-a2a7d94da728";
const WORDS = "walrus lantern pebble";
const call = async (name: string, args: Record<string, unknown> = {}, meta: unknown = { threadId: THREAD }) =>
  ((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })) as any)
    .result;

let dir = "";
const saved: Record<string, string | undefined> = {};
const KEYS = ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE", "GYM_PROXY_URL", "PROXY_API_KEY", "GYM_BY"];
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.HYGIENE_GATE_REMOTE;
  delete process.env.PROXY_API_KEY;
  process.env.GYM_BY = "today-chat";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hygiene-mcp-test-"));
  process.env.PROXY_STATE_DIR = dir;
});
afterEach(() => {
  setHygieneFetcher();
  rmSync(dir, { recursive: true, force: true });
});
const logLines = () => (existsSync(join(dir, "hygiene-mcp.jsonl")) ? readFileSync(join(dir, "hygiene-mcp.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

/** A fake gate: canned status, every request recorded. */
function fake(status: Record<string, unknown>) {
  const calls: { route: string; body?: Record<string, unknown> }[] = [];
  const fetcher: Fetcher = async (route, body) => {
    calls.push({ route, body });
    if (route === "status") return { status: 200, body: status };
    return { status: 200, body: { ok: true, target: body?.target, message: `${route} ${body?.target}`, gate: { state: "clear" } } };
  };
  setHygieneFetcher(fetcher);
  return calls;
}

// 17:00Z on Nov 20 is 01:00 Nov 21 in Makassar, 09:00 Nov 20 in Vancouver.
const MAKASSAR = {
  state: "armed",
  now: "2026-11-20T17:00:00.000Z",
  zone: "Asia/Makassar",
  outstanding: [{ slot: "2026-11-20/shower", kind: "shower", label: "shower photo (overdue from Fri, Nov 20)" }],
  dueToday: [{ slot: "2026-11-21/night-teeth", kind: "teeth", label: "night teeth photo (17:00 to midnight)" }],
  bypass: { count: 31, activeUntil: null, phrase: { words: WORDS, slots: ["2026-11-20/shower"] }, retired: ["old words here"] },
  skips: [{ target: "2026-11-21/morning-walk", day: "2026-11-21", item: "morning-walk", at: "2026-11-20T16:00:00.000Z", by: "chat:x", reason: "rain" }],
  cancellations: { "morning-creatine": { at: "2026-11-01T00:00:00.000Z" } },
  suspensions: [],
  openDebts: [{ id: "d1", status: "open", penance: { description: `say ${WORDS}` } }, { id: "d2", status: "penance" }],
  lastProofs: [{ at: "2026-11-20T16:30:00.000Z", kind: "teeth", slot: "2026-11-21/morning-teeth" }],
};

describe("hygiene_status", () => {
  test("today's items in the gate's day, counts, and never the BYPASS words", async () => {
    const calls = fake(MAKASSAR);
    const r = await call("hygiene_status");
    expect(r.isError).toBe(false);
    const s = r.structuredContent;
    expect(s.day).toBe("2026-11-21");
    const by = Object.fromEntries(s.items.map((i: any) => [i.item, i.status]));
    expect(by).toEqual({
      "morning-teeth": "credited",
      "night-teeth": "due later",
      shower: "not due",
      "morning-weight": "not due",
      "morning-creatine": "paused",
      "morning-walk": "excused",
    });
    expect(s.locksNow).toEqual(["shower photo (overdue from Fri, Nov 20) [2026-11-20/shower]"]);
    expect(s.bypassCount).toBe(31);
    expect(s.openDebts).toBe(2);
    const all = JSON.stringify(r);
    for (const w of [WORDS, "walrus", "old words here", "phrase", "retired", "penance"]) expect(all).not.toContain(w);
    expect(r.content[0].text).toContain("Bypasses: 31; open debts: 2");
    expect(calls.map((c) => c.route)).toEqual(["status"]);
  });
});

describe("hygiene_skip", () => {
  test("an empty or blank reason is refused without any gate call", async () => {
    const calls = fake(MAKASSAR);
    for (const reason of [undefined, "", "   \n\t"]) {
      const r = await call("hygiene_skip", { item: "shower", ...(reason === undefined ? {} : { reason }) });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("a skip needs a reason");
    }
    expect(calls).toEqual([]);
  });

  test("{item} is today in the gate's local day, not this machine's", async () => {
    const calls = fake(MAKASSAR);
    const r = await call("hygiene_skip", { item: "shower", reason: "fever, no shower tonight" });
    expect(r.isError).toBe(false);
    expect(calls.map((c) => c.route)).toEqual(["status", "skip"]);
    expect(calls[1].body).toEqual({ target: "2026-11-21/shower", by: `chat:${THREAD}`, reason: "fever, no shower tonight" });
  });

  test("an explicit target is passed as given; bad targets never reach the gate", async () => {
    const calls = fake(MAKASSAR);
    expect((await call("hygiene_skip", { target: "2026-11-22/morning-walk", reason: "flight" })).isError).toBe(false);
    expect(calls[0]).toEqual({ route: "skip", body: { target: "2026-11-22/morning-walk", by: `chat:${THREAD}`, reason: "flight" } });
    for (const target of ["gym/2026-11-20-1", "penance/d1", "2026-11-20/bypass", "../bypass", "2026-11-20/shower/../../debt"])
      expect((await call("hygiene_skip", { target, reason: "x" })).isError).toBe(true);
    expect((await call("hygiene_skip", { target: "2026-11-20/shower", item: "shower", reason: "x" })).isError).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("by is the chat Codex stamped on the call; without one it is marked unattributed", async () => {
    const calls = fake(MAKASSAR);
    await call("hygiene_skip", { target: "2026-11-21/shower", reason: "sick" }, { threadId: "other-thread" });
    await call("hygiene_skip", { target: "2026-11-21/shower", reason: "sick" }, null);
    // A model can't name a chat: arguments are not where identity comes from.
    await call("hygiene_skip", { target: "2026-11-21/shower", reason: "sick", by: "alex" } as any, null);
    expect(calls.map((c) => c.body?.by)).toEqual(["chat:other-thread", "today-chat (unattributed)", "today-chat (unattributed)"]);
  });

  test("every call is logged with tool, chat, target and a clipped reason", async () => {
    fake(MAKASSAR);
    await call("hygiene_status");
    await call("hygiene_skip", { item: "shower", reason: `fever ${"x".repeat(400)}` });
    await call("hygiene_skip", { item: "shower", reason: " " });
    const lines = logLines();
    expect(lines.map((l) => [l.tool, l.chat, l.ok])).toEqual([
      ["hygiene_status", THREAD, true],
      ["hygiene_skip", THREAD, true],
      ["hygiene_skip", THREAD, false],
    ]);
    expect(lines[1].target).toBe("2026-11-21/shower");
    expect(lines[1].reason.length).toBe(120);
    expect(JSON.stringify(lines)).not.toContain(WORDS);
  });
});

describe("tools reach only their fixed local routes", () => {
  // HMCP-M2 (Lagrange, 56dc840): a fetch that throws escaped the audit log.
  test("a gate that can't be reached still gives one audit line with the chat, and an MCP error", async () => {
    setHygieneFetcher(async () => {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    });
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      ["hygiene_status", {}, undefined],
      ["hygiene_skip", { item: "shower", reason: "fever" }, undefined],
      ["hygiene_skip", { target: "2026-11-21/shower", reason: "fever" }, "2026-11-21/shower"],
      ["hygiene_unskip", { target: "2026-11-21/shower" }, "2026-11-21/shower"],
    ];
    for (const [i, [name, args, target]] of cases.entries()) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toStartWith("gate unreachable: Unable to connect");
      const lines = logLines();
      expect(lines.length).toBe(i + 1);
      expect(lines[i]).toMatchObject({ tool: name, chat: THREAD, by: `chat:${THREAD}`, ok: false });
      expect(lines[i].target).toBe(target);
      expect(lines[i].error).toStartWith("gate unreachable:");
      expect(JSON.stringify(lines[i])).not.toContain("    at ");
    }
    expect(logLines()[1].reason).toBe("fever");
  });

  test("an unknown tool name is logged too", async () => {
    const calls = fake(MAKASSAR);
    const r = await callHygieneTool("hygiene_bypass", {}, { threadId: THREAD });
    expect(r.isError).toBe(true);
    expect(logLines()).toMatchObject([{ tool: "hygiene_bypass", chat: THREAD, ok: false, error: "unknown tool hygiene_bypass" }]);
    expect(calls).toEqual([]);
  });

  test("the route table separates hygiene from bedtime decisions", () => {
    expect(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /hygiene/status", "POST /hygiene/skip", "POST /hygiene/unskip", "POST /hygiene/bedtime/approve", "POST /hygiene/bedtime/deny"]);
  });

  test("over HTTP, every request any tool makes goes to one of them", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json(new URL(req.url).pathname === "/hygiene/status" ? MAKASSAR : { ok: true, message: "ok", gate: { state: "clear" } });
      },
    });
    process.env.GYM_PROXY_URL = `http://127.0.0.1:${server.port}`;
    try {
      const hostile = ["../bypass", "/hygiene/bypass", "x/../../debt/d1/resolve", "2026-11-21/shower?x=/bypass", "gym/1"];
      for (const name of ["hygiene_status", "hygiene_skip", "hygiene_unskip"]) {
        await call(name, {});
        await call(name, { item: "shower", reason: "r" });
        for (const target of hostile) await call(name, { target, reason: "r" });
      }
    } finally {
      server.stop(true);
    }
    expect(new Set(seen)).toEqual(new Set(["GET /hygiene/status", "POST /hygiene/skip", "POST /hygiene/unskip"]));
  });
});

describe("through the proxy against a test gate", () => {
  const DAY = "2026-11-05";
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    process.env.HYGIENE_GATE_STATE = join(dir, "hygiene-gate.json");
    process.env.HYGIENE_GATE_DISABLED_FILE = join(dir, "disabled");
    const state: GateState = emptyState("2026-11-01T00:00:00.000Z");
    state.bypass = { ...state.bypass, count: 7, phrase: { words: WORDS, slots: [], issuedAt: "2026-11-05T18:00:00.000Z" } } as GateState["bypass"];
    writeFileSync(process.env.HYGIENE_GATE_STATE, JSON.stringify(state));
    resetGateCache();
    setGateDeps({ now: () => zonedTime(DAY, 12 * 60) });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, "127.0.0.1") });
    process.env.GYM_PROXY_URL = `http://127.0.0.1:${server.port}`;
  });
  afterEach(() => {
    server.stop(true);
    setGateDeps({});
    resetGateCache();
  });
  const gate = () => JSON.parse(readFileSync(process.env.HYGIENE_GATE_STATE!, "utf8")) as GateState;

  test("skip, status, unskip", async () => {
    const skipped = await call("hygiene_skip", { item: "shower", reason: "Alex is sick" });
    expect(skipped.isError).toBe(false);
    expect(skipped.content[0].text).toContain("skipped shower");
    expect(gate().skips).toEqual([{ day: DAY, item: "shower", at: expect.any(String), by: `chat:${THREAD}`, reason: "Alex is sick" }]);
    const status = await call("hygiene_status");
    expect(status.structuredContent.items.find((i: any) => i.item === "shower")).toMatchObject({ status: "excused", by: `chat:${THREAD}` });
    expect(status.structuredContent.bypassCount).toBe(7);
    expect(JSON.stringify(status)).not.toContain("walrus");
    const undone = await call("hygiene_unskip", { item: "shower" });
    expect(undone.isError).toBe(false);
    expect(gate().skips).toEqual([]);
    expect(gate().bypass.count).toBe(7);
    expect(gate().debts).toEqual([]);
    const again = await call("hygiene_unskip", { item: "shower" });
    expect(again).toMatchObject({ isError: true, content: [{ text: `${DAY}/shower isn't skipped` }] });
  });
});
