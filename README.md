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

The proxy uses the account `claude login` signed into first. When Claude reports that an account is rate limited (a `rejected` `rate_limit_event`, or a 429 result), the proxy marks it limited until its reset time and replays the turn on the next available account. Chats are durably pinned by `prompt_cache_key` (normally the root Codex session ID, shared with its subagents) to their selected account, including across proxy restarts, compaction, and transcript expiry. Successful rate-limit failover updates the pin; a quota reset does not move an existing chat back. Pins refer to the configured account name. If the pinned account is removed, the next successful request pins an available account. If the pin database is unreadable or cannot record an initial assignment, threaded requests fail before inference rather than choosing an unverified account. A pin update failure after inference is logged and preserves the completed response. New requests without a thread ID use the first available account; existing live workers keep their account.

```bash
bun run account add work     # opens the browser to sign in a second account
bun run account list
curl -s http://127.0.0.1:3456/accounts   # which accounts are limited, and until when
bun run limits               # five-hour and weekly usage bars per account
bun run limits --probe --record --quiet   # append a fresh sample per account to limits-history.jsonl
```

`bun run limits` reads what the proxy last saw and supplements it with Claude Code's local `/usage` command, which also reports model-specific weekly meters such as Fable. This reads usage without generating a model response or spending model tokens. Query results are cached for five minutes to make repeat queries fast, expiring earlier when a quota window resets; `--probe` refreshes every account. Newer proxy observations update overlapping meters without hiding the cached model-specific meters; supplemented meters show their cache age. The display labels the source and observation age. Usage queries time out after 15 seconds, disable customizations, and do not save chats. They require Claude Code 2.1.282 or newer and structured `usage_report` data for `/usage`; unsupported versions report unavailable data instead of falling back to a model request. If a usage refresh fails, valid proxy data remains available. The `LIMITED` label comes from an explicit rejection observed by the proxy; local usage queries report percentages and reset times. Each proxy response also carries Codex's `x-codex-primary-*` (five-hour) and `x-codex-secondary-*` (weekly) rate-limit headers for the account that answered, so Codex's own usage display shows the Claude account.

Limit readings otherwise arrive only while an account is serving turns, so idle accounts have gaps. `--record` appends one line per account to `$PROXY_STATE_DIR/limits-history.jsonl` with the sample time, source, reset times, and each window's percentage; `--quiet` suppresses the display. Running `bun run limits --probe --record --quiet` from a five-minute systemd user timer gives a continuous history of every account.

Each extra account lives in `$PROXY_STATE_DIR/accounts/<name>`. That directory keeps its own `.credentials.json` and `.claude.json`; every other entry is a symlink to your main Claude config. Because `projects/` is shared, a conversation can resume its transcript on another account. A switch still misses the prompt cache once, since each account has its own cache.

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
- **Prompt cache:** Codex replays history without injected text. The proxy therefore stores each block by thread and message key in `$PROXY_STATE_DIR/plate-activity.sqlite` and re-applies it to the same message on every later request, including older messages in the history. A message key is a hash of the message's content plus how many earlier messages have identical content. A message with nothing to report is stored too, so events that arrive mid-turn wait for the next message instead of changing one already sent.
- **Cursor:** The cursor advances only after Claude returns a successful response. A retry gets the identical block. If a turn fails and Alex sends another message, its events move to the newer message. Compaction requests re-apply stored blocks but never create one.
- **Failure:** If plate is unreachable, the turn proceeds unchanged and the events wait for the next message. Logs record only error names, never event or note text.
- **Router:** The logic in `src/plate-activity.mjs` does not depend on the model, so the Codex router can import it like `scrub.mjs`. Today only this proxy applies the block, which covers Claude models, including requests that arrive through the router. A block that is already present is left alone, so a later router hook will not create duplicates.

## Hygiene gate

Alex asked for this: agents refuse to work until he sends a photo proving he brushed his teeth or showered. It covers every chat through this proxy, on both the Claude path and the GPT path through the Codex model router.

**Kill switch.** `touch ~/.local/share/claude-codex-proxy/hygiene-gate/disabled` turns the gate fully off at once, with no restart. Delete the file to turn it back on. While it exists, the gate changes nothing: no locks, no notes, no photo rewriting.

### Daily rules (America/Vancouver)

