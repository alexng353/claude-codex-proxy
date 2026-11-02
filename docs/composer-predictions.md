# Composer prediction corpus and model calls

The authenticated, loopback-only `POST /composer-predictions` route predicts one
short next message. It runs outside the Responses API turn path and the hygiene
gate. It never writes a conversation, sends a message, or executes model tools.

## Bounds and account use

Each thread/turn pair receives one persistent attempt claim, including failures.
There is no retry. At most two requests run concurrently, including
retrieval. Generation uses the existing subscription account environment with
billing/API-key variables removed, Haiku, low effort, no tools, no session
persistence. One absolute deadline covers preparation, retrieval, generation, and output checking: the earlier of the caller deadline and 12 seconds after receipt. Output must be a short single-line string
inside a JSON prediction response; null or invalid output produces no suggestion.
With the fork switch on (below), Haiku is the fallback instead of the only model.

The shared prompt builder keeps the last 3,000 context characters and at most
two example pairs (500 assistant characters and 200 reply characters each).
Corpus examples are independently opt-in (`corpusEnabled: true`); the default is no examples. The shared runtime/evaluation boundary checks raw context and each raw example field before JSON escaping or truncation, and checks
the prediction before return. The local usage log contains time, model, duration,
and whether a suggestion was produced; it contains no message text.

## Fork of the chat (switch, off by default)

`src/prediction-fork.ts` can answer from an invisible fork of the chat itself
instead of Haiku. It is off until switched on: `PREDICTION_SOURCE=fork`, or a
`prediction-source` file in the proxy state directory whose first line is
`fork`. The file is read on every request, so turning it on or off needs no
restart. Anything else means Haiku.

