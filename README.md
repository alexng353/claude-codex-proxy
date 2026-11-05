# Claude Codex Proxy

Use a Claude Pro, Max, or Team subscription as a custom model provider in Codex Desktop. This Bun server implements the OpenAI Responses API surface Codex uses and delegates inference to your authenticated Claude Code CLI.

> [!IMPORTANT]
> This is an unofficial compatibility bridge. It is not affiliated with OpenAI or Anthropic. Subscription access, usage limits, and permitted use are governed by Anthropic's current terms. The bridge intentionally calls the official `claude` CLI instead of extracting or forwarding OAuth credentials.

## How it works

```text
Codex Desktop ── Responses API ──> this local Bun server ── stdin/stdout ──> Claude Code CLI
```

The proxy converts Codex tool schemas into a structured-output request and translates Claude's answer or tool requests back into Responses API events. It supports Codex function/custom tools, namespaced tools, and the Desktop browser's computer-use loop, including screenshot feedback.

Claude is launched with a replacement system prompt, `--safe-mode`, empty setting sources, empty native tools, and an empty strict MCP configuration. Codex supplies the working instructions and tool registry. The CLI keeps subscription authentication but does not load the user's Claude hooks, CLAUDE.md, memory, output styles, or installed plugins. The structured-output bridge returns tool calls to Codex for execution.

## Requirements