- **Morning teeth.** From 05:00, the first gated turn is locked until a teeth photo passes.
- **Night teeth and shower.** Both are due by midnight. A shower photo counts any time that day. A night teeth photo counts only from 17:00, so the morning photo cannot stand in for it. If either is missing at 00:00, the gate locks until it arrives. Clearing that lock does not cover the morning: after 05:00 the morning teeth photo is still needed. One photo fills one requirement.
- **Locked.** The turn is not sent upstream. The proxy answers with a short final answer, such as `🪥 gate armed: morning teeth photo`, in the client's own format: SSE or JSON on the Claude path, SSE, JSON or websocket frames on the GPT path. The router then closes a GPT websocket, so Codex reconnects instead of chaining to a response OpenAI never saw.
- **BYPASS.** A message that is exactly `BYPASS` opens the gate for one hour, adds one to the bypass counter, and opens a debt. On Alex's next gated turn in each chat, a hidden note asks the model to find out why and to rule on it with `POST /hygiene/debt/<id>/resolve`, sending either `{"verdict":"justified"}` or `{"verdict":"unjustified","penance":"<photo task>"}`. An unjustified ruling locks the gate until a photo matching the penance passes. BYPASS does nothing when the gate is already clear.
- **DELAY.** A message that is exactly `delay` (any case, surrounding spaces ignored) postpones the morning teeth photo by two hours. It works once per morning, only between 05:00 and 12:00, and only when the morning photo is the only lock. Otherwise the reply points to BYPASS. Delays have their own counter and open no debt. During the window, each of Alex's messages carries a hidden note asking the model to end its reply with a one-line reminder. A teeth photo ends the delay. When the window expires without one, the gate locks again.

### Which turns are gated

Only turns Alex types. Codex puts `x-codex-turn-metadata` in the body's `client_metadata`, which the router forwards unchanged.

- **Exempt by trigger.** Turns whose `turn_trigger` starts with `automation_` (heartbeats, cron, and scheduled one-shot tasks), `app_tool_send_message` and `app_tool_create_thread` (agent-to-agent prompts), `exec`, `code_review`, resume and onboarding triggers, and the other app-initiated triggers listed in `src/hygiene.ts`.
- **Exempt by thread, request kind or content.** Turns in a `subagent` thread, any `request_kind` other than `turn`, compaction requests, and turns whose new user messages are all Codex wrappers (`<heartbeat>`, `<codex_delegation>`, `<subagent_notification>`, environment context and similar).
- **Gated.** Every other trigger is treated as possibly human, including `composer`, queued messages, edits, and triggers the gate has never seen, such as a future mobile client.
- **Continuations.** A request whose input ends in model output or tool results is a continuation of a turn that was already let through, so a long turn started before 05:00 keeps running.

### Proof checks

1. **Hashes.** Every image in Alex's new messages gets a SHA-256 and a 256-bit dHash, computed with ImageMagick. An exact copy of an accepted proof is rejected, and so is one within 10 bits of an accepted proof. On 30 of Alex's photos, re-encoded copies measured 0–9 bits apart; consecutive burst frames measured 10 or more.
2. **Content.** A separate one-shot `claude -p --model haiku` call returns a JSON verdict: `teeth`, `shower`, `penance` or `none`. It runs with no session, tools or customizations. A verdict needs confidence 0.6 or higher. On 2026-10-07 the live call took about 5 seconds and classified a real brushing photo as `teeth` with confidence 0.98. If the call fails, the turn stays locked, and the photo can be resent.
3. **EXIF.** If the photo has a capture time, it must be within 30 minutes of sending. Mobile uploads have none, and that is not a failure.
4. **Storage.** Accepted photos are saved byte for byte, with EXIF intact, to `~/Documents/private/hygiene/YYYY/MM/DD/<kind>-<HHMMSS>-<sha8>.<ext>` in Vancouver time. Directories are mode 700 and files 600; override the location with `HYGIENE_PHOTO_DIR`. Rejected photos are never saved. The index in `$PROXY_STATE_DIR/hygiene-gate.json` keeps hashes, times, kind, verdict, requirement slot and saved path for 400 days.

Photos that passed, or that looked like a bathroom photo, never reach the working model. In every request the gate replaces them with a fixed marker such as `[hygiene-gate: photo accepted as morning teeth (Oct 7) proof; image withheld]`. Hidden notes are stored against their message and replayed byte for byte, using the same message key as plate-activity. Both keep the prompt cache intact.

### State, status and operations

- **Status.** `curl -s http://127.0.0.1:3456/hygiene/status` reports `state` (`armed`, `clear`, `bypassed` or `disabled`), outstanding and due-today requirements, the bypass count, `delay` (`active`, `expires_at`, `count`), open debts and recent proofs.
- **State file.** `hygiene-gate.json` is re-read when it changes, so it can be hand-edited without a restart. `startsAt` sets the first arm: nothing that arms earlier is enforced. `extraGatedTriggers` (for example `["exec"]`) temporarily gates `codex exec` turns for live checks. Only the proxy writes the file.
- **Failure behaviour.** A gate bug fails open: the request is forwarded unchanged and an error is logged. A broken state file fails open the same way. If the proxy is down, the router forwards GPT turns ungated.
- **Router.** The router (`~/.local/share/codex-patches/router`) imports `src/hygiene-events.mjs` and asks `POST /hygiene/gate` about GPT `/responses` requests and websocket `response.create` frames. Claude requests are gated inside `/v1/responses`. Restart both services when the gate changes.
- **Tests.** `bun test test/hygiene.test.ts test/hygiene-gate.test.ts` covers the rules, exemptions, hashing, BYPASS, debt and penance, DELAY, the kill switch, and locked replies on both paths. All use an injected clock and classifier. Run the router's suite with `node --test router.test.mjs`.
