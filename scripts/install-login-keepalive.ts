#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Supply a stable checkout: installing from a disposable worktree breaks the timer after cleanup.
const checkout = process.argv[2] && realpathSync(process.argv[2]);
if (!checkout || !existsSync(join(checkout, "scripts/login-keepalive.ts"))) {
  throw new Error("Usage: bun scripts/install-login-keepalive.ts /absolute/stable/checkout [--dry-run]");
}
const bun = Bun.which("bun");
const claude = Bun.which(process.env.CLAUDE_BIN ?? "claude");
if (!bun || !claude) throw new Error("bun and claude must be installed");
// Unit directives have their own quoting and specifier syntax; reject unsupported paths.
for (const value of [checkout, bun, claude]) {
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(value)) throw new Error("Use paths without whitespace or systemd specifiers");
}
const version = Bun.spawnSync([claude, "--version"], { stdout: "pipe", stderr: "ignore" });
const match = version.stdout.toString().match(/^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/);
const [major = 0, minor = 0, patch = 0] = match?.slice(1).map(Number) ?? [];
if (version.exitCode !== 0 || !(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 282))))) {
  throw new Error("Claude >= 2.1.282 required; set CLAUDE_BIN to the proxy's supported CLI before installing");
}
const unitDir = join(homedir(), ".config/systemd/user");
for (const suffix of ["service", "timer"]) {
  const name = `claude-login-keepalive.${suffix}`;
  const body = readFileSync(join(import.meta.dir, "../deploy", name), "utf8")
    .replaceAll("@CHECKOUT@", checkout).replaceAll("@BUN@", bun).replaceAll("@CLAUDE@", claude);
  if (process.argv.includes("--dry-run")) { console.log(`# ${name}\n${body}`); continue; }
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, name), body, { mode: 0o644 });
}
if (!process.argv.includes("--dry-run")) {
  for (const args of [["daemon-reload"], ["enable", "--now", "claude-login-keepalive.timer"]]) {
    const child = Bun.spawn(["systemctl", "--user", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    if (await child.exited !== 0) throw new Error("systemctl failed; inspect the user unit before retrying");
  }
}
