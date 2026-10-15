# Per-chat skill preloads

Map exact Codex thread IDs to local skill files in
`~/.config/claude-codex-proxy/skill-preloads.json` (override with
`SKILL_PRELOAD_CONFIG`):

```json
{
  "threads": {
    "<thread-id>": ["/absolute/path/to/skill/SKILL.md"]
  }
}
```

The proxy reads this configuration and the selected files on every request,
removes YAML frontmatter, scrubs credentials, and prepends their bodies as one
developer message. Paths must be absolute; duplicate paths load once in list
order. Changing files or removing a mapping takes effect on the next request.
No restart is needed for configuration or skill edits after installing the code.

Matching uses `prompt_cache_key`, never chat text or titles. Subagents and memory
consolidation requests are excluded because they share their parent's cache key.
Auxiliary request kinds and compaction triggers are also excluded. With no config,
an empty list, or no matching thread, the request is unchanged.

Claude requests load skills before perpetual-memory rewriting, keeping the skill
in the stable opening context rather than the summarized history. Unchanged
skills preserve worker reuse. GPT HTTP and websocket turns receive the same
preload through the router's existing `/hygiene/gate` preprocessing call; the
router needs no changes. Incremental requests also receive the current skill.

A configured file that is missing, unreadable, empty, or has an invalid path
stops that chat's request with a fixed diagnostic. Malformed configuration stops
eligible requests until repaired. The GPT path returns a synthetic diagnostic
response so the router does not silently forward on an HTTP error. The router's
existing fallback still applies if the proxy itself is unreachable.

The service journal records `skill-preload:` with the thread ID, source paths and
SHA-256 hashes of the scrubbed skill bodies. It never records their contents.
Use those receipts to check the live path without logging private requests.

Run `bun test test/skill-preload.test.ts` for scoped loading, hot reload,
credential scrubbing, failure behavior, perpetual history, GPT preprocessing,
and Claude worker continuation with a fake CLI.
