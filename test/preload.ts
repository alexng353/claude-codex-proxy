import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Tests must never inherit live account or state paths, even without shell overrides.
const scratch = process.env.TMPDIR ?? join(homedir(), ".cache/claude-codex-proxy-tests");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(scratch, "proxy-tests-"));
process.env.TMPDIR = root;
process.env.PROXY_STATE_DIR = join(root, "state");
process.env.XDG_STATE_HOME = join(root, "xdg-state");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
for (const path of [process.env.PROXY_STATE_DIR, process.env.XDG_STATE_HOME, process.env.CLAUDE_CONFIG_DIR])
  mkdirSync(path, { recursive: true });
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
