import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverForOutage, retryUnchecked, wasDelivered } from "../src/hygiene-remote";
import { gateRequest } from "../src/hygiene-gate";
import type { ResponsesRequest } from "../src/types";

let dir: string;
let saved: Record<string, string | undefined>;
let server: ReturnType<typeof Bun.serve> | undefined;
const url = (name: string) => `data:image/jpeg;base64,${Buffer.from(name).toString("base64")}`;
const request = (...photos: string[]) => ({ model: "opus", input: [{ role: "user", content: photos.map(image_url => ({ type: "input_image", image_url })) }] }) as ResponsesRequest;
const path = () => join(dir, "hygiene-unchecked.json");
beforeEach(() => {
  saved = Object.fromEntries(["PROXY_STATE_DIR", "HYGIENE_GATE_REMOTE", "HYGIENE_GATE_DISABLED_FILE"].map(key => [key, process.env[key]]));
  dir = fs.mkdtempSync(join(tmpdir(), "hygiene-remote-"));
  process.env.PROXY_STATE_DIR = dir;
  process.env.HYGIENE_GATE_DISABLED_FILE = join(dir, "disabled");
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const status of [500, 508]) test(`HTTP ${status} delivers images`, async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unavailable", { status }) });
  process.env.HYGIENE_GATE_REMOTE = String(server.url);
  const decision = await gateRequest(request(url("failure")));
  expect(decision.action).toBe("forward");
  expect(JSON.stringify(decision)).toContain(url("failure"));
  expect(JSON.stringify(decision)).toContain("photo not checked yet");
});

test("decision timeout delivers images", async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  process.env.HYGIENE_GATE_REMOTE = String(server.url);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
  try {
    const decision = await gateRequest(request(url("timeout")));
    expect(decision.action).toBe("forward");
    expect(JSON.stringify(decision)).toContain(url("timeout"));
  } finally { timeout.mockRestore(); }
});

test("null history items cannot break fail-open delivery", () => {
  const req = request(url("null-history"));
  (req.input as unknown[]).unshift(null);
  expect(JSON.stringify(deliverForOutage(req))).toContain(url("null-history"));
});

test("corrupt files are preserved and the state directory is private", () => {
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path(), "broken JSON");
  deliverForOutage(request(url("recover")));
  const backup = fs.readdirSync(dir).find(name => name.startsWith("hygiene-unchecked.json.corrupt."));
  expect(backup).toBeDefined();
  expect(fs.readFileSync(join(dir, backup!), "utf8")).toBe("broken JSON");
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
});

test("pending entry cap drops oldest bytes without losing delivered hashes", () => {
  const photos = Array.from({ length: 65 }, (_, i) => url(`photo-${i}`));
  deliverForOutage(request(...photos));
  const store = JSON.parse(fs.readFileSync(path(), "utf8"));
  expect(Object.keys(store.pending)).toHaveLength(64);
  expect(Object.values(store.pending).some((p: any) => p.url === photos[0])).toBe(false);
  expect(wasDelivered(photos[0])).toBe(true);
});

test("pending byte cap does not prevent delivery", () => {
  const huge = "data:image/jpeg;base64," + "A".repeat(64 * 1024 * 1024);
  expect(JSON.stringify(deliverForOutage(request(huge))).includes(huge)).toBe(true);
  expect(Object.keys(JSON.parse(fs.readFileSync(path(), "utf8")).pending)).toHaveLength(0);
});

test("delivered lookups reuse the parsed store until the file changes", () => {
  deliverForOutage(request(url("cached")));
  const reads = spyOn(fs, "readFileSync");
  try {
    for (let i = 0; i < 10; i++) expect(wasDelivered(url("cached"))).toBe(true);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
    fs.writeFileSync(path(), JSON.stringify({ keys: [], pending: {}, checked: [], withheld: {} }));
    expect(wasDelivered(url("cached"))).toBe(false);
  } finally { reads.mockRestore(); }
});

test("a 404 entry does not stall later entries, backs off, and logs once", async () => {
  deliverForOutage(request(url("first"), url("second")));
  let calls = 0;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    calls++;
    const body = await req.json() as { url: string };
    return body.url === url("first") ? new Response("old authority", { status: 404 }) : Response.json({ checked: true });
  } });
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await retryUnchecked(String(server.url));
    expect(calls).toBe(2);
    expect(Object.keys(JSON.parse(fs.readFileSync(path(), "utf8")).pending)).toHaveLength(1);
    await retryUnchecked(String(server.url));
    expect(calls).toBe(2);
    await retryUnchecked(String(server.url), path(), Date.now() + 30_001);
    expect(calls).toBe(3);
    expect(logs.mock.calls.filter(args => args.join(" ").includes("404"))).toHaveLength(1);
  } finally { logs.mockRestore(); }
});


test("a restarted worker enforces queue caps before submitting old pending entries", async () => {
  const photos = Array.from({ length: 65 }, (_, i) => url(`saved-${i}`));
  const pending = Object.fromEntries(photos.map((photo, i) => [`key-${i}`, { url: photo, at: i }]));
  fs.writeFileSync(path(), JSON.stringify({ keys: Object.keys(pending), pending }));
  const submitted: string[] = [];
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    submitted.push((await req.json() as { url: string }).url);
    return Response.json({ checked: true });
  } });
  await retryUnchecked(String(server.url));
  expect(submitted).toHaveLength(64);
  expect(submitted).not.toContain(photos[0]);
});


test("backoff starts after a slow failed request finishes", async () => {
  deliverForOutage(request(url("slow-failure")));
  let now = Date.now();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    now += 90_000;
    return new Response("unavailable", { status: 503 });
  } });
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await retryUnchecked(String(server.url));
    const pending = Object.values(JSON.parse(fs.readFileSync(path(), "utf8")).pending) as Array<{ nextAttemptAt: number }>;
    expect(pending[0].nextAttemptAt).toBeGreaterThanOrEqual(now + 30_000);
  } finally { clock.mockRestore(); }
});

test("an unchanged corrupt store is not reparsed for every image", () => {
  fs.writeFileSync(path(), "broken JSON");
  const reads = spyOn(fs, "readFileSync");
  try {
    for (let i = 0; i < 10; i++) expect(wasDelivered(url("unknown"))).toBe(false);
    expect(reads.mock.calls.length).toBe(1);
  } finally { reads.mockRestore(); }
});
