import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/app";
import { parseStart } from "../src/gym-client";
import { setGymFetcher } from "../src/gym-sync";
import { handle } from "../src/gym-mcp";
import { zonedTime } from "../src/hygiene";
import { resetGateCache, setGateDeps } from "../src/hygiene-gate";

const at = (day: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return zonedTime(day, h * 60 + m);
};

let directory = "";
let server: ReturnType<typeof Bun.serve>;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gym-mcp-test-"));
  for (const key of ["PROXY_STATE_DIR", "HYGIENE_GATE_STATE", "HYGIENE_GATE_DISABLED_FILE", "HYGIENE_GATE_REMOTE", "GYM_PROXY_URL", "PROXY_API_KEY", "GYM_BY"])
    saved[key] = process.env[key];
  delete process.env.HYGIENE_GATE_REMOTE;
  delete process.env.PROXY_API_KEY;
  process.env.GYM_BY = "bubble";
  process.env.PROXY_STATE_DIR = directory;
  process.env.HYGIENE_GATE_STATE = join(directory, "hygiene-gate.json");
  process.env.HYGIENE_GATE_DISABLED_FILE = join(directory, "disabled");
  await mkdir(directory, { recursive: true });
  await writeFile(process.env.HYGIENE_GATE_STATE, JSON.stringify({ version: 1, startsAt: "2027-01-01T13:00:00.000Z" }));
  resetGateCache();
  setGateDeps({ now: () => at("2026-11-05", "12:00") });
  setGymFetcher(async () => ({ checkins: [], workouts: [] }));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleRequest(request, "127.0.0.1") });
  process.env.GYM_PROXY_URL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  setGateDeps({});
  setGymFetcher();
  resetGateCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

describe("start times", () => {
  test("wall time is Vancouver; ISO needs an offset", () => {
    expect(parseStart("2026-11-05 18:00")).toBe(new Date(at("2026-11-05", "18:00")).toISOString());
    expect(parseStart("2026-11-05T18:00")).toBe(new Date(at("2026-11-05", "18:00")).toISOString());
    expect(parseStart("2026-11-06T02:00:00Z")).toBe("2026-11-06T02:00:00.000Z");
    expect(parseStart("2026-11-05T18:00:00-07:00")).toBe("2026-11-06T01:00:00.000Z");
    // Without an offset an ISO time is ambiguous: refuse rather than guess.
    expect(parseStart("2026-11-05T18:00:00")).toBeNull();
    expect(parseStart("tomorrow 6pm")).toBeNull();
    expect(parseStart("2026-11-05 25:00")).toBeNull();
  });
});

describe("MCP server", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any;

  test("initialize and tools/list", async () => {
    const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
    expect(init.result.serverInfo.name).toBe("gym");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["gym_status", "gym_plan_add", "gym_plan_move", "gym_plan_cancel", "gym_plan_skip"]);
  });

  test("add, move, status and cancel through the proxy, logged as the caller", async () => {
    const added = await call("gym_plan_add", { start: "2026-11-05 18:00", note: "legs" });
    expect(added.result).toEqual({ content: [{ type: "text", text: "planned Thu, Nov 5 18:00, start by 18:30 (plan 2026-11-05-1)" }], isError: false });
    const moved = await call("gym_plan_move", { id: "2026-11-05-1", start: "2026-11-05 19:00" });
    expect(moved.result.content[0].text).toBe("moved to Thu, Nov 5 19:00, start by 19:30 (plan 2026-11-05-1)");
    const status = await call("gym_status");
    expect(status.result.content[0].text).toContain("2026-11-05-1: Thu, Nov 5 19:00 (upcoming; start by Thu, Nov 5 19:30) - legs");
    const cancelled = await call("gym_plan_cancel", { id: "2026-11-05-1" });
    expect(cancelled.result.content[0].text).toBe("cancelled Thu, Nov 5 19:00 (plan 2026-11-05-1)");
    const report = await (await fetch(`${process.env.GYM_PROXY_URL}/hygiene/gym`)).json();
    expect(report.plans[0].log.map((e: any) => [e.action, e.by])).toEqual([
      ["add", "bubble"],
      ["move", "bubble"],
      ["cancel", "bubble"],
    ]);
  });

  test("bad input comes back as a tool error, not a crash", async () => {
    expect((await call("gym_plan_add", { start: "tonight" })).result.isError).toBe(true);
    expect((await call("gym_plan_add", { start: "2026-11-01 18:00" })).result).toMatchObject({
      isError: true,
      content: [{ text: "start must be in the future" }],
    });
    expect((await call("gym_plan_cancel", { id: "nope" })).result).toMatchObject({ isError: true, content: [{ text: "no plan nope" }] });
    expect((await call("gym_credit")).result.isError).toBe(true);
  });
});
