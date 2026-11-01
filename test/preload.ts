import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Tests must never inherit live account or state paths, even without shell overrides.
// The default scratch is RAM-backed: the code under test fsyncs on every request
// (SQLite commits, the perpetual log), and on a disk shared with other jobs each
// fsync can take 20-500 ms, which pushed multi-turn tests past bun's 5 s timeout.
function defaultScratch(): string {
  for (const ram of [process.env.XDG_RUNTIME_DIR, "/dev/shm"])
    if (ram && existsSync(ram)) return join(ram, "claude-codex-proxy-tests");
  return join(homedir(), ".cache/claude-codex-proxy-tests");
}
const scratch = process.env.TMPDIR ?? defaultScratch();
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(scratch, "proxy-tests-"));
process.env.TODAY_DAEMON_BIN = join(root, "test-only-today-daemon");
writeFileSync(process.env.TODAY_DAEMON_BIN, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
process.env.TMPDIR = root;
process.env.PROXY_STATE_DIR = join(root, "state");
process.env.XDG_STATE_HOME = join(root, "xdg-state");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
for (const path of [process.env.PROXY_STATE_DIR, process.env.XDG_STATE_HOME, process.env.CLAUDE_CONFIG_DIR])
  mkdirSync(path, { recursive: true });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// A spawned test server must never deliver weigh-ins using a live agent token.
delete process.env.HYGIENE_CAIRN_AGENT_CONFIG;
// Shared scrubbers must not discover real credentials during fake CLI tests.
process.env.SECRET_SCRUB_FILES = "";
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