- [Bun](https://bun.sh/) 1.2 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), logged in to a subscription account
- Codex Desktop or Codex CLI with custom model-provider support

Verify Claude authentication:

```bash
claude auth status
```

## Install and run

```bash
git clone https://github.com/alexng353/claude-codex-proxy.git
cd claude-codex-proxy
bun install
bun start
```

The server listens only on `127.0.0.1:3456` by default. Test it:

```bash
curl http://127.0.0.1:3456/health

curl http://127.0.0.1:3456/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","input":"Reply with exactly: hello from Claude"}'
```

## Configure Codex Desktop

Codex only accepts provider settings from the user-level config. Add this to `~/.codex/config.toml`:

```toml
model = "sonnet"
model_provider = "claude_subscription"
model_supports_reasoning_summaries = false

[model_providers.claude_subscription]
name = "Claude subscription (local proxy)"
base_url = "http://127.0.0.1:3456/v1"
wire_api = "responses"
request_max_retries = 1
stream_max_retries = 1
```

Restart Codex Desktop after changing the config. Use `opus`, `sonnet`, or `haiku` as the model. Full Claude model IDs beginning with `claude-` are also accepted. Exact `claude-opus-5-5` and `claude-sonnet-5-5` default to medium effort when a request sets none. Sonnet 5.5 needs Claude Code 2.1.284 or newer; 2.1.283 flags it as an unrecognized model and falls back to a 200,000-token window.

Codex caches model capabilities. After upgrading the proxy, quit Codex Desktop, remove `~/.codex/models_cache.json`, and reopen Codex so browser/plugin capability changes are fetched. Existing tasks retain the model instructions and tool world captured when they were created, so test browser changes in a new task.

To switch back, set `model_provider = "openai"` and choose an OpenAI model, or remove the added provider/default lines.

Provider settings cannot be placed in a repository's `.codex/config.toml`; Codex ignores project-local provider overrides for credential and routing safety.

### Sub-agents on other models

A spawned sub-agent inherits its parent task's provider; Codex changes only the model (`core/src/agent/child_config.rs`, 0.155). A task on `claude_subscription` therefore cannot run an OpenAI-model sub-agent: the request reaches this Claude-only endpoint and fails with `Unsupported Claude model`. The proxy never substitutes a Claude model. To mix models, put both behind one provider that dispatches by exact model. Alex's Linux setup does this with a local router at `openai_base_url`: tasks use the built-in `openai` provider, Claude requests reach this proxy, and GPT requests go to OpenAI unchanged. See [desktop/README.md](desktop/README.md).

### Claude sub-agents of a GPT-6 parent (multi-agent v2)

The model catalog gives every GPT-6 model `multi_agent_version: v2`. Under v2 a child gets its task as an `agent_message`: a plaintext header (`Message Type`, `Task name`, `Sender`) and the parent's message as `encrypted_content`. OpenAI encrypted that message for OpenAI models, and nothing on this machine can read it. For a Claude child, the proxy handles it as follows (`src/request.ts`):

- **A `NEW_TASK` whose task name ends in `__<key>`** (`<key>` is 8 to 32 of `[a-z0-9]`): the proxy reads `~/.cache/agent-tasks/<name>.md` in place of the encrypted payload. `AGENT_TASKS_DIR` overrides the directory. The file must be a regular file (not a symlink) that this user owns, with mode `0600` or stricter, at most 512 KiB, and a modification time within a day of now. The comb skill writes these files.
- **Anything else** (no key, a missing or refused file, or an encrypted follow-up or steer): the child is told the payload is unreadable. It must not guess, and it replies `BLOCKED: ...`.

Every such BLOCKED message is counted, after the request and never on it, in `blocked-tasks.json` in the state directory (`COMB_BLOCKED_STATE` overrides the path; `src/blocked-tasks.ts`). A message is keyed by its task name and encrypted blob, so a replay in a later turn counts once. A task served from its file is remembered too, so its replay after the file is deleted is not counted. The file holds the total, the `NEW_TASK` count on its own, and the first and last hit times. A new unreadable `NEW_TASK` can page a Today chat, at most once an hour:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `COMB_BLOCKED_PAGE_THREAD` | unset: count, never page | Today or Codex thread id to page. Nothing is sent without it. |
| `COMB_BLOCKED_PAGE_MACHINE` | this machine (`HYGIENE_GATE_MACHINE`, else the hostname) | The Today machine whose daemon has that thread. On another machine the page goes over `ssh <machine>`. |
| `HYGIENE_GATE_MACHINES` | `arch` | Comma list of machines that may be reached over ssh, shared with the hygiene wakes. A `COMB_BLOCKED_PAGE_MACHINE` not in it is refused. |
| `COMB_BLOCKED_PAGE` | on | `off` stops the sends and keeps counting. |

The page is `today-daemon send --from claude-codex-proxy --client-message-id comb-blocked-<ms> -- <thread> -`. It names this machine, the child model and thread, the task name, and the orchestrator's model and thread from Codex's `thread_spawn_edges` (`state_*.sqlite` under `CODEX_HOME`, `~/.local/state/today/codex-home` and `~/.codex`, or `COMB_BLOCKED_CODEX_HOMES`). Each field is one line, capped at 120 characters, without control or bidi characters. The hour is taken only by a page that was sent: while a page is being sent it is reserved for up to a minute, by a live process, and a failed send frees it. For example, on Arch paging a chat on Forge: `COMB_BLOCKED_PAGE_THREAD=<thread>`, `COMB_BLOCKED_PAGE_MACHINE=forge`, `HYGIENE_GATE_MACHINES=forge`.

A known limit: the file is read every time the conversation is rendered. A cold worker that re-renders the conversation after the orchestrator deleted the file (or after a day) sees the BLOCKED notice in place of the task. This was accepted: the reviewer has already acted on the task by then, and the orchestrator's nonce handshake rejects a read that never saw its prompt.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening address |
| `PORT` | `3456` | Listening port |
| `CLAUDE_BIN` | `claude` | Claude CLI executable path |
| `CLAUDE_CWD` | proxy process directory | Working directory used by each Claude subprocess |
| `CLAUDE_TIMEOUT_MS` | `900000` | Per-request timeout |
| `CLAUDE_SESSION_IDLE_MS` | `3300000` | How long an idle Claude process is retained (just under Claude Code's 1-hour cache TTL) |
| `CLAUDE_MAX_IDLE_WORKERS` | `8` | Idle Claude processes kept alive; the least recently used is closed first (~270 MB each) |
| `CLAUDE_SESSION_RETENTION_MS` | `3600000` | How long a persisted Claude session stays resumable before its mapping and transcript are deleted (Claude Code's cache TTL is 1 hour) |
| `PROXY_API_KEY` | unset | Optional bearer token |
| `PROXY_STATE_DIR` | `$XDG_STATE_HOME/claude-codex-proxy` or `~/.local/state/claude-codex-proxy` | `usage.jsonl`, the derived `usage.sqlite`, the `sessions.sqlite` session map, `limits-cache/` probe results, and `limits-history.jsonl` recorded samples; owner-only files |

Binding to a non-loopback address is rejected unless `PROXY_API_KEY` is set. If enabled, add `env_key = "CLAUDE_CODEX_PROXY_KEY"` to the provider and export the same value:

```bash
export PROXY_API_KEY='choose-a-long-random-value'
export CLAUDE_CODEX_PROXY_KEY="$PROXY_API_KEY"
```

### Multiple Claude accounts

The proxy uses the account `claude login` signed into first. When Claude reports that an account is rate limited (a `rejected` `rate_limit_event`, or a 429 result), the proxy marks it limited until its reset time and replays the turn on the next available account. Chats are durably pinned by `prompt_cache_key` (normally the root Codex session ID, shared with its subagents) to their selected account, including across proxy restarts, compaction, and transcript expiry. Authentication failures (401 or an explicit CLI authentication error) also replay the turn on another account, preserving the session checkpoint. The failing account is skipped for up to 15 minutes; updating its credentials after refresh or login clears that cooldown immediately; `/accounts` exposes this separately as `authFailedUntil`. If all accounts fail, the request returns an error after trying the available accounts. Other request errors do not trigger account switching. Successful failover updates the pin; a quota reset does not move an existing chat back. Pins refer to the configured account name. If the pinned account is removed, the next successful request pins an available account. If the pin database is unreadable or cannot record an initial assignment, threaded requests fail before inference rather than choosing an unverified account. A pin update failure after inference is logged and preserves the completed response. New requests without a thread ID use the first available account; existing live workers keep their account.

```bash
bun run account add work     # opens the browser to sign in a second account
bun run account list
curl -s http://127.0.0.1:3456/accounts   # which accounts are limited, and until when
bun run limits               # five-hour and weekly usage bars per account
bun run limits --probe --record --quiet   # append a fresh sample per account to limits-history.jsonl
```

`bun run limits` reads what the proxy last saw and supplements it with Claude Code's local `/usage` command, which also reports model-specific weekly meters such as Fable. This reads usage without generating a model response or spending model tokens. Query results are cached for five minutes to make repeat queries fast, expiring earlier when a quota window resets; `--probe` refreshes every account. Newer proxy observations update overlapping meters without hiding the cached model-specific meters; supplemented meters show their cache age. The display labels the source and observation age. Usage queries time out after 15 seconds, disable customizations, and do not save chats. They require Claude Code 2.1.282 or newer and structured `usage_report` data for `/usage`; unsupported versions report unavailable data instead of falling back to a model request. If a usage refresh fails, valid proxy data remains available. The `LIMITED` label comes from an explicit rejection observed by the proxy; local usage queries report percentages and reset times. Each proxy response also carries Codex's `x-codex-primary-*` (five-hour) and `x-codex-secondary-*` (weekly) rate-limit headers for the account that answered, so Codex's own usage display shows the Claude account.

Limit readings otherwise arrive only while an account is serving turns, so idle accounts have gaps. `--record` appends one line per account to `$PROXY_STATE_DIR/limits-history.jsonl` with the sample time, source, reset times, and each window's percentage; `--quiet` suppresses the display. Running `bun run limits --probe --record --quiet` from a five-minute systemd user timer gives a continuous history of every account.

`▶ ACTIVE` marks the account with the most recent activity observed by the running proxy, with that activity's age. Meter probes and cached readings do not move the marker. It is omitted when the proxy has no activity data or the most recently observed account is still limited. Chats can use different pinned accounts simultaneously; the marker identifies the latest observed activity, not a global account selection.

Failures and account switches are appended to `$PROXY_STATE_DIR/failures.jsonl` (default `~/.local/state/claude-codex-proxy/failures.jsonl`, mode 0600). Entries include UTC time, request ID, account, worker/attempt where available, failure category, numeric API status where available, and the next account for failover. Raw CLI messages, credentials, and conversation text are omitted. Logging failures do not interrupt requests.

The existing 12-minute usage probe also renews due OAuth access tokens on every account, including skipped accounts, without model turns. Refresh does not extend the refresh-token deadline. The proxy warns through Today when authentication fails and during the three days before `refreshTokenExpiresAt`; stale or already-past expiry metadata is silent. Warnings name the machine and give the account's exact sign-in command. For the default account without a config override this is `claude`, then `/login`; otherwise it includes `CLAUDE_CONFIG_DIR`.

`GET /accounts` includes `authFailedSince` (ISO timestamp or null), which persists until a successful authenticated check or turn clears the observed incident, and `refreshTokenExpiresAt` (epoch milliseconds or null). `authFailedUntil` remains the separate, temporary routing cooldown. An expired access token alone is not a broken login. A completed usage probe that returns no meters records a refresh suspicion when login credentials remain unchanged, a refresh token is present, and the access token was already expired by more than ten minutes before the probe started. The first strike logs “refresh not renewing; confirming” without a cooldown or warning. A later matching probe at least ten minutes later with the same credentials confirms the failure; its log includes the expired access-token timestamp. Meters, changed credentials, a successful turn, or token mode clear the suspicion. Meters with credentials different from those that opened an incident also clear that incident. Refreshed credentials, setup-token accounts, incomplete probes, and visible rate limits do not trigger this rule. Outside that completed-probe condition, unreadable credentials, transient refresh errors, and network failures remain unknown. Worker-exit stderr alone starts only a routing cooldown; a probe must confirm authentication failure unless the CLI has written its dead-login marker. Failed login incidents and warning delivery state persist locally by account name and directory; repeated warnings of the same kind are suppressed for six hours unless credentials change. Warnings are sent with `today-daemon send --from claude-codex-proxy`, so Today delivers them in the `script:claude-codex-proxy` envelope rather than as Alex's turn, and an armed hygiene gate lets them run. The sender executable can be overridden with `TODAY_DAEMON_BIN` (tests use a stub).

On a machine whose daemon runs with `--no-today`, set `TODAY_WARNING_SSH=forge`
(or another SSH destination hosting Today) in the proxy service environment.
Only the local “this daemon has no Today thread” error triggers this fallback.
It uses `ssh -o BatchMode=yes -o ConnectTimeout=5`, runs `$HOME/.local/bin/today-daemon` on the
remote host with that user's runtime socket, and sends the warning on stdin
with `--from claude-codex-proxy`. The service user needs working noninteractive
SSH authentication and a trusted host key. Local and remote attempts share a
10-second deadline. Failed delivery is logged once per incident and retried;
success retains the existing persistent incident deduplication. If Today accepts
a remote warning but SSH fails before confirming delivery, a retry can produce
a duplicate warning. Stderr capture is limited to the first 64 KiB. Unset the
variable to disable the fallback. `TODAY_DAEMON_BIN` overrides only the local
executable.

New account folders remain visible in status but cannot receive turns until a credentials file exists. A missing file starts a login-failure incident after a 15-minute grace period from the first failed observation, or immediately if the proxy previously observed a credentials file for that account.

An inherited `CLAUDE_CODE_OAUTH_TOKEN` is removed from the child environment before account-specific overrides are merged for CLI launches. The Today warning subprocess also strips inherited Claude OAuth, API, and CLI-session variables, as well as `CODEX_THREAD_ID`. This prevents one account's inherited token from overriding another account's login, while leaving room for explicit per-account token mode.

Each extra account lives in `$PROXY_STATE_DIR/accounts/<name>`. That directory keeps its own `.credentials.json` and `.claude.json`; every other entry is a symlink to your main Claude config. Because `projects/` is shared, a conversation can resume its transcript on another account. A switch still misses the prompt cache once, since each account has its own cache.

#### Moving pins

A local API edits pins (`thread_accounts` in `sessions.sqlite`, keyed by the Codex thread id, not the Today thread id). It changes pins only: fields naming account order, weekly caps, credentials or login get a 403.

Access is local and scripted only. Requests through a forwarded hop (Tailscale Serve) are refused like `/accounts`. The socket peer must be a loopback address (`127.0.0.0/8`, `::1`, or IPv4-mapped loopback), so a proxy bound beyond localhost (`HOST` with `PROXY_API_KEY`) still answers pins only to this machine; any other peer gets a 403. A request with an `Origin` header (a browser) gets a 403. The `Host` header must be `127.0.0.1:PORT` or `localhost:PORT`, which blocks DNS rebinding. A POST must send `content-type: application/json` (415 otherwise). A write needs `Authorization: Bearer <token>`, where the token is in `$PROXY_STATE_DIR/pins.token`; the proxy creates that file 0600 at startup. `PROXY_API_KEY` is also accepted, and when it is set, reads need a token too. Each machine has its own token, so a tunnel to another machine's port does not give write access there.

```bash
token=$(cat ~/.local/state/claude-codex-proxy/pins.token)
j=(-H 'content-type: application/json' -H "authorization: Bearer $token")
curl -s 127.0.0.1:3456/pins                     # every pin, its last turn, Today chat id and title
curl -s '127.0.0.1:3456/pins?account=val'
curl -s "${j[@]}" 127.0.0.1:3456/pins -d '{"pins":[{"threadId":"T","account":"default"}],"reason":"why"}'
curl -s "${j[@]}" 127.0.0.1:3456/pins/move -d '{"from":"hinson","to":"default","idleForMs":600000,"dryRun":true}'
curl -s "${j[@]}" 127.0.0.1:3456/pins/clear -d '{"threadIds":["T"]}'
```

Automatic callers can send `POST /pins` with `{"op":"init","pins":[{"threadId":"T","account":"default"}]}`. This initializes only threads with neither a current pin nor any retained pin generation, checking both and writing inside the same immediate transaction. The response's `pins` array reports the resulting accounts, including unchanged existing pins and `account: null` for a previously cleared pin. Concurrent or delayed initialization cannot overwrite a newer routing or failover pin or resurrect an explicit clear. Omitting `op` retains the existing unconditional set behavior; old proxies reject the unknown `op` field before writing, so callers must never downgrade a rejected init to a set.

A write is refused (409) in these cases:

- An account it moves threads onto or off does not share transcripts. Its `projects/<cwd slug>` must be a link to the default account's folder; otherwise the next resume fails with "No conversation found with session ID". Run step 1 of the claude-account-move skill first.
- The target account is unavailable now (rate-limited, over its weekly cap, or logged out), because the next turn would move the thread off it again. `force: true` pins it anyway and returns a warning.

`move` may start from an account that has been removed.

With `idleForMs`, `move` takes only threads whose newest turn is older than that. It skips threads with a turn running in any live proxy copy, with a warning naming the copy's pid. Each copy marks its running turns in `$PROXY_STATE_DIR/in-flight.sqlite` (not fsynced: a mark matters only while its process lives), so during a handoff each slot sees the other's. Marks left by a copy that died mid-turn are ignored and pruned once its process (pid and start time) is gone. A copy running code older than this table writes no marks, so the first handoff onto this code cannot see the old slot's turns. If the usage history or the in-flight table cannot be read, it returns 503 and changes nothing.

A write runs in one transaction:

1. If anything changes, it first saves the current pins and their generations as JSON to `$PROXY_STATE_DIR/pin-backups/pins-<time>-<reason>-<id>.json`. The file is written 0600 under a temporary name, fsynced, read back and compared, then renamed into place. The newest 50 backups are kept.
2. It applies the edits.

It returns `{backup, changed, changes:[{threadId, from, to}], warnings}`. If the backup or any edit fails, nothing changes. `dryRun` returns the changes without a backup or a write.

To put back the pins a backup lists (other pins stay as they are), use the `sqlite3` shell, which has `readfile`:

```bash
sqlite3 ~/.local/state/claude-codex-proxy/sessions.sqlite "INSERT OR REPLACE INTO thread_accounts
  SELECT json_extract(value, '\$.threadId'), json_extract(value, '\$.account')
  FROM json_each(readfile('BACKUP.json'), '\$.threadAccounts')"
```

Edits take effect on each thread's next turn, with no restart. A turn reads its pin and the pin's generation from SQLite when it starts; nothing caches them. At the end of the turn, it saves the account it ran on only if the pin still has that account and generation. Every API edit increments the generation, and a clear keeps it in `thread_account_generations`. So a turn that is running during an edit never undoes the edit, even an edit away and back to the same account.

### Per-chat agent names

A chat can have its own name. Then each turn tells the model `You are NAME, powered by MODEL (VENDOR).`, for example `You are Bubble, Alex's coordinator, powered by Claude Opus 5.5 (Anthropic).` The model and vendor come from the model that serves the request (`src/agent-identity.ts`). If the model ID does not name exactly one model, the proxy adds no line. Examples are an alias without a version (`opus`), a dated snapshot, or a `-latest` pointer. Chats without a name do not change.

- **Claude:** the line starts the system prompt file. Claude Code still sends its own fixed first line (`You are a Claude agent, built on Anthropic's Claude Agent SDK.`) before it. The subscription accepts only a few such prefixes, so the proxy cannot replace that line. A name change starts a new worker on the next turn.
- **GPT (through the model router):** the router already sends each GPT turn to `/hygiene/gate`. There the line replaces the first sentence of Codex's instructions (`You are Codex, an agent based on GPT-6.`), or goes in front if that sentence is missing. The router needs no change.

Names are stored in `sessions.sqlite` (`thread_agent_names`), keyed by Codex thread id. `/agent-names` uses the same access rules and token as `/pins`:

```bash
curl -s 127.0.0.1:3456/agent-names                       # every named chat
curl -s '127.0.0.1:3456/agent-names?threadId=T'          # {threadId, name|null}
curl -s "${j[@]}" 127.0.0.1:3456/agent-names -d '{"threadId":"T","name":"Bubble, Alex'\''s coordinator"}'
curl -s "${j[@]}" 127.0.0.1:3456/agent-names -d '{"threadId":"T","name":null}'   # clear
```

A name has 1 to 40 code points. It starts with a letter or digit and holds only letters, digits, spaces and `' , & -`. It cannot end with a space. Because `.`, `:`, `(` and `)` are refused, a name cannot end the sentence and start an instruction. The whole words `powered`, `model`, `GPT`, `Claude`, `OpenAI` and `Anthropic` are refused in any case, so a name cannot say which model or vendor it runs on; only the line itself says that. Today's `agent_identity.rs` checks the same rule.

Today owns the names. It keeps each name under its own thread id and writes it here through the MCP tools `get_agent_name` and `set_agent_name`. The CLI `today-daemon get-agent-name` can read a name. Today's tools let only Today's own chat tools and the engine's own MCP process of a full-access chat set a name, and never for the calling chat itself. Today keeps a name only after this API has accepted it. When Today replaces a chat's engine thread, it posts the name for the new Codex thread and clears the old one.

This is a guard in Today's tools, not a security boundary. A process that can read this machine's `pins.token` can write `/agent-names` directly, and a full-access chat can read it. Today's `machine_read_file` refuses that file, but a shell can still read it.

### Live usage dashboard

Run `bun run dashboard`, then open [the local dashboard](http://127.0.0.1:3458). It shows the last 24 hours of overlapping quota lines, output tokens by model, and input/output/cache percentages. The page refreshes every 30 seconds while visible, or immediately with **Reload**. It reads `limits-history.jsonl` and `usage.sqlite` without changing them or making model requests. Keep the five-minute quota recorder running for fresh observations. The timestamp shows when data was loaded; quota observations can be older and gaps are left open. Failed refreshes preserve the last successful view and display an error.

The dashboard always binds to `127.0.0.1`; `DASHBOARD_PORT` defaults to `3458`. It uses a separate process so it can be restarted without interrupting inference. To keep it available after login, install a systemd user service with `WorkingDirectory` set to this checkout and `ExecStart` set to the absolute Bun path followed by the absolute path to `scripts/dashboard.ts`, then enable it with `systemctl --user enable --now claude-usage-dashboard.service`. The chart library loads from jsDelivr when the page opens.

## Supported API

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`, streaming and non-streaming
- Assistant message phases: `commentary` for text accompanying tool calls, `final_answer` for text-only replies
- Text input and multi-item agent history
- Function, custom, and namespaced tool calls
- Parallel tool calls
- Codex Desktop computer/browser actions and screenshot results
- Codex plugin, app, skill, and Node/CUA REPL capability metadata
- Client-side `tool_search` discovery for deferred Codex MCP/plugin tools
- Codex remote compaction (v2): a request whose input ends in `compaction_trigger` returns exactly one `compaction` item holding Claude's handoff summary, written with Codex's own compaction prompt. When that item returns in a later history, the proxy expands it into the summary message Codex would have kept after local compaction. A compaction item another provider encrypted cannot be read, so the request is rejected with HTTP 400 rather than dropped.

## Current limitations

- Streaming is protocol-compatible SSE, but Claude's text is emitted after its structured response completes rather than token by token.
- Browser screenshots and `input_image` parts are forwarded as native image content blocks. File input parts are not implemented.
- OpenAI-hosted tools are not reimplemented by the proxy. Codex-local tools are passed through. Native Claude tools are disabled.
- Codex-provided browser, search, app, plugin, and MCP tools remain available through the Responses tool loop.
- Claude processes are retained after every turn, including final answers and tool searches. A request continues a retained process only when its model, effort, instructions, and base tools match and its input extends exactly the history that process has seen; the process then receives only the new items, so Claude Code's prompt cache keeps hitting. Edited, forked, or compacted histories start a fresh process. Idle processes expire after `CLAUDE_SESSION_IDLE_MS`.
- Every process runs as a persisted Claude Code session. `sessions.sqlite` maps each session to a hash of the Codex history it has consumed. When a conversation's process is gone (idle expiry, crash, or proxy restart), the proxy starts `claude --resume <id> --fork-session` and sends only the new items. Resuming replays the exact message history, so the first turn still reads the whole conversation from Anthropic's cache; re-sending the history as one flattened message would miss it. Sessions and their transcripts in `~/.claude/projects/` are deleted after `CLAUDE_SESSION_RETENTION_MS`. If a resume fails, the proxy replays the full request once in a fresh session.
- The structured-output schema does not enumerate tool names, because it heads the cache prefix and tool search adds tools mid-conversation. Tool names are validated after each reply, and unknown names are corrected inside the same process.
- A new process receives Codex's instructions, base tool registry, and the context items Codex opens every task with (developer messages, then the user message carrying `<recommended_plugins>`, AGENTS.md, and `<environment_context>`) in its system prompt, through `--system-prompt-file`, written once per distinct content under the state directory. Only the rest of the conversation goes in its first message; items after that context run, such as a session-start hook's output, stay there so they do not make each task's system prompt unique. Claude Code ends the system prompt with a cache breakpoint, so a different conversation with the same instructions and tools reads that prefix from cache instead of writing it again. Measured 2026-09-29 on Opus 5.5 with a ~50k-token prefix: the second of two different new conversations read 49737 and wrote 470. With the prefix at the head of the first message, every new conversation and subagent re-wrote it.
- Responses usage reports only Codex-visible request and output content. Claude Code's private system prompt, native tool schemas, plugins, MCP definitions, and cache activity are intentionally excluded so Codex does not compact its conversation based on hidden subprocess overhead.
- Claude Code changes can affect compatibility because its CLI JSON format is not a stable third-party provider API.

## Development

```bash
bun run check
```

Tests use a fake Claude executable and do not consume subscription quota. A manual live smoke test requires an authenticated Claude Code installation.

## Security

- Prompts go to Claude through stdin, never through a shell.
- The proxy never reads or exposes Claude OAuth credentials.
- Every inference subprocess retains `--dangerously-skip-permissions`, but native tools and customizations are disabled. Actual tools execute through Codex and use Codex's configured permissions. Admin-managed Claude policy remains applicable.
- Keep the server bound to localhost unless you add a bearer token and understand the network exposure.
- Requests are scrubbed of credentials before anything else sees them (`src/scrub.mjs`). Known values are read into memory at startup from `~/.config/zsh/secrets.zsh` (sourced in a clean `zsh -f` with tracing off) and `~/.config/spotlike/env`, and become `[REDACTED:NAME]`. Override the list with `SECRET_SCRUB_FILES` (colon-separated; `.zsh`/`.sh` files are sourced, others parsed as `KEY=VALUE`). Changed files are reloaded within 5 seconds, and retired values stay redacted until restart. Token shapes are redacted even when unconfigured: GitHub, npm, Hugging Face, AWS key IDs, Mailgun, `sk-` API keys, Slack, PEM private keys, and credential-named assignments such as `CF_API_TOKEN=...`, which is how `set -x` prints them. Opaque `encrypted_content`, `data:` URLs, and tool schemas are skipped. Scrubbing about 1.4 MB of history takes about 13 ms. The Codex model router imports the same module, so GPT requests are scrubbed as well. `SECRET_SCRUB_DISABLE=1` turns it off.

## Attribution

Inspired by [wende/claude-max-api-proxy](https://github.com/wende/claude-max-api-proxy). This project differs by targeting Codex's Responses API, including Codex Desktop's browser computer-use protocol.

## Cache behavior and diagnostics

`usage.jsonl` records every Claude result, including errors, with UTC timestamp, request ID, worker ID, worker turn number, retry attempt, model, effort, Codex thread ID (`prompt_cache_key`), Claude session ID and fork parent, durations, raw `usage`, and `modelUsage`. It does not contain prompts, responses, screenshots, or credentials. Missing usage remains null; it is not fabricated as zero. Logging failures go to stderr without dropping completed inference.

### Usage history

`usage.sqlite` holds one row per Claude turn in the `turns` table, derived from `usage.jsonl`. The proxy syncs it after each turn by byte offset, so deleting the database rebuilds it from the log, including rows written before it existed. The `usage_hourly`, `usage_daily`, `usage_weekly` (Monday-start, local time), and `usage_by_thread` views aggregate turns, errors, input/output/thinking tokens, cache reads and writes, cache hit ratio, cost, and duration.

```bash
bun run usage                  # last 14 days: daily, per model, per turn, top threads
bun run usage --days 30 --threads 20
bun run usage --json
sqlite3 ~/.local/state/claude-codex-proxy/usage.sqlite 'SELECT * FROM usage_daily'
```

`cost_usd` is Claude Code's API-list-price equivalent for that turn, not a subscription charge or a share of a subscription limit. Claude Code reports `modelUsage.costUSD` cumulatively per process, and a `--resume` fork inherits its parent's totals, so summing raw `costUSD` values overcounts. Each turn's cost is its cumulative cost minus the cumulative cost it started from: the worker's previous turn, or, for a first turn, a unique matching checkpoint for the same model and recorded parent session (or zero for a fresh process). Legacy records without session ancestry require a unique matching baseline. Unknown or ambiguous starting totals leave `cost_usd` null and reported as unpriced rather than guessed.

Stable instructions and a canonically ordered tool registry precede changing conversation content. Tool schema keys are sorted. Ordinary tool results reuse the existing worker and omit the instructions and registry already in its history. Changes in model, effort, instructions, or tool definitions require a fresh worker; a mere reorder of tools does not. Tool discovery currently requires a fresh worker so the new structured-output schema includes discovered tools.

`--no-session-persistence` disables disk transcripts; it does not disable prompt caching or in-memory tool continuation. Fresh-worker requests can still reuse a stable provider cache prefix. Cache hits depend on the provider, prefix identity, and expiry; no fixed hit rate is promised for arbitrary conversations.

Measured on 2026-09-27 with Claude Code 2.1.283 and exact Opus 5.5: three identical fresh requests used cache read/write tokens of 99076/29572, 99076/29576, 99076/29573 before cleanup, versus 0/9798, 9798/0, 9798/0 after. A two-call tool loop after cleanup read 10236 and created 180 on the continuation. These are a controlled synthetic workload, not estimates of all production traffic or billing.

### Local Codex Desktop customizations

Alex's existing Linux desktop integration has an incremental
[model-label and effort-slider patch](desktop/README.md). The optional
[restart-codex-desktop skill](skills/restart-codex-desktop/SKILL.md) restarts the
Arch/Hyprland app in an independent job and verifies that its window returns.
The restart helper's safety checks run with
`python3 -m unittest discover -s test -p '*_test.py'`.

### Repeated Codex context

The proxy keeps the first skills catalog and turns later compatible catalogs into
updates containing changed entries and removals. It resolves new paths without
reassigning earlier root aliases. Repeated memory is suppressed only when no
intervening instruction can change its precedence. User messages, tool results,
unknown catalog formats, and server-side incremental requests are preserved.

Normalization runs before worker selection. Existing sessions whose stored
prefix predates normalization keep their original history so they can resume;
this does not retroactively remove duplicates from a cached Claude transcript.

`src/context.mjs` exports the shared `normalizeContext(request)` interface used
by the Codex model router. It preserves the request object when no rewrite is
needed and otherwise returns a new request without mutating the original.
The router loads this module from `CLAUDE_CODEX_PROXY_DIR` (default
`~/.local/share/claude-codex-proxy`). Update the proxy before dependent router
patches, and restart both services when this module changes.

## Plate dashboard activity

For the Codex threads listed in `~/.config/claude-codex-proxy/plate-activity.json` (override with `PLATE_ACTIVITY_CONFIG`), the proxy appends a `<plate-activity>` block to Alex's newest message. The block summarizes what changed on his [plate dashboard](http://127.0.0.1:4717) since his previous message, so the model sees it without calling a tool:

```json
{ "threads": ["01a10494-b499-7af3-986b-3c30d8c94b91"], "plateUrl": "http://127.0.0.1:4717" }
```

The file is re-read when it changes, so no restart is needed to change scope. A thread is matched by `prompt_cache_key`. Codex sets it to the thread ID.

- **Events:** Read from plate's `GET /api/events?since=<id>`. Everything Alex did is included except `chat-message`. From agents, only finished items (`done`, `resolved`) are included, listed by key. When a thread first enters scope, its cursor starts at plate's newest event, so old history is never sent. If nothing relevant happened, no block is added.
- **Hygiene gate:** Gate outcomes join the same block on their own line, each with its local time: a photo accepted (with the check it filled, such as night teeth or shower) or rejected (and why: a copy, a stale timestamp, or no proof seen) when it was meant as a proof (sent through Cairn, classified as teeth, shower or penance, or sent while the gate was locked; other images say nothing), BYPASS with what it skipped, and DELAY. They come from the gate's state, so they cover photos sent through Cairn as well as through chat. Image bytes, file paths and the classifier's description of the photo are never included. Their cursor is a time. Each read looks back five minutes, because a photo is timed from when its check started, and skips events an earlier block already reported.
- **Prompt cache:** Codex replays history without injected text. The proxy therefore stores each block by thread and message key in `$PROXY_STATE_DIR/plate-activity.sqlite` and re-applies it to the same message on every later request, including older messages in the history. A message key is a hash of the message's content plus how many earlier messages have identical content. A message with nothing to report is stored too, so events that arrive mid-turn wait for the next message instead of changing one already sent.
- **Cursor:** The cursor advances only after Claude returns a successful response. A retry gets the identical block. If a turn fails and Alex sends another message, its events move to the newer message. Compaction requests re-apply stored blocks but never create one.
- **Failure:** If plate is unreachable, the turn proceeds unchanged and the events wait for the next message. Logs record only error names, never event or note text.
- **Router:** The logic in `src/plate-activity.mjs` does not depend on the model, so the Codex router can import it like `scrub.mjs`. Today only this proxy applies the block, which covers Claude models, including requests that arrive through the router. A block that is already present is left alone, so a later router hook will not create duplicates.

## Hygiene gate

Alex asked for this: agents refuse to work until he sends a photo proving he brushed his teeth, showered or weighed himself. It covers every chat through this proxy, on both the Claude path and the GPT path through the Codex model router.

**Kill switch.** `touch ~/.local/share/claude-codex-proxy/hygiene-gate/disabled` turns the gate fully off at once, with no restart. Delete the file to turn it back on. While it exists, the gate changes nothing: no locks, no notes, no photo rewriting.

### Daily rules (America/Vancouver)

- **Morning teeth.** From 05:00, the first gated turn is locked until a teeth photo passes.
- **Morning weigh-in.** From 05:00, a photo of the bathroom scale with a legible reading is also required. The classifier reads the number; it is kept with the proof and returned in status and the daily photos, but never in the Today activity block. The weigh-in is enforced only from `weighInStartsAt` in the state file; without that field it is off. A missed weigh-in does not carry past midnight.
- **Morning creatine and outdoor walk.** From 05:00, a photo of creatine being taken (a scoop of powder, or the scoop or glass) and a 15-minute outdoor walk are also required, each only once its own state field is set (`creatineStartsAt`, `walkStartsAt`). The walk is two outdoor photos: the first starts it, and one the gate checks at least 15 minutes later finishes it. The 15 minutes run on the gate's receipt time, not the camera clock, because Today chat attachments arrive without EXIF. A near copy of the start photo is rejected like any reused proof. Neither carries past midnight.
- **Night teeth and shower.** Both are due by midnight. A shower photo counts any time that day. A night teeth photo counts only from 17:00, so the morning photo cannot stand in for it. If either is missing at 00:00, the gate locks until it arrives. Clearing that lock does not cover the morning: after 05:00 the morning teeth photo is still needed. One photo fills one requirement.
- **Locked.** The turn is not sent upstream. The proxy answers with a short final answer, such as `🪥 gate armed: morning teeth photo`, in the client's own format: SSE or JSON on the Claude path, SSE, JSON or websocket frames on the GPT path. The router then closes a GPT websocket, so Codex reconnects instead of chaining to a response OpenAI never saw.
- **BYPASS.** Each lock has its own three-word phrase, shown in the lock text: `Send a fresh photo to unlock, or reply BYPASS maple river otter.` (src/bypass-phrase.ts; Alex, 2026-11-04, so BYPASS is never a reflex). Only that exact line opens the gate (case, extra spaces and a trailing full stop don't matter); a bare `BYPASS`, a typo or an earlier lock's words get the lock text again with the current phrase. A lock keeps its words while any slot it was shown for is still due, so a lock that grows keeps them; once the gate opens (photo, BYPASS, DELAY, the app shield's emergency button) or a lock with none of those slots arms, the next lock gets new words, and retired phrases are never issued again. The right phrase opens the gate for one hour, adds one to the bypass counter, and opens a debt. On Alex's next gated turn in each chat, a hidden note asks the model to find out why and to rule on it with `POST /hygiene/debt/<id>/resolve`, sending either `{"verdict":"justified"}` or `{"verdict":"unjustified","penance":"<photo task>"}`. An unjustified ruling locks the gate until a photo matching the penance passes. BYPASS does nothing when the gate is already clear. A bare `BYPASS` or a full `BYPASS w1 w2 w3` is answered in every state; looser shapes (`BYPASS please`, a phrase with a typo) count as attempts only while the gate is locked, so a clear or open gate never swallows a message. Text that only starts with "bypass" ("bypass the cache in foo.ts") is always an ordinary message.
- **DELAY.** A message that is exactly `delay` (any case, surrounding spaces ignored) postpones the morning requirements (teeth and, when enabled, the weigh-in, creatine and walk) by two hours. It works once per morning, only between 05:00 and 12:00, and only when morning photos are the only locks. Otherwise the reply points to BYPASS. Delays have their own counter and open no debt. During the window, each of Alex's messages carries a hidden note asking the model to end its reply with a one-line reminder. The delay ends once every morning photo has passed. When the window expires first, the gate locks again for whatever is missing.
- **MOVE / LATER.** A reschedule, not a skip (Alex, 2026-11-05: "a lot of the reason I use bypass is to move things around now"). `LATER 18:30` moves every photo requirement that locks now to 18:30 today. `MOVE teeth 21:00`, `MOVE morning 10:00`, `MOVE night teeth 02:00` (last night's overdue teeth, after midnight) or `MOVE gym 19:00` name what moves (words: teeth, morning, night, shower, weight, creatine, walk, gym, all; an optional `to`/`at` before the time). Times must be clock-shaped: 24-hour `HH:MM`, `6:30pm` or `6pm`, on the phone's local day; a bare number (`move 2`) is an ordinary message. The reply is only that exact shape, so "later today I'll fix it" stays an ordinary message, and an unnamed `LATER` counts only while something locks, so a clear gate never swallows "later 5pm". Movable: this morning's requirements (also before 05:00, by name) and last night's overdue teeth and shower; tonight's photos are already due by midnight; a penance or a gym miss never moves. A move must land later today, after the item's current due time (an open DELAY counts as that time), and each item moves at most twice a day; another day, a time already past or a third move is refused with the reason and the lock's BYPASS line. A move opens the gate at once when nothing else locks, adds nothing to the bypass counter and opens no debt. Photo moves are logged in the state's `moves` (`slot`, `from`, `to`, `by`, `at`), gym moves on their plan's log; both show in the Today activity block and in Cairn's status `moves`. A creatine or walk photo for a moved requirement counts even while the gate is open. A move is a promise: if the day ends with the photo still missing, and no BYPASS of that item was charged that day, the next gated turn or phone status read charges an open debt (`source: "move"`) that the model rules on like a BYPASS. `MOVE gym 19:00` moves today's next plan later with `gym.ts` `reschedulePlan`, which also takes every edit of today's plan (gym MCP and `/hygiene/gym` included; plans for later days still move freely): same day, twice a day, never while a Start at the gym is open, and a plan that has started moves only before its start-by time (start + grace), so a move never erases a miss. A started plan stays started after a move: its cancel still counts as a miss and no pause can reach back over it. The lock text for photo requirements ends with a one-line LATER hint. Cairn's Move button calls `POST /hygiene/api/v1/move` (docs/hygiene-api.md).
- **Held messages wake their chat.** Each message the gate answers with its lock text is recorded in `hygiene-held.json` beside the state file (time, scrubbed text, count of non-proof attachments, and the follower's machine when one asked). Only Codex thread ids (UUIDs) are held. When the gate opens (a photo accepted in chat, through Cairn or a queued recheck, BYPASS or DELAY), every other chat with held messages gets one `today-daemon send --from hygiene-gate --client-message-id hygiene-unlock-<unlock ms>-<chat hash> -- <thread> -` listing them, which starts a turn there; a retry with the same id never posts twice. A follower names its machine on each decision (`x-hygiene-gate-machine`, from `HYGIENE_GATE_MACHINE` or the hostname), and a chat held from another machine is woken there with the same command over `ssh <machine>`. Only machines in `HYGIENE_GATE_MACHINES` (comma list, default `arch`) are reached over ssh; any other name a follower sends is treated as this machine. The chat whose own message opened the gate gets the list as a hidden note on that turn instead. Nothing held means nothing is sent. Held messages leave the store in the step that queues their wake, so a second unlock wakes nobody. Messages held more than 24 hours are dropped, and the wake or note says how many; a chat with nothing fresh left is logged instead of woken. Failed sends retry every 30 seconds with backoff for up to a day; an unknown thread is dropped and logged. `HYGIENE_GATE_WAKE=off` stops the sends.
- **Photo being checked.** While a photo check is running and the gate is armed, a new message without its own photo gets `📸 photo received, checking` at once. It is held like a locked message instead of waiting behind the check and locking again. The check is marked in `hygiene-checking.json` so both copies see it during a handoff. If that check finished and released before the hold was written, a release queued behind the gate's lock picks the message up.

### Gym sessions (decided by Alex 2026-11-02)

Alex plans gym sessions; an agent records them for him. Uplifting, his lifting app, reports where his phone was when he tapped Start and Finish, and the finished workout. Rules are in `src/gym.ts`.

- **A plan** has a start and a grace (default 30 minutes; `grace` changes it for new plans). If Uplifting has no Start within 150 m of Gold's Gym West Broadway between three hours before the start and start + grace, the gate locks: `💪 gate armed: gym session planned Thu, Nov 5 18:00 (no Start at the gym by 18:30)`.
- **A Start at the gym in time** holds the plan open until the Finish arrives. The session keeps the plan if it lasted at least 45 minutes, had at least 6 sets, and the phone was at the gym at Start and at Finish. Otherwise it is a miss with the reason. A Start with no Finish after four hours is a miss.
- **A gym photo** (Alex, 2026-11-02) stands in when Uplifting has no location (an old build, GPS off). A photo sent in any chat while a plan can use it, with a camera time under 30 minutes old and EXIF GPS within 150 m of the gym, is recorded as a Start (distance only; the archived copy has its GPS removed). Each photo backs at most one session: the one it was taken during, else one starting within 15 minutes after it, never one that had already ended. A far Uplifting location at either end still fails the session. Replays and near-copies add nothing.
- **A miss locks for 24 hours at most** after it failed (Alex, 2026-11-02). It then stays missed and can still be made up; a make-up clears a miss that still locks before a lapsed one.
- **A miss** locks until a qualifying session (any later one, planned or not, as a make-up). BYPASS opens the gate for an hour, as for photos. One session clears one plan, and a session can keep only a plan that existed (or was last moved) before it started, so adding a plan never takes the session that made up an older miss.
- **Moving and cancelling.** Before the planned start, a plan can be moved or cancelled. After it, a move is refused and a cancel is logged but still counts as a miss. Every add, move and cancel is logged with who asked.
- **No lock without evidence.** A plan counts as missed only once the gate has read Uplifting after it failed (its deadline, or the end of an unfinished Start's four hours). A miss locks only while the last read succeeded and is under 10 minutes old; a failed or stale read fails open for the gym (photos are unaffected). Before deciding a human turn with a deadline passed, the gate reads Uplifting if its last read is over a minute old; the whole wait, including the gate's lock, is capped at 5 s, and it is skipped while a photo is being checked. The poller never throws: a broken state file or a failed read is logged. A phone with no signal at the gym can still lock the gate at the deadline; the lock clears when its Start arrives, because the gate uses the phone's tap time.
- **Reading Uplifting.** `src/gym-sync.ts` polls `GET /api/v1/gate/feed` every two minutes while there are plans, on the authority only. Each read reaches back 14 days, or to the oldest unresolved plan's window (at most 60 days, the feed's limit). The token is Uplifting's read-only gate token, from `UPLIFTING_GATE_TOKEN` or `$PROXY_STATE_DIR/uplifting-gate.token` (mode 600); `UPLIFTING_GATE_URL` overrides the API. The gate keeps each check-in's distance from the gym, never its coordinates, and records each finished workout once, so editing it later changes nothing. Kept plans are settled before their sessions age out after 60 days.
- **Plans from agents.** `bun scripts/gym.ts status | add "2026-11-05 18:00" | move ID WHEN | cancel ID | grace MIN | sync`. Times are Vancouver wall time or ISO with an offset. The same is an MCP server, `bun src/gym-mcp.ts` (tools `gym_status`, `gym_plan_add`, `gym_plan_move`, `gym_plan_cancel`; `GYM_BY` names the caller in the log). Routes: `GET /hygiene/gym`, `POST /hygiene/gym/plans`, `/plans/<id>/move`, `/plans/<id>/cancel`, `/settings`, `/sync`, local only like the rest of `/hygiene`.
- **Hand credit.** `bun scripts/gym.ts credit --start T --end T --reason TEXT --by NAME` records a session verified outside the gate (such as one before Uplifting sent locations). The session must already have ended. It is on the CLI, not the MCP server, so chats aren't offered it; like the rest of `/hygiene` the route is trusted local access, not a security boundary.

### Which turns are gated

Only turns Alex types. Codex puts `x-codex-turn-metadata` in the body's `client_metadata`, which the router forwards unchanged.

- **Exempt by trigger.** Turns whose `turn_trigger` starts with `automation_` (heartbeats, cron, and scheduled one-shot tasks), `app_tool_send_message` and `app_tool_create_thread` (agent-to-agent prompts), `exec`, `code_review`, resume and onboarding triggers, and the other app-initiated triggers listed in `src/hygiene.ts`.
- **Exempt by thread, request kind or content.** Turns in a `subagent` thread, any `request_kind` other than `turn`, compaction requests, and turns whose new user messages are all Codex wrappers (`<heartbeat>`, `<codex_delegation>`, `<subagent_notification>`, environment context and similar). Other chats and scripts are recognised by the `<codex_delegation>` envelope Today wraps them in. A bare tag such as `[agent]`, `[from ...]` or `[ship-arch.sh]` is not exempt, because Alex can type one.
- **Timers.** A timer must send with `today-daemon send --from NAME`. Today then delivers it as `script:NAME` in the delegation envelope, which is exempt. A timer tag in the text (`[timer daily 08:00]`) is not enough, because Alex can type one.
- **Today summaries.** `/summary` and automatic summaries run in side threads that have no tools. Today's daemon starts their developer instructions with the line `<today-side-call/>`. The gate exempts a request only when a developer part starts with that line, unless the turn's trigger is in `extraGatedTriggers`. Today escapes `<` in every copy of earlier conversation, refuses to fork a side prompt, and the marker counts only at the start, so no other chat can carry it. A summary can't act and never counts as Alex's turn, so it cannot unlock the gate. A Today daemon without the marker leaves summaries gated, which is the safe direction.
- **`/btw` stays gated.** A `/btw` side prompt has tools, so it could dispatch work past the gate. Today does not mark it, and the gate answers it like any turn of Alex's.
- **Gated.** Every other trigger is treated as possibly human, including `composer`, queued messages, edits, and triggers the gate has never seen, such as a future mobile client.
- **Continuations.** A request whose input ends in model output or tool results is a continuation of a turn that was already let through, so a long turn started before 05:00 keeps running.

### Proof checks

1. **Hashes.** Every image in Alex's new messages gets a SHA-256 and a 256-bit dHash, computed with ImageMagick. An exact copy of an accepted proof is rejected, and so is one within 10 bits of an accepted proof. On 30 of Alex's photos, re-encoded copies measured 0–9 bits apart; consecutive burst frames measured 10 or more.
2. **Content.** A separate one-shot `claude -p --model haiku` call returns a JSON verdict: `teeth`, `shower`, `weight`, `creatine`, `walk`, `penance` or `none`, plus the scale `reading` for `weight`. It runs with no session, tools or customizations. A verdict needs confidence 0.6 or higher. On 2026-10-07 the live call took about 5 seconds and classified a real brushing photo as `teeth` with confidence 0.98. If the call fails, the turn stays locked, and the photo can be resent.
3. **EXIF.** If the photo has a capture time, it must be within 30 minutes of sending. Mobile uploads have none, and that is not a failure.
4. **Storage.** Accepted photos are saved byte for byte, with EXIF intact, to `~/Documents/private/hygiene/YYYY/MM/DD/<kind>-<HHMMSS>-<sha8>.<ext>` in Vancouver time. Directories are mode 700 and files 600; override the location with `HYGIENE_PHOTO_DIR`. Rejected photos are never saved. The index in `$PROXY_STATE_DIR/hygiene-gate.json` keeps hashes, times, kind, verdict, requirement slot and saved path for 400 days.

Photos that passed, or that looked like a bathroom photo, never reach the working model. In every request the gate replaces them with a fixed marker such as `[hygiene-gate: photo accepted as morning teeth (Oct 7) proof; image withheld]`. Hidden notes are stored against their message and replayed byte for byte, using the same message key as plate-activity. Both keep the prompt cache intact.

### State, status and operations

- **Status.** `curl -s http://127.0.0.1:3456/hygiene/status` reports `state` (`armed`, `clear`, `bypassed` or `disabled`), outstanding and due-today requirements, the bypass count, `delay` (`active`, `expires_at`, `count`), open debts and recent proofs.
- **State file.** `hygiene-gate.json` is re-read when it changes, so it can be hand-edited without a restart. `startsAt` sets the first arm: nothing that arms earlier is enforced. `weighInStartsAt` does the same for the morning weigh-in, which is off while the field is absent; `creatineStartsAt` and `walkStartsAt` work the same way. `extraGatedTriggers` (for example `["exec"]`) temporarily gates `codex exec` turns for live checks. Only the proxy writes the file.
- **Failure behaviour.** A gate bug fails open: the request is forwarded unchanged and an error is logged. A broken state file fails open the same way. If the proxy is down, the router forwards GPT turns ungated.
- **Several machines.** One proxy holds the gate; others set `HYGIENE_GATE_REMOTE` and follow it. See [docs/hygiene-remote.md](docs/hygiene-remote.md).
- **Cairn API.** `/hygiene/api/v1` lets Cairn send proofs and read status and the daily photos. It authenticates with Cairn relay device tokens and is the only path reachable through Tailscale Serve (`https://arch.taildf19.ts.net:4720`). The contract is in [docs/hygiene-api.md](docs/hygiene-api.md).
- **Router.** The router (`~/.local/share/codex-patches/router`) imports `src/hygiene-events.mjs` and asks `POST /hygiene/gate` about GPT `/responses` requests and websocket `response.create` frames. Claude requests are gated inside `/v1/responses`. Restart both services when the gate changes.
- **Tests.** `bun test test/hygiene.test.ts test/hygiene-gate.test.ts` covers the rules, exemptions, hashing, BYPASS, debt and penance, DELAY, the kill switch, and locked replies on both paths. All use an injected clock and classifier. Run the router's suite with `node --test router.test.mjs`.

### Long-lived subscription tokens per account

An account can use a `claude setup-token` token instead of its saved login.
The proxy reads `oauth-token` from that account's config directory:

| Account | Token file (default paths on Forge and Arch) |
| --- | --- |
| `default` | `~/.claude/oauth-token` (or `$CLAUDE_CONFIG_DIR/oauth-token` if the proxy sets that variable) |
| Named account | `~/.local/state/claude-codex-proxy/accounts/<name>/oauth-token` (under `$PROXY_STATE_DIR/accounts` when overridden) |

The file must be a regular file owned by the proxy user, with one hard link and **exactly mode 600**. Symlinks, empty files,
and unreadable or incorrectly permissioned files are refused; they do not fall
back to login. Token files and their metadata are private to each account and
are never linked into another account. Remove the token file to return to the
existing login. This does not change account order, caps, or pins.

The proxy strips ambient authentication variables first, then supplies only that
account's token as `CLAUDE_CODE_OAUTH_TOKEN` to workers, usage probes, memory
summarizers, and hygiene classifiers. In token mode the proxy does not read
`.credentials.json`. Tokens have no refresh cycle and do not receive the
three-day refresh-token warning. `/accounts` exposes `authMode` (`token` or
`login`) and `tokenExpiresAt` (Unix milliseconds or `null`); usage probe logs
include the mode and known expiry without the token.

**CLI behavior checked on 2026-10-28:** both the pinned 2.1.302 and shell 2.1.263
support `setup-token`. Their bundled code requests 31,536,000 seconds (365 days)
and only `user:inference`, prints the token, and skips normal login persistence.
There is no logout or revocation call in that setup-token completion branch;
server-side effects on existing logins were not tested. The token is opaque, so
its actual expiry cannot be decoded from its text or inferred from file mtime.

Both versions gate subscription usage fetching on `user:profile`, which these
tokens lack. The pinned CLI's local `/usage` probe can therefore return no
meters; shell 2.1.263 is also below the proxy's minimum version for safe headless
`/usage`. A usage endpoint scope refusal (403) stays unknown, not an auth failure.
Normal turns still provide rate-limit events. Token mode cannot promise fresh
idle-account usage meters. No live token was created or tested for this change.

#### Alex: create and install on each machine

Repeat these steps **on Forge and on Arch, once for each account**. Alex must do
the browser sign-in. Do not send tokens through chat, shell history, or logs.

1. In a private terminal, choose the account's directory. For default use
   `account_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`; for a named account use
   `account_dir="${PROXY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/claude-codex-proxy}/accounts/<name>"`,
   replacing `<name>` with the existing account name. Check the proxy service's
   configured paths if they differ from your shell.
2. Run `CLAUDE_CONFIG_DIR="$account_dir" claude setup-token`. On Forge, use
   `/home/alex/.local/share/claude/versions/2.1.302` in place of `claude` to match
   the pinned proxy. In the browser, select the intended subscription account;
   the directory name does not choose the browser's account. Finish that one
   sign-in and keep the displayed token private.
3. Run this installer in the same terminal. Paste the displayed token at its
   hidden prompt. Supply an expiry only if known, as a UTC ISO timestamp such as
   `2027-10-28T21:51:00Z`; leave it blank otherwise. It creates the token with mode
   600, and replaces any old expiry metadata so it cannot survive a rotation.

   ```bash
   python3 - "$account_dir" <<'PY'
   import datetime, getpass, os, pathlib, re, sys, tempfile
   directory = pathlib.Path(sys.argv[1])
   directory.mkdir(parents=True, exist_ok=True, mode=0o700)
   token = getpass.getpass('Paste setup token (hidden): ').strip()
   if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
       raise SystemExit('Expected one nonempty token without whitespace')
   with open('/dev/tty', 'r') as terminal_in, open('/dev/tty', 'w') as terminal_out:
       terminal_out.write('Known expiry in UTC (ISO timestamp, or blank): ')
       terminal_out.flush()
       expiry = terminal_in.readline().strip()
   if expiry:
       if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z', expiry):
           raise SystemExit('Use YYYY-MM-DDTHH:MM:SS[.sss]Z (UTC)')
       if datetime.datetime.fromisoformat(expiry.replace('Z', '+00:00')).timestamp() <= 0:
           raise SystemExit('Expiry must be after the Unix epoch')
   fd, staging = tempfile.mkstemp(prefix='.oauth-install-', dir=directory)
   try:
       with os.fdopen(fd, 'w') as output:
           output.write(token + '\n')
       metadata = directory / 'oauth-token.expires-at'
       metadata.unlink(missing_ok=True)
       if expiry:
           metadata.write_text(expiry + '\n')
       os.replace(staging, directory / 'oauth-token')
   finally:
       if os.path.exists(staging):
           os.unlink(staging)
   PY
   ```

4. Check `/accounts` for `authMode: "token"`. New subprocesses read the file;
   active turns keep their current authentication; idle workers are replaced before their next turn if the credential file changes.
   Do not restart the proxy during active turns. Confirm a normal request when
   convenient; an unavailable `/usage` result alone does not mean the token is bad.

The optional `oauth-token.expires-at` file contains only that UTC timestamp.
Known expiries generate one Today warning within 14 days of expiry. Authentication
failures generate a separate deduplicated warning; mint and install a replacement
token manually when needed. Replace or remove the expiry metadata whenever you
replace a token. An unknown expiry is reported as unknown, with no expiry warning.
