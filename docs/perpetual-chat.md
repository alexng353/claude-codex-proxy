# Perpetual chats

A perpetual chat is a Codex thread that never fills up. The proxy logs every
message of it, builds a tree of one-line summaries in the background, and sends
Claude a summary view instead of the full history. Claude opens a summary with
the `zoom` tool when it needs detail. The design follows
[UniiChat/OptMem](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
The code is in `src/perpetual/`.

## Scope

`~/.config/claude-codex-proxy/perpetual.json` (override with
`PERPETUAL_CONFIG`) selects the threads. The file is re-read when it changes;
no restart is needed.

```json
{ "titlePrefix": "Today", "threads": ["01a1370e-82bb-77e1-8960-43ffd3e8b72c"] }
```

- A thread qualifies when its title in the Codex app starts with
  `titlePrefix` and, if `threads` is present, its id is listed. Remove
  `threads` to include every thread whose title starts with the prefix.
- The title comes from Codex's thread store (`threads.name` in the newest
  `~/.codex/state_<n>.sqlite`, read-only; override the path with
  `PERPETUAL_CODEX_STATE_DB`). A thread whose title cannot be read is out of
  scope.
- The thread id is the request's `prompt_cache_key`. Subagents share their
  parent's key, so requests whose turn metadata names a `subagent` or
  `memory_consolidation` thread are excluded, as are request kinds other than
  `turn`.
- Without the file, or for any other request, the proxy does nothing new: the
  request reaches Claude byte for byte as before.

Optional keys: `viewMin` and `viewMax` (bytes, default 64,000 and 128,000),
`summaryModel` (default `haiku`) and `summaryEffort` (default unset). Effort
`low` on Haiku measured 20 times fewer output tokens, but it shortened a pull
request URL to `.../pull/1391`; the default kept it whole.

## What Claude receives

```text
[tools][system prompt][view][unsummarized raw items][current turn]
```

- **System prompt.** Codex's instructions, tools and opening context, plus the
  perpetual-memory instructions and the `zoom` and `date` tools. It carries no
  state, so it stays cached.
- **View.** Summary lines `id+n|text`, oldest first, in `<chat>` tags. It
  changes only when a new turn starts, never during a tool loop.
- **Raw items.** Completed messages the summarizer has not reached yet are
  sent in full, so a turn never waits for the summarizer.
- **Current turn.** Alex's message and every tool call and result since stay
  raw. A tool loop therefore continues in the same Claude worker, which
  receives only the new items.

A turn starts after the last final answer: an assistant message that is not
followed by a tool call or result, or a `<turn_aborted>` message. A message
sent mid-turn stays in the turn.

## The log and the tree

Each chat lives in `$PROXY_STATE_DIR/perpetual/<thread id>/`:

| Path | Content |
| --- | --- |
| `main/YYYY-MM-DD.jsonl` | Messages `{i, kind, text, size, date, key}`. Append-only, flushed per write. |
| `tree/YYYY-MM-DD.jsonl` | Tree nodes `{l, i, text, size}`. Each node is built once. |
| `view.json` | The view's lines and its cache-mark block. Never rebuilt from the log. |
| `cview.json` | The summarizer's own 16-32 KB view. |
| `state.json` | Proxy-answered tool items not yet covered by the view. |
| `images/` | Image bytes, named by SHA-256. |
| `lock` | Process id of the owner. |

- **Messages.** Kinds are `user`, `assistant`, `tool`, `echo`, `work` and
  `note`. A Codex item is logged once, identified by a hash of its content plus
  how many identical items precede it. Reasoning and Codex compaction items are
  not logged. A tool output is clipped to its first and last 15,000
  characters; other text longer than 30,000 characters becomes several
  messages. An image is saved under `images/` and logged as its path and a
  caption (media type and size).
- **Lock.** One process owns a chat. A request for a chat another live
  process owns passes through unchanged; a dead owner's lock is reclaimed.
- **Tree.** `node(0, i)` is message `i` in at most 512 bytes. `node(l, i)`
  merges `node(l-1, 2i)` and `node(l-1, 2i+1)`. A short message is its own
  line and two short lines are joined, without a model call.
