# Local Codex Desktop UI integration

`compaction/` adds `codex_app.compact_thread({threadId?})` to the desktop's
existing app-tools socket. Omit the UUID to compact the calling local Codex chat.
The desktop's own app-server performs `thread/compact/start`; active chats return
`queued` and wait until idle. `started` means the server accepted the request,
not that the summary finished. Duplicate pending calls coalesce.

Install with `python3 desktop/compaction/install.py`, then run
`python3 ~/.local/share/codex-patches/manager.py apply --no-repair` and restart
Desktop. The installer backs up the patch-manager files. The manager backs up
the archive, verifies JavaScript and archive readback, and reapplies after app
updates. Changed anchors fail loudly through its existing failure reports and
repair mechanism. The bundled MCP server needs no modification: it reads the
tool catalog from Desktop.

For Plate or a chat whose tool catalog predates the patch:

```sh
node desktop/compaction/call.mjs THREAD_UUID
node desktop/compaction/call.mjs status
```

The CLI uses `CODEX_APP_TOOLS_PIPE_PATH` or Desktop's private pipe marker in
`~/.local/state/codex-compaction/pipe`. Queue state and errors live beside it in
`status.json`. Queued requests survive restarts. An accepted request whose
completion was not observed becomes `interrupted` instead of being replayed;
inspect its rollout before retrying. Cloud chats are unsupported. Queuing waits
for the chat to become idle, including any turns started in the meantime.

Validation: `bun test test/desktop-compaction.test.ts` covers queue admission,
deduplication, restart recovery, completion events, and persisted RPC failures.

`visual-consistency.patch` updates Alex's existing Linux patch manager at
`~/.local/share/codex-patches`. It is an incremental patch for that installation,
not a standalone Codex installer or a portable patch for arbitrary app versions.
It removes the Opus-only white label override, uses the native effort slider for
Claude's supported levels, and scopes Claude orange (`#D97757`) to the slider's
colour tokens. GPT retains its theme colours and native controls.

From the patch-manager directory, first dry-run, then apply:

```sh
patch --dry-run -p1 < /path/to/claude-codex-proxy/desktop/visual-consistency.patch
patch -p1 < /path/to/claude-codex-proxy/desktop/visual-consistency.patch
node test-behavior.cjs
python3 -m unittest test_manager.py
python3 manager.py apply --no-repair
```

Stop if the dry-run fails; the patch may already be installed or the source may
have changed. The manager stages and verifies the app archive before replacing it.
Restart Codex to load it. The repository's `skills/restart-codex-desktop` skill can
be linked into `~/.codex/skills/restart-codex-desktop` for a verified Linux restart.

## Model routing and sub-agents

The same patch manager starts every new task on the built-in `openai` provider,
for exact `claude-opus-5-5` as well as `gpt-*`. `openai_base_url` in
`~/.codex/config.toml` points at the local model router
(`~/.local/share/codex-patches/router`, service `codex-model-router`). The router
sends Claude requests to this proxy with OpenAI credentials removed, and sends GPT
requests to OpenAI unchanged. Sub-agents inherit their parent's provider, so this
lets a Claude task spawn native GPT sub-agents. It relies on the proxy's remote
compaction support. Tasks created on `claude_subscription` before this change still
run Claude only.
