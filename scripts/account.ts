#!/usr/bin/env bun
/**
 * Manage the extra Claude accounts the proxy fails over to.
 *
 *   bun run account add <name>   sign a new account in (opens the browser)
 *   bun run account list         show each account's login
 *   bun run account remove <name>
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { accountsDir, linkSharedEntries, listAccounts } from "../src/accounts";

const claude = process.env.CLAUDE_BIN ?? "claude";
const [command, name] = process.argv.slice(2);

function env(dir?: string): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  delete base.CLAUDECODE;
  delete base.ANTHROPIC_API_KEY;
  if (dir) base.CLAUDE_CONFIG_DIR = dir;
  return base;
}

function checkName(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value) || value === "default") {
    console.error("Give a name made of letters, digits, - or _ (not 'default').");
    process.exit(2);
  }
  return value;
}

if (command === "add") {
  const dir = join(accountsDir(), checkName(name));
  linkSharedEntries(dir);
  const login = Bun.spawn([claude, "auth", "login"], {
    env: env(dir),
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await login.exited);
} else if (command === "list") {
  for (const account of listAccounts()) {
    const status = Bun.spawnSync([claude, "auth", "status"], {
      env: env(account.isDefault ? undefined : account.dir),
    });
    let email = "not logged in";
    try {
      const parsed = JSON.parse(status.stdout.toString());
      if (parsed.loggedIn) email = parsed.email ?? "logged in";
    } catch {}
    console.log(`${account.name}\t${email}\t${account.dir}`);
  }
} else if (command === "remove") {
  // Only the account directory: its entries are symlinks, so rm does not
  // follow them into the shared config.
  rmSync(join(accountsDir(), checkName(name)), { recursive: true, force: true });
} else {
  console.error("Usage: bun run account add|list|remove <name>");
  process.exit(2);
}
