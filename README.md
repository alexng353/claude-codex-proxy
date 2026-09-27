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

Restart Codex Desktop after changing the config. Use `opus`, `sonnet`, or `haiku` as the model. Full Claude model IDs beginning with `claude-` are also accepted.

Codex caches model capabilities. After upgrading the proxy, quit Codex Desktop, remove `~/.codex/models_cache.json`, and reopen Codex so browser/plugin capability changes are fetched. Existing tasks retain the model instructions and tool world captured when they were created, so test browser changes in a new task.

To switch back, set `model_provider = "openai"` and choose an OpenAI model, or remove the added provider/default lines.

Provider settings cannot be placed in a repository's `.codex/config.toml`; Codex ignores project-local provider overrides for credential and routing safety.

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
| `PROXY_STATE_DIR` | `$XDG_STATE_HOME/claude-codex-proxy` or `~/.local/state/claude-codex-proxy` | Usage JSONL and the `sessions.sqlite` session map; owner-only files |

Binding to a non-loopback address is rejected unless `PROXY_API_KEY` is set. If enabled, add `env_key = "CLAUDE_CODEX_PROXY_KEY"` to the provider and export the same value:

```bash
export PROXY_API_KEY='choose-a-long-random-value'
export CLAUDE_CODEX_PROXY_KEY="$PROXY_API_KEY"
```

## Supported API

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`, streaming and non-streaming
- Text input and multi-item agent history
- Function, custom, and namespaced tool calls
- Parallel tool calls
- Codex Desktop computer/browser actions and screenshot results
- Codex plugin, app, skill, and Node/CUA REPL capability metadata
- Client-side `tool_search` discovery for deferred Codex MCP/plugin tools

## Current limitations

- Streaming is protocol-compatible SSE, but Claude's text is emitted after its structured response completes rather than token by token.
- Browser screenshots and `input_image` parts are forwarded as native image content blocks. File input parts are not implemented.
- OpenAI-hosted tools are not reimplemented by the proxy. Codex-local tools are passed through. Native Claude tools are disabled.
- Codex-provided browser, search, app, plugin, and MCP tools remain available through the Responses tool loop.
- Claude processes are retained after every turn, including final answers and tool searches. A request continues a retained process only when its model, effort, instructions, and base tools match and its input extends exactly the history that process has seen; the process then receives only the new items, so Claude Code's prompt cache keeps hitting. Edited, forked, or compacted histories start a fresh process. Idle processes expire after `CLAUDE_SESSION_IDLE_MS`.
- Every process runs as a persisted Claude Code session. `sessions.sqlite` maps each session to a hash of the Codex history it has consumed. When a conversation's process is gone (idle expiry, crash, or proxy restart), the proxy starts `claude --resume <id> --fork-session` and sends only the new items. Resuming replays the exact message history, so the first turn still reads the whole conversation from Anthropic's cache; re-sending the history as one flattened message would miss it. Sessions and their transcripts in `~/.claude/projects/` are deleted after `CLAUDE_SESSION_RETENTION_MS`. If a resume fails, the proxy replays the full request once in a fresh session.
- The structured-output schema does not enumerate tool names, because it heads the cache prefix and tool search adds tools mid-conversation. Tool names are validated after each reply, and unknown names are corrected inside the same process.
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

## Attribution

Inspired by [wende/claude-max-api-proxy](https://github.com/wende/claude-max-api-proxy). This project differs by targeting Codex's Responses API, including Codex Desktop's browser computer-use protocol.

## Cache behavior and diagnostics

`usage.jsonl` records every Claude result, including errors, with UTC timestamp, request ID, worker ID, worker turn number, retry attempt, model, effort, raw `usage`, and `modelUsage`. It does not contain prompts, responses, screenshots, or credentials. Missing usage remains null; it is not fabricated as zero. Logging failures go to stderr without dropping completed inference.

Stable instructions and a canonically ordered tool registry precede changing conversation content. Tool schema keys are sorted. Ordinary tool results reuse the existing worker and omit the instructions and registry already in its history. Changes in model, effort, instructions, or tool definitions require a fresh worker; a mere reorder of tools does not. Tool discovery currently requires a fresh worker so the new structured-output schema includes discovered tools.

`--no-session-persistence` disables disk transcripts; it does not disable prompt caching or in-memory tool continuation. Fresh-worker requests can still reuse a stable provider cache prefix. Cache hits depend on the provider, prefix identity, and expiry; no fixed hit rate is promised for arbitrary conversations.

Measured on 2026-09-27 with Claude Code 2.1.283 and exact Opus 5.5: three identical fresh requests used cache read/write tokens of 99076/29572, 99076/29576, 99076/29573 before cleanup, versus 0/9798, 9798/0, 9798/0 after. A two-call tool loop after cleanup read 10236 and created 180 on the continuation. These are a controlled synthetic workload, not estimates of all production traffic or billing.
