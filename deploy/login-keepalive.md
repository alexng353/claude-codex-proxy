# Claude login keepalive

The keepalive runs `claude -p /usage --output-format stream-json --verbose
--no-session-persistence --safe-mode --tools '' --strict-mcp-config` for every
configured account, including accounts outside the preferred order and accounts
at their weekly cap. This is a local command with no model turn or quota spend,
so rate-limited accounts can also renew. It shares the usage probe's cross-process
lease. An overlapping batch skips rather than running competing refreshes.

Claude must be **2.1.282 or newer**. Older or unrecognized versions are refused;
there is no model-turn fallback. Set `CLAUDE_BIN` to the same binary as the live
proxy: on Forge, the shell wrapper currently points to an older version than the
proxy service. The CLI owns OAuth refresh and its credential lock. The script
never implements refresh-token rotation or changes routing, caps, or pins.

`auth status` reads local login presence; it does not validate or renew a token.
The installed 2.1.302 implementation of `/usage` calls the utilization endpoint
with `refreshOAuth: true`. It can swallow HTTP errors into an empty report. When
no usable report arrives or an existing auth incident needs recovery, the proxy checks the same read-only usage endpoint:
401 means authentication failed; network errors, 429, and server errors stay
unknown. The bearer token remains in process memory, redirects are refused, and
response/error bodies are never logged. A successful model turn or usage check
clears a failure incident.

## Installation (operator only)

Use a stable checkout containing this revision, not a disposable worktree. Match
`PROXY_STATE_DIR` and `CLAUDE_CONFIG_DIR` to the proxy in
`~/.config/claude-codex-proxy/keepalive.env` if they differ from the defaults.
This file can also set `CLAUDE_BIN`. Do not put tokens in it.

```sh
CLAUDE_BIN=/absolute/path/to/supported/claude bun scripts/install-login-keepalive.ts /absolute/stable/checkout --dry-run
CLAUDE_BIN=/absolute/path/to/supported/claude bun scripts/install-login-keepalive.ts /absolute/stable/checkout
```

The installer renders the checked-in service template, reloads user systemd,
and enables the timer. It does not restart the proxy. The calendar is every three
hours at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, and 21:00 in the machine's
local timezone, plus up to five minutes of jitter. `Persistent=true` catches up
one missed run. The service has a ten-minute timeout.

Warning delivery calls `~/.local/bin/today-daemon send --socket
/run/user/<uid>/today/daemon.sock today -`. The proxy checks pending failures every
15 seconds; the keepalive flushes after its batch. Tests inject a sender and never
post real messages. `account-auth.json` stores only account paths, incident IDs,
timestamps, and delivery state (mode 0600). A cross-process sender lease prevents
concurrent duplicate sends. Delivery failures retry. As with any CLI sender
without an idempotency key, a crash after delivery but before recording success
can duplicate a warning.

Expiry warnings begin three days before `refreshTokenExpiresAt`, including already
expired tokens. A continuous near-expiry interval generates one warning, even if
the deadline drifts by milliseconds. A deadline more than three days away rearms
it. Missing metadata stays unknown; it is not treated as a renewed login.
`/accounts` exposes `authFailedSince` (ISO timestamp or null) and
`refreshTokenExpiresAt` (epoch milliseconds or null), alongside the existing
cooldown. Probe logs say `auth failed since <timestamp>` for known failures.

Sample warning:

> Claude proxy on forge: account hinson authentication failed since 2026-10-28T23:00:00.000Z. On forge, run CLAUDE_CONFIG_DIR='/home/alex/.local/state/claude-codex-proxy/accounts/hinson' claude, then /login.

To undo installation, disable `claude-login-keepalive.timer` and remove its timer
and service from `~/.config/systemd/user`, then daemon-reload. The operator can
roll back proxy code through the normal handoff. No credentials need restoring.

## Forge evidence, 2026-10-28

Only `hinson` was exercised. Its credential backup was made mode 0600 under the
mode-0700 task scratch directory before testing. No tokens were printed.

- Initial observation: `expiresAt=1793229498212`,
  `refreshTokenExpiresAt=1795269251212`.
- Before the controlled command, another process had already renewed it to
  `expiresAt=1793258006364`, `refreshTokenExpiresAt=1795269251364`.
  The access expiry advanced 7h55m; the refresh deadline drifted only 152 ms,
  consistent with a fixed refresh-token lifetime, not a renewed multi-day window.
  Attribution to the live proxy is an inference; it was running concurrently.
- `auth status` left both timestamps unchanged.
- The first `/usage` invocation used the shell's 2.1.263 and returned no structured
  usage report. Do not use that version for this feature.
- A controlled `/usage` on 2.1.302 returned a local usage report, zero turns,
  `total_cost_usd=0`, and both timestamps unchanged at the second values above.

The supported call was verified to be quota-free. A controlled expired-token
renewal was **not** observed because the live process renewed the account first.
No expiry metadata was fabricated to force renewal. The source confirms the
refresh path, but empirical before/after proof of that specific invocation and
long-term refresh-token lifetime behavior remain unverified. No Arch account,
live warning delivery, or installed timer was tested. Units were only rendered.
