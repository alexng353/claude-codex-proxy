# Claude Codex Proxy

Use a Claude Pro, Max, or Team subscription as a custom model provider in Codex Desktop. This Bun server implements the OpenAI Responses API surface Codex uses and delegates inference to your authenticated Claude Code CLI.

> [!IMPORTANT]
> This is an unofficial compatibility bridge. It is not affiliated with OpenAI or Anthropic. Subscription access, usage limits, and permitted use are governed by Anthropic's current terms. The bridge intentionally calls the official `claude` CLI instead of extracting or forwarding OAuth credentials.

## How it works

```text
Codex Desktop ── Responses API ──> this local Bun server ── stdin/stdout ──> Claude Code CLI
```

The proxy converts Codex tool schemas into a structured-output request and translates Claude's answer or tool requests back into Responses API events. It supports Codex function/custom tools, namespaced tools, and the Desktop browser's computer-use loop, including screenshot feedback.

Claude is launched with its normal user and project configuration plus `--dangerously-skip-permissions`. That means Claude can also load and directly use the tools, MCP servers, plugins, hooks, and instructions available to your Claude Code installation. This unrestricted behavior is intentional in this project; read the [Security](#security) section before running it in a sensitive directory.

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
git clone https://github.com/jpm8888/claude-codex-proxy.git
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
| `PROXY_API_KEY` | unset | Optional bearer token |

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
- Browser screenshots returned through `computer_call_output` are materialized temporarily for Claude to inspect. General image/file input parts are not yet forwarded.
- OpenAI-hosted tools are not reimplemented by the proxy. Codex-local tools are passed through, while tools configured in Claude Code may also execute directly inside the unrestricted Claude subprocess.
- Claude Code's native `ToolSearch`, `WebFetch`, and `WebSearch` are disabled because they conflict with Codex's deferred-tool and Browser routing. Codex-provided browser, search, app, plugin, and MCP tools remain available through the Responses tool loop.
- Each turn is stateless at the proxy layer. Codex sends the active conversation history again, which favors correctness over prompt-cache efficiency.
- Claude Code changes can affect compatibility because its CLI JSON format is not a stable third-party provider API.

## Development

```bash
bun run check
```

Tests use a fake Claude executable and do not consume subscription quota. A manual live smoke test requires an authenticated Claude Code installation.

## Security

- Prompts go to Claude through stdin, never through a shell.
- The proxy never reads or exposes Claude OAuth credentials.
- Every inference subprocess uses `--dangerously-skip-permissions` and loads normal Claude Code configuration. Claude may read files, run commands, use configured MCP servers/plugins, and perform other actions without Claude's permission prompts.
- Those direct Claude actions may occur outside Codex's visible tool-call and approval loop. Run the proxy only in directories and with credentials you trust. Set `CLAUDE_CWD` to a deliberately scoped directory if needed.
- Keep the server bound to localhost unless you add a bearer token and understand the network exposure.

## Attribution

Inspired by [wende/claude-max-api-proxy](https://github.com/wende/claude-max-api-proxy). This project differs by targeting Codex's Responses API, including Codex Desktop's browser computer-use protocol.
