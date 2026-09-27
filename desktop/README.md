# Local Codex Desktop UI integration

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
