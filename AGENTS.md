# Installing claude-codex-proxy (instructions for coding agents)

Follow these steps when a user asks you to install this proxy so Codex can use
their Claude subscription. Run each check and stop to report if one fails; do
not work around a failed prerequisite.

## 1. Check prerequisites

```bash
bun --version            # needs 1.2 or newer
claude --version
claude auth status       # must show a logged-in subscription account
codex --version || true  # Codex CLI or Codex Desktop must be installed
```

If `claude auth status` is not logged in, ask the user to run `claude login`
themselves. Never read, copy, or print Claude or OpenAI credentials.

## 2. Install and test

```bash
git clone https://github.com/alexng353/claude-codex-proxy.git ~/.local/share/claude-codex-proxy
cd ~/.local/share/claude-codex-proxy
bun install
bun run check            # type check and tests; uses a fake claude, no quota
```

## 3. Run it as a service

On Linux with systemd, create `~/.config/systemd/user/claude-codex-proxy.service`.
Substitute absolute paths from `command -v bun` and `command -v claude`.
Set `WorkingDirectory` to the checkout, never to a temporary or per-task
directory, or the service fails when that directory is removed.

```ini
[Unit]
Description=Claude Code subscription provider for Codex
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/claude-codex-proxy
ExecStart=/ABSOLUTE/PATH/TO/bun %h/.local/share/claude-codex-proxy/src/server.ts
Environment=HOST=127.0.0.1
Environment=PORT=3456
Environment=CLAUDE_BIN=/ABSOLUTE/PATH/TO/claude
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDECODE
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`UnsetEnvironment` matters: an inherited `ANTHROPIC_API_KEY` would make Claude
Code bill the API instead of the subscription.

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-codex-proxy.service
curl -s http://127.0.0.1:3456/health   # {"status":"ok"}
```

On macOS, use a launchd agent with the same command and environment.

## 4. Configure Codex

Back up `~/.codex/config.toml`, then add the provider block. Do not change the
user's default `model_provider` unless they ask; they can select the provider
per profile or task.

```toml
[model_providers.claude_subscription]
name = "Claude subscription (local proxy)"
base_url = "http://127.0.0.1:3456/v1"
wire_api = "responses"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 900000
```

Provider settings only work in the user-level config, not in a repository's
`.codex/config.toml`. After changing it, the user must restart Codex and, after
proxy upgrades, delete `~/.codex/models_cache.json`.

## 5. Verify

1. Send one request:
   ```bash
   curl -s http://127.0.0.1:3456/v1/responses -H 'content-type: application/json' \
     -d '{"model":"sonnet","input":"Reply with exactly: hello from Claude"}'
   ```
2. Ask the user to send two messages in a Codex task that uses the provider,
   then check caching:
   ```bash
   tail -n 3 ~/.local/state/claude-codex-proxy/usage.jsonl |
     jq -c '{worker:.workerId[0:6], turn:.workerTurn, read:.usage.cache_read_input_tokens, write:.usage.cache_creation_input_tokens}'
   ```
   After the first turn, `read` should cover almost the whole conversation and
   `write` should be small. A large `write` on every turn means caching is broken.

Report what you verified and what you could not.
