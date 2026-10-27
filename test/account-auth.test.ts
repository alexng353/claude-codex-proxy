import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountStatus, isAuthError, isUnavailable, markAuthFailed, resetAccountState } from "../src/accounts";
import { closeIdleWorkers, runClaude } from "../src/claude";
import { threadAccount } from "../src/sessions";

for (const mode of ["result", "stderr", "array", "numeric", "all", "other"] as const) {
  test(`authentication failover: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-auth-"));
    const saved = Object.fromEntries(["CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "PROXY_STATE_DIR"]
      .map((key) => [key, process.env[key]]));
    const base = join(root, "base");
    const state = join(root, "state");
    const fake = join(root, "fake.mjs");
    await mkdir(base);
    await mkdir(join(state, "accounts/spare"), { recursive: true });
    await writeFile(join(state, "accounts/spare/.credentials.json"), "{}");
    await writeFile(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const spare = process.env.CLAUDE_CONFIG_DIR.endsWith("/spare");
appendFileSync(${JSON.stringify(join(root, "launches"))}, spare ? "spare\\n" : "default\\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!spare || ${JSON.stringify(mode)} === "all") {
    const error = (${JSON.stringify(mode)} === "other" ? "Invalid request: context too long" : "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.") + " private-diagnostic-marker";
    if (${JSON.stringify(mode)} === "stderr") { console.error(error); process.exit(1); }
    console.log(JSON.stringify({ type: "result", is_error: true, ...(${JSON.stringify(mode)} === "array" ? { subtype: "error_during_execution", errors: ["Not logged in. Run claude auth login. private-diagnostic-marker"] } : ${JSON.stringify(mode)} === "numeric" ? { api_error_status: 401, result: "Unauthorized private-diagnostic-marker" } : { result: error }) }));
  } else console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { text: "spare success", tool_calls: [] } }));
}
`);
    await chmod(fake, 0o755);
    closeIdleWorkers();
    resetAccountState();
    process.env.CLAUDE_BIN = fake;
    process.env.CLAUDE_CONFIG_DIR = base;
    process.env.PROXY_STATE_DIR = state;
    try {
      const thread = crypto.randomUUID();
      const request = { model: "sonnet", input: "hello", prompt_cache_key: thread };
      if (mode === "all" || mode === "other") {
        await expect(runClaude(request)).rejects.toThrow(mode === "all" ? "OAuth access token has expired" : "context too long");
        expect(await readFile(join(root, "launches"), "utf8")).toBe(mode === "all" ? "default\nspare\n" : "default\n");
        if (mode === "all") {
          await expect(runClaude(request)).rejects.toThrow("authentication failed on every account");
          expect(await readFile(join(root, "launches"), "utf8")).toBe("default\nspare\n");
          await writeFile(join(base, ".credentials.json"), "{\"updated\":true}");
          expect(accountStatus()[0].authFailedUntil).toBeNull();
        }
      } else {
        const output = await runClaude(request);
        expect(output.text).toBe("spare success");
        expect(output.account).toBe("spare");
        expect(threadAccount(thread)).toBe("spare");
        closeIdleWorkers();
        expect((await runClaude({ ...request, prompt_cache_key: crypto.randomUUID() })).account).toBe("spare");
        expect(await readFile(join(root, "launches"), "utf8")).toBe("default\nspare\nspare\n");
        const status = accountStatus()[0];
        expect(status.limitedUntil).toBeNull();
        expect(status.authFailedUntil).toBeTruthy();
      }
      const logs = (await readFile(join(state, "failures.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(logs[0].account).toBe("default");
      expect(logs[0].category).toBe(mode === "other" ? "worker_error" : "authentication");
      expect(logs[0].requestId).toBeTruthy();
      expect(logs.some((row) => row.event === "failover")).toBe(mode !== "other");
      expect(JSON.stringify(logs)).not.toContain("hello");
      expect(JSON.stringify(logs)).not.toContain("private-diagnostic-marker");
      for (const row of logs) {
        expect(Object.keys(row).every((key) => ["timestamp", "event", "requestId", "account", "nextAccount", "workerId", "attempt", "category", "status"].includes(key))).toBe(true);
        if (mode !== "other") expect(row.category).toBe("authentication");
      }
    } finally {
      closeIdleWorkers();
      resetAccountState();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("authentication cooldown expires independently from quota", () => {
  resetAccountState();
  const account = { name: "expired-auth", dir: "/unused", isDefault: false };
  const before = Date.now();
  markAuthFailed(account);
  expect(isUnavailable(account, before + 60_000)).toBe(true);
  expect(isUnavailable(account, Date.now() + 15 * 60_000)).toBe(false);
  resetAccountState();
});

test("authentication classification accepts numeric status and explicit CLI errors", () => {
  expect(isAuthError(401, undefined)).toBe(true);
  expect(isAuthError(undefined, "API Error: 401 OAuth access token has expired")).toBe(true);
  expect(isAuthError(undefined, "invalid authentication credentials")).toBe(true);
  expect(isAuthError(400, "Invalid request")).toBe(false);
});
