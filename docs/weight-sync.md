# Weigh-in delivery to Cairn

Accepted weigh-in photos carry their reading, EXIF capture time, and a durable
`cairnWeightPending` marker in the gate state. The worker scans these records at
startup and every minute. It journals each photo hash in
`<HYGIENE_GATE_STATE>.weights.sqlite`; delivery failures remain pending across
restarts. The gate verdict does not depend on Cairn availability.

The Cairn day is the capture date in America/Vancouver. EXIF DateTimeOriginal
wins; without EXIF, the gate receipt time supplies the date. Older accepted
photos are read from the archive with their original EXIF and checked against
the stored SHA-256. The existing unit-aware parser converts kilograms to pounds
and rounds to one decimal place. No-unit readings require review.

A value needs review when it cannot be parsed, falls outside 60–600 lb, differs
from an existing entry on that day, or differs by more than **5 lb OR 3%** from
the mean of available entries in the **preceding seven calendar days**. Without
prior entries in that window, use the last prior weight within 30 days. Without
either baseline, the first entry needs review. A matching daily
weight is skipped without changing its timestamp. Reviews retain the photo.

## Write path and deployment

Cairn's ordinary agent policy forbids all settings writes. Deploy the companion
Cairn relay change before enabling this worker. It adds authenticated routes:

- `GET /v1/weights`: `{settings: {"weight.YYYY-MM-DD": {lb, at}, ...}}`.
- `POST /v1/weight-proofs`: `{sha256, day, lb, at}` from the configured gate agent device.
  Returns `{result, reason?}` where result is `written`, `skipped-existing`, or
  `needs-review`. Invalid input is 400, forbidden identities 403, paused agents 423.

Set `CAIRN_WEIGHT_AGENT_ID` on the relay to the exact gate agent device ID. Both
weight routes refuse other identities, including admin tokens, and fail closed
when this setting is absent. Timestamps must be valid ISO calendar times within
the last 45 days and no more than ten minutes in the future.

The relay validates the date, range, pause switch, existing entry, and jump rule
against canonical data before appending a normal replicated setting op. This
check and append contain no asynchronous gap, so a simultaneous phone write
cannot slip between them. The operation id is `weight-proof:<sha256>` and its
actor is `system`: this is a narrow relay operation, not general permission for
agents to change settings. Ordinary agent pushes remain restricted. The stored
value is the same `{lb, at}` shape as a manual iOS weigh-in.

A hand entry composed offline may arrive with an older HLC after the photo op.
The relay atomically records that non-system op and re-emits its value in a later
system op, then logs the original and promoted IDs. Both ops sync in order and
replays are deduplicated. iOS accepts the string IDs; no iOS change is needed.

Set `HYGIENE_CAIRN_AGENT_CONFIG` to a protected Cairn agent configuration file on
the gate machine. It has the existing Cairn shape `{token, endpoints: [{url,
headers?}]}`. Reuse an authorized agent device or provision one through Cairn's
normal device tooling; keep tokens out of shell arguments and logs. Both proxy
slots must use the same gate state and configuration. Remote gate followers do
not start delivery. The worker and backfill share a process lock, and graceful
proxy draining waits for an in-flight delivery scan.

New proofs queue even before configuration is installed. Older proofs without
the marker are imported only by the backfill command, so deploying the worker
does not silently import history.

## Backfill

Run on the machine holding the gate state and archived photos:

```sh
bun scripts/backfill-weights.ts --dry-run --config /protected/cairn-agent.json
bun scripts/backfill-weights.ts --config /protected/cairn-agent.json
```

Use `--state /path/to/hygiene-gate.json` for an alternate gate store and
`--backup-dir /private/directory` for backups. Every run first saves all
`weight.*` settings to a new timestamped JSON file with mode 0600. Failure to
read or back up settings stops the command before any delivery.

Dry runs **do write a local timestamped backup JSON file**. They do not change
the gate, delivery journal, or Cairn. The table uses
`written` to mean **would write**. It evaluates photos in capture order using
projected earlier writes as the later photos' baseline. It prints every photo
path, reasons, and totals. The live relay rechecks every actual write, so a
manual entry added after preview is protected.

Before the relay upgrade, export the `weight.*` settings from a read-only relay
snapshot and preview with:

```sh
bun scripts/backfill-weights.ts --dry-run --settings /private/exported-weights.json
```

`--settings` accepts a plain key-to-value JSON object and is refused without
`--dry-run`. It must never be used as authority for a live write.

Review rows are terminal; automatic retries cannot resolve an ambiguous number
or replace a hand entry. Inspect the archived photo and resolve the number in
Cairn manually. The journal retains the review as an audit record. Pending
network writes and HTTP 423 retry automatically; other HTTP 4xx responses
become review rows with the status code. Each row logs its first failure once,
including across restarts. The review endpoint reads existing tables without
creating a missing database or table. The backfill command exits nonzero if any
rows remain pending. Repeated backfills reuse the same journal and photo hashes.

## Rollback

Unset `HYGIENE_CAIRN_AGENT_CONFIG` and hand off the proxy to stop new delivery.
Keep the gate state, journal, photo archive, and JSON backups. Removing the
relay routes stops delivery without affecting normal Cairn sync. Already added
weights remain ordinary settings; use the backup and delivery journal to review
any requested data rollback rather than replacing the entire settings table.