- **Summarizer.** `claude -p --model haiku` on the account the thread is
  pinned to (the first available account otherwise), with no tools, session
  or customizations. Up to 8 calls run at once. A message's node starts once
  fewer than 8 earlier messages are unbuilt, and a merge starts once both
  halves exist. Each call sees the summarizer's view up to its input, so it
  can resolve references. A line over 512 bytes is sent back in the same
  conversation with its size and a cut mark, up to 5 attempts, keeping the
  shortest. The prompt asks it to copy URLs, SHAs, issue ids, paths and
  numbers exactly, in preference to prose. A failed call is retried at the
  next logged message once its backoff has passed (15 seconds, doubling up to
  30 minutes). Calls are recorded in `usage.jsonl` with
  `launchMode: "perpetual-summary"`.

## The view

New messages append lines. Once the view passes `viewMax` bytes, one batch
merges the most due sibling pairs until it is at most `viewMin`. A pair is due
by `(T - last) / 2^l`, where `last` is its last message and `T` the number of
messages the view covers; ties go to the oldest pair. With the push list's
length as the budget this reproduces Taelin's rollback push at every step
(tested for 4,097 steps). Only pairs whose parent is built merge; if a batch
cannot reach `viewMin`, merging continues at later turns.

**Cache marks.** The view is sent as blocks of 4 lines, and one block carries
a 1-hour cache mark. Measured on 2026-10-13 with Claude Code 2.1.296:

- Claude Code passes `cache_control` on stream-json input through to the API.
  It must use `ttl: "1h"`, Claude Code's own lifetime, or the API rejects it.
- Claude Code already uses 3 of the 4 marks a request may carry. A second view
  mark fails the turn with HTTP 400.
- The API looks back about 20 blocks from a mark. An entry 31 blocks back was
  not found.

So the mark goes on the last whole block, but moves at most 16 blocks past the
previous turn's mark. After a long turn it catches up over the next turns. After
a batch it goes to the last whole block.

## Tools the proxy answers

- `zoom(id, n)` returns the two lines under line `id+n`; `zoom(id, 1)` returns
  message `id` whole, with its images attached again.
- `date(id)` returns the time message `id` was logged.

Codex never sees these calls. When Claude's answer holds only proxy tools,
the proxy answers them and asks Claude again in the same worker. When it also
holds Codex tools, Codex receives only those. The proxy's calls and results are
stored in `state.json` and put back in place in later requests, so the
worker's history still matches. After 24 rounds in one request, `zoom` answers
that lookups are exhausted; after 28, the proxy returns Claude's answer without
its proxy calls. The log records each call and a one-line note in place of its
result, so summaries are not summarized again.

## Other behaviour

- **Codex compaction** is answered without a model call: the log already
  keeps everything. Proxy usage reports cover only what Claude receives, so
  Codex does not compact on its own.
- **Existing features** run first and are unchanged: credential scrubbing, the
  hygiene gate, the plate-activity block, account pinning and failover. The
  perpetual chat logs messages as they reach Claude, including injected
  blocks; withheld hygiene photos stay withheld.
- **Failures** pass the request through unchanged and log only the error
  name, never chat text.
- **Status.** `curl -s localhost:3456/perpetual/<thread id>` reports counts
  (messages, built leaves, nodes, running summaries, view lines and coverage)
  for a chat opened since the proxy started.

## Known limits

- Enabling an existing long thread logs its whole history on the first
  request. Until the summarizer catches up (about two Haiku calls per long
  message), the unsummarized part is sent raw, as it is today.
- If Codex compacts or rewrites history, identical items can shift their
  occurrence count; an item may then be logged again or missed once.

## Tests

`bun test test/perpetual-view.test.ts test/perpetual.test.ts` covers merge
order against Taelin's push, the sawtooth, cache-prefix stability and the mark
step, scope and byte-identical passthrough, turn detection, tool-loop
continuation in one worker, zoom and date (including chained and mixed calls),
images, compaction, the summarizer's retries and backoff, and the lock.
