# Composer prediction corpus and model calls

The authenticated, loopback-only `POST /composer-predictions` route predicts one
short next message. It runs outside the Responses API turn path and the hygiene
gate. It never writes a conversation, sends a message, or executes model tools.

## Bounds and account use

Each thread/turn pair receives one persistent attempt claim, including failures.
There is no retry or fallback. At most two requests run concurrently, including
retrieval. Generation uses the existing subscription account environment with
billing/API-key variables removed, Haiku, low effort, no tools, no session
persistence. One absolute deadline covers preparation, retrieval, generation, and output checking: the earlier of the caller deadline and 12 seconds after receipt. Output must be a short single-line string
inside a JSON prediction response; null or invalid output produces no suggestion.

The shared prompt builder keeps the last 3,000 context characters and at most
two example pairs (500 assistant characters and 200 reply characters each).
Corpus examples are independently opt-in (`corpusEnabled: true`); the default is no examples. The shared runtime/evaluation boundary checks raw context and each raw example field before JSON escaping or truncation, and checks
the prediction before return. The local usage log contains time, model, duration,
and whether a suggestion was produced; it contains no message text.

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