When a worker parks after a final answer (no tool calls), it records its
launch arguments, session, account, answer and context size under the chat's
`prompt_cache_key`. The context size is the last API call's input. Any turn
that starts on the chat clears the record, including corrections and
compactions, and the record expires after ten minutes. The daemon sends that
key as `engineThreadId` (Today's own thread id differs for chats Today made).
It also sends `lastAnswerSha256`, the SHA-256 of that turn's own last agent
message, with ASCII whitespace trimmed. A turn with no answer sends none.

A fork runs only when both of these hold:
- that digest is the recorded answer's;
- the recording worker is the last to have parked the chat on either proxy
  copy, which `thread_parks` in the shared `sessions.sqlite` records.

Otherwise the fork is `stale`. Either a newer turn finished elsewhere, even
one that ended with the same words, or the daemon sent no digest. The record
is checked again after the transcript read, because the worker may have
started another turn meanwhile.

Both proxy slots must run this code while the switch is on. A copy without
`thread_parks` does not record its turns there, so after an answer with the
same words the other copy could fork an older turn.

The resume point is the transcript entry that accepted that same answer, as the
model wrote it, before the proxy's rewrites. It is found in the transcript's
last MiB without blocking the event loop. An unreadable transcript just means
no fork.

The fork runs the same Claude Code binary with the worker's arguments, swapping
in `--resume <session> --fork-session --no-session-persistence
--resume-session-at <that entry>`. Model, effort, system prompt file and output
schema stay the chat's own, so the fork reads the chat's prompt cache.
`PREDICTION_FORK_EFFORT` can override the effort, which is outside the cached
prefix: a low-effort fork of a high-effort chat read 651k cached tokens.
Measured 2026-11-02, forcing low was no faster at the median, and its p90 was
10.3 s against 4.1 s. One user message asks for Alex's likely next message.
The first result ends the process, which is then killed.

What makes it invisible: the fork bypasses `runClaude`, so it writes no
usage.jsonl row, session map row, pin, hygiene accounting or transcript, and
Codex and Today never see it.

Haiku answers instead, with the time the fork leaves it, when:
- the request has no `engineThreadId` (an older daemon);
- no fresh final-answer record exists on this proxy copy (`no session`), or
  the turn ended on another answer, or the request had no digest (`stale`);
- the chat's account is unavailable or over its weekly cap;
- the last call's input was over `PREDICTION_FORK_MAX_CONTEXT_TOKENS`
  (300,000);
- the transcript tail has no accepted entry for the answer (`no checkpoint`);
- the fork errs, calls a tool, answers more than one short line, or its text
  fails the scrubber;
- the fork is not done 5.5 s before the deadline, which leaves Haiku its p90.

If the fork answers with empty text, nothing is predictable, and Haiku is not
asked. Cancelling the request kills the fork. The fork uses no corpus examples:
it already has the chat's own words.

Each request writes one `prediction-usage.jsonl` line under its own attempt
id, so a duplicate the service refused can never take another request's
record. The line holds, never text:
- `threadId` and `turnId` (Today's);
- `model`: `fork`, `haiku`, or `skipped` for a duplicate, busy or invalid
  request;
- `fallback`: why the fork did not answer;
- `elapsedMs`, `forkMs` and `forkAccount`;
- `forkUsage` and `haikuUsage`: uncached input, cache read, cache write and
  output tokens;
- `forkUnmeteredContextTokens`: for a fork that ran but reported no usage
  (cancelled or late), the chat's last context size. This is an estimate of
  what the fork read, not a bound: the answer, the prompt, output and any
  cache write come on top.

The reply says `source` (`fork`, `haiku` or `skipped`), and Today's journal
says per attempt whether Alex accepted the suggestion.

### The trial

The decision (2026-11-02 10:10, Bubble): Haiku stays the default everywhere,
and a 1-2 day trial runs on Forge's Claude chats only. Alex decides the
default from the trial numbers; the code never flips it. The trial is one
config change on Forge, which needs no restart:

```sh
echo fork > ~/.local/state/claude-codex-proxy/prediction-source   # start
rm ~/.local/state/claude-codex-proxy/prediction-source             # stop
```

The rest of the scope follows from the code: GPT chats never reach this proxy,
so they keep Haiku. Chats over 300,000 tokens and accounts past their cap keep
Haiku too. Every other machine has its own state directory, with no switch
file. The daemon must be one that sends `engineThreadId`; an older one gets
Haiku with `fallback: "no engine thread"`.

`bun scripts/prediction-trial-report.ts [SINCE]` prints four groups: fork
answered, fork ran then Haiku answered (end to end), no fork possible, and
Haiku only. Cancelled attempts are counted on their own line. For each group
it gives:
- attempts, suggestions and accepted suggestions, read from Today's
  `generated_origin` on the chat's next message;
- latency p50 and p90;
- why Haiku answered.

It then counts the skipped requests and gives the latency of every fork that
ran and was not cancelled. Last, it gives each path's tokens and an estimate
of each account's weekly share: metered, and with an estimate for unmetered
forks, which is likely low.

The baseline before the trial was 1 accepted of 62 Haiku suggestions on Forge
(2026-11-01 to 2026-11-02). Measurements and the decision record are in
Tayshun, `tooling/today-predictions/2026-11-02-prediction-fork.md`.

## Private index

Forge keeps `~/.local/state/today/composer-predictions.sqlite` beside the daemon
database. It contains `replies`, FTS5 `contexts`, and source/thread `cursors`.
Source databases are opened read-only. Incremental ingestion commits bounded
batches, deduplicates immutable message IDs, and retains only safe assistant
context and proven Alex messages.

A Today row qualifies only when its actor is `me` and its client is a known
human client: desktop, phone, email, plate, or Jarvis. Agent/delegation/script/timer
inputs are excluded, including delegation envelopes under an otherwise human
client. Legacy Cairn rows come from immutable `me` operations on human-created
outbox items. Current item bodies are not treated as authorship evidence.
Unknown authorship is excluded. Messages or context changed by the existing
secret scrubber are excluded. `generated_origin: true` is excluded even when the actor/client otherwise qualifies. The exporter preserves that field; legacy Cairn immutable operations with the `generated_origin=true` fact are marked generated and their text is omitted. Clients persist the accepted-origin mark through draft and send. The conservative rule is sticky: every edit, including replacing the entire draft, retains generated origin until send or explicit discard. Only a fresh draft becomes eligible for the human-only corpus. This excludes both unchanged suggestions and mixed text.

Retrieval ranks similar assistant contexts with SQLite FTS5/BM25. The index
remains on Forge. An Arch proxy obtains bounded, scrubbed examples over its
existing authenticated SSH link to Forge. Only the existing subscription model
call goes outside those machines. There is no vector service, fine-tuning job,
or paid API.

## Refresh and installation

The implementation includes these scripts:

- `scripts/prediction-export.ts`: read-only Today and legacy Cairn export on Arch;
  reads per-thread cursors from stdin and emits scrubbed incremental rows.
- `scripts/prediction-refresh.ts`: ingest Forge locally, then Arch's export.
- `scripts/prediction-remote.ts`: own a remote exporter process group; EOF, disconnect signals, or the shared deadline kills it and its descendants.
- `scripts/prediction-examples.ts`: query the Forge index read-only for an Arch
  prediction request.
- `scripts/prediction-eval.ts`: the held-out comparison described below.

The expected installed script root on both machines is
`~/.local/share/claude-codex-proxy/scripts`. Deployment must include these scripts
and the imported source modules. Forge also starts a nonblocking incremental refresh when corpus examples are requested, at most once per minute. The included user systemd timer
refreshes every five minutes even when only Arch chats are selected. Both use
the same nonblocking lock. Installing/enabling the timer is a separate deployment
action; no timer is activated by tests or by importing the route.

Overrides for isolated validation are `PREDICTION_INDEX`, `TODAY_DB_PATH`,
`PREDICTION_ARCH_EXPORTER`, and `PREDICTION_FORGE_EXPORTER`. Exporter paths must
be absolute and contain only the allowed path characters. A missing source or
index causes a prediction to use fewer examples, never a public fallback.

When provenance filters change, incremental refresh cannot remove previously
admitted rows because their cursors have already advanced. Rebuild into an empty
`PREDICTION_INDEX`, require both source reads to succeed, check SQLite integrity,
and preserve a backup before atomically replacing the closed index. Do not copy
old rows or cursors into the rebuild. Missing historical origin marks cannot be
reconstructed from the old index; unchanged row counts do not prove that no old
generated text was ever admitted.

## Held-out comparison

The evaluator freezes the latest 200 safe replies with preceding assistant
context. All training examples predate the oldest held-out reply; exact duplicate
reply text from the held-out set is excluded too. Each target gets paired calls,
one with no examples and one with retrieved examples. Both use the same bounded
prompt builder, model, account path, effort, timeout, and assistant context.

It checkpoints private JSONL after each call. Normalized exact match ignores case
and punctuation. Near match includes exact matches or predictions of at least
three words with normalized Levenshtein similarity at least 0.8. Failures remain
in the denominator. These are lexical proxies for acceptance, not a claim that
Alex accepted a suggestion or that a different valid response is wrong.

Run only when subscription calls are authorized:

```sh
PREDICTION_EVAL_OUTPUT=/private/path/results.jsonl bun scripts/prediction-eval.ts
```

The adjacent `.summary.json` contains aggregate counts, mean latency, p50, p90 and failure rate. Raw
messages, predictions, and the corpus must stay out of git. A failed exploratory
run must not be combined with the final measured run.

## Cancellation and latency

Preparation runs outside the ordinary proxy event loop. Its private persistent
process pool owns secret-file loading and SQLite retrieval; cancellation kills
the preparation process group, including a shell used by the secret loader.
Remote retrieval is separately owned and killed/reaped on cancellation. The HTTP
response stream forwards disconnect cancellation through all stages. Attempt
claims remain consumed after cancellation.

A separate subscription model pool prestarts a Haiku CLI process, but each process
receives exactly one prompt and is then killed and reaped. There is no conversational
state shared between chats or between held-out targets. Idle processes expire after
one minute. Prewarming removes CLI startup; it cannot remove the model API latency.
Evaluation stage timings and synthetic warm/cold timing receipts distinguish those
costs. No proxy model turn or hygiene accounting is created.

Historical side/fork messages predate the origin field. Both source export and
corpus ingestion, example retrieval, and holdout reads reject the generated `[Fork reconciliation] While ` and
`[Side prompt] While you worked,` prefixes, plus `fork_conversation` and
`side_conversation` XML tags. This recognizes known synthetic envelopes only;
unmarked historical accepted suggestions remain impossible to identify reliably.

The exact app-generated catch-up-summary question is excluded at those same
boundaries, including historical sends without an origin marker.
