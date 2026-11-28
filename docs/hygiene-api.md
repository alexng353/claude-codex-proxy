# Hygiene API (for Cairn)

Cairn uses this API to send hygiene proof photos and to read the gate. The gate checks a photo sent here exactly as it checks a photo sent in a chat. When a photo passes, the chat lock opens at once.

## Connection

- **Base URL:** `https://arch.taildf19.ts.net:4720/hygiene/api/v1`. It is reachable only on the tailnet, through Tailscale Serve. Nothing else on the proxy can be reached through that port.
- **Auth:** `Authorization: Bearer <relay device token>`. Use the same token the app uses for the Cairn relay. The proxy checks the token with the relay's `GET /v1/whoami` and caches the result for 5 minutes. Devices with the role `phone`, `admin` or `plate` are allowed. `agent` devices are refused.
- **Errors:** errors are JSON in the form `{"error": "<message>"}`:
  - `400` bad input
  - `401` no token, or an unknown or revoked token
  - `403` agent device
  - `404` not found
  - `413` image larger than 25 MB
  - `503` the relay is unreachable, so the token can't be checked, or the gate is turned off (`POST /proofs` only)
- **Times:** times are ISO 8601 in UTC. Days are `YYYY-MM-DD` in America/Vancouver.

## POST /proofs

Sends one proof photo.

```json
{ "kind": "teeth_morning", "image": "<base64 or data:image/jpeg;base64,...>", "media_type": "image/jpeg", "sent_at": "2026-11-14T18:44:30.000Z" }
```

- **`kind`** is one of:
  - `teeth_morning`: from 05:00
  - `weight_morning`: from 05:00, a photo of the bathroom scale's reading, once weigh-ins are enabled
  - `creatine_morning`: from 05:00, a photo of creatine being taken, once `creatineStartsAt` is set
  - `walk_morning`: from 05:00, an outdoor photo, once `walkStartsAt` is set. The first fills `<day>/morning-walk-start`; one checked 15 or more minutes later (by receipt time) fills `<day>/morning-walk`. Sooner is `rejected`
  - `penance` (since 2026-11-03): a photo for the oldest unpaid penance in `open_debts`, judged against its `description`; it fills `penance/<debt id>` and pays it. With none open it is `not_due`. A request can't name which penance; send them oldest first
  - `teeth_night`: from 17:00 that day, or an overdue night requirement from the day before
  - `shower`: any time that day, or an overdue shower requirement from the day before

  The photo can fill only a requirement of the stated kind. The classifier still has to see that kind in the photo.
- **`image`** holds the original file bytes, with EXIF kept if possible. The gate uses EXIF `DateTimeOriginal` (with `OffsetTimeOriginal`), when present, to reject photos taken more than 30 minutes before sending.
- **`sent_at`** (since 2026-11-15, optional): when Alex pressed send, as an ISO time with `Z` or an offset (`2026-11-14T18:44:30.000Z`), or epoch milliseconds as a JSON number. Send it for a proof that waited in a queue while the gate was unreachable: the 30 minutes are then counted up to `sent_at`, not to when the gate got the photo. The gate believes `sent_at` only up to 3 hours before it receives the photo; an earlier one is ignored and the gate's own clock is used, and a later one counts as the moment of receipt. Which requirement the photo fills still goes by receipt time. Anything that is not a time is `400`.
- **`media_type`** is optional and is ignored when `image` is a data URL. The default is `image/jpeg`. HEIC is accepted and stored, but convert to JPEG if you can: the classifier reads JPEG, PNG, WebP and GIF reliably.

A check takes about 5 to 10 seconds. Send the same bytes again and you get the first verdict back without a new check, so retrying after a timeout is safe.

Response (`200`, also when the photo fails):

```json
{
  "result": "pass",
  "verdict": "accepted",
  "message": "✅ morning teeth (Oct 7) photo accepted.",
  "slot": "2026-10-07/morning-teeth",
  "sha256": "<64 hex>",
  "gate": { "...": "same shape as GET /status" }
}
```

- **`result`** is `pass` or `fail`.
- **`verdict`** is one of:
  - `accepted`: the photo passed and filled a requirement
  - `rejected`: wrong kind, unclear, or not a proof
  - `duplicate`: an exact or near copy of an earlier proof
  - `stale`: the EXIF capture time is too old
  - `unneeded`: a real proof, but nothing of that kind was due
  - `not_due`: nothing of that kind is due right now; the photo was not checked
  - `error`: the classifier failed; send the photo again
- **`message`** is a line you can show the user as it is.

## GET /status

```json
{
  "enabled": true,
  "state": "armed",
  "badge": 1,
  "now": "2026-10-07T12:05:00.000Z",
  "today": "2026-10-07",
  "outstanding": [{ "slot": "2026-10-07/morning-teeth", "kind": "teeth", "label": "morning teeth photo" }],
  "due_today": [{ "slot": "2026-10-07/shower", "kind": "shower", "label": "shower photo (before midnight)" }],
  "bypass": { "count": 0, "active_until": null },
  "delay": { "active": false, "expires_at": null, "count": 0 },
  "moves": [],
  "max_moves_per_day": 2,
  "open_debts": []
}
```

- **`state`:**
  - `armed`: chats are locked
  - `clear`: nothing is locked
  - `bypassed`: locked, but a BYPASS hour is open
  - `disabled`: the kill switch is on
- **`badge`** (since 2026-11-15) is the number for Cairn's app icon badge: the length of `outstanding` while `state` is `armed`, else 0. A change in it wakes the phone (silent push), so the icon follows the gate without Cairn being opened. A status read that fails should leave the badge as it is.
- **`outstanding`** lists what locks the gate now. Its `kind` is `teeth`, `shower`, `weight`, `creatine`, `walk`, `penance` or `gym`. A `gym` item (slot `gym/<plan id>`, since 2026-11-02) is a planned gym session with no qualifying Uplifting session, for at most 24 h. This API has no gym kind for proofs; a geotagged gym photo counts only when sent in a chat (README, gym sessions).
- **`due_today`** lists what is due later today but does not lock yet, including today's planned gym sessions and one in progress.
- **`open_debts`** lists BYPASS uses (and, since 2026-11-05, moves not kept by midnight, or by 04:00 for last night's overdue photos) that the model has not ruled on yet, or penances that are still unpaid: `{ id, at, skipped[], status: "open" | "penance", penance?: { description, setAt }, source: "bypass" | "move" }`. A penance photo is sent as kind `penance` (oldest first) or in a chat.
- **DELAY and BYPASS** are typed as chat messages, not sent through this API. Status reports their counters. The one exception is the app shield's emergency button, below.
- **`moves`** (since 2026-11-05) lists today's MOVE/LATER moves, oldest first: `{ slot, from, to, by, at, deadline? }` (`deadline`, since 2026-11-26, is when an overdue night move must be kept by, 04:00 the morning after; without it, midnight), photo requirements and gym plans (`slot` `gym/<plan id>`; a gym plan's moves by an agent count too). A moved requirement leaves `outstanding` until its new time and shows in `due_today` with `: moved to HH:MM` in its label. Each item moves at most `max_moves_per_day` times a day; count an item's entries here to show how many are left. Moves are made with `POST /move` or typed in a chat.

## POST /bypass

Cairn's app shield sends this when Alex taps "Emergency, 15 min", possibly long after the tap (added 2026-11-02).

```json
{ "minutes": 15, "source": "cairn-shield", "at": "2026-11-05T13:58:00.000Z" }
```

- **`minutes`** is a whole number, 1-60. **`source`** is 1-40 letters, digits, `.`, `_` or `-`. **`at`** is the tap time; more than 5 minutes in the future, or more than 24 hours old, is refused (400, final: the phone should not retry it).
- **The window runs from the tap** (`at`, or the receive time if `at` is ahead of it), never from when the report arrives, so a late report cannot grant a fresh window. A longer BYPASS already open is never shortened.
- **Every tap is charged unless the gate can show it was free.** Charged: a debt like BYPASS (the model asks why on Alex's next turn; an unjustified ruling sets a penance), and the gate opens if the window hasn't ended yet (`applied: true`). Free (`applied: false`, `debt_id: null`): a bypass that had already started still covered the tap, or nothing locks the gate now, nothing locked it at the tap as far as the current state shows, and nothing that could have cleared a lock happened after the tap (no proof accepted, penance paid, gym session seen, gym check-in received or DELAY started). A lock that ended on its own (midnight, a stale or failed gym read) still charges. The debt's `skipped` lists the locks at the tap as inferred from the current state (it can over-state, e.g. a penance set later), or `at report: ...` when only the report time shows one. The gate keeps no full history, so it can't replay its state at the tap; when in doubt it charges, and "the shield was stale" is an answer the model can accept. Proof or a BYPASS sent after the tap doesn't make it free.
- **Idempotent on `source` + `at`:** a repeat within 7 days returns the first answer with `duplicate: true`.
- **Response 200:** `{ ok: true, applied, duplicate, until: ISO | null, debt_id: string | null, gate: <same shape as GET /status> }`. `until` is the gate's bypass end when applied (a longer one already open wins), else null. **400** `{error}` for bad input, **401/403** for auth, **503** while the gate is disabled.

## POST /move

Cairn's Hygiene "Move" button: the chat's `MOVE`/`LATER` reply (README, MOVE / LATER), added 2026-11-05. It reschedules a photo requirement, or today's gym plan, to later the same day. It is never a BYPASS: the bypass counter and debts are unchanged.

```json
{ "item": "teeth", "to": "18:30" }
```

- **`item`** is optional. Omitted, `null`, `""` or `"all"` moves every photo requirement that locks now. Otherwise one or more words: `teeth`, `morning`, `night`, `shower`, `weight`, `creatine`, `walk` (combine to narrow: `"morning teeth"`, `"night teeth"`), or `gym` for today's next gym plan. A named item that does not lock yet (this morning's photos before 05:00) can move too.
- **`to`** is a clock-shaped time on the phone's local day (24-hour `HH:MM`, `6:30pm` or `6pm`), or ISO 8601 with an offset. It must be later than now and than the item's current due time (an open DELAY counts as that time; a gym plan's current start), and before midnight. Last night's overdue shower and night teeth move only to a time before 04:00, and not at all from 04:00; otherwise the error (400) names 04:00.
- **Limits:** each item moves at most `max_moves_per_day` (2) times per local day. Penances and missed gym plans never move; a gym plan with an open Start at the gym never moves, and one that has started moves only before its start-by time (start + grace).
- **A move is a promise.** If the day ends with the moved photo still missing (04:00 for last night's overdue photos, which then leave `outstanding`), and no BYPASS of the moved lock already charged it, the gate charges an open debt (`source: "move"`) on the next status read or gated turn, which the model rules on like a BYPASS.
- **Response 200:** `{ ok: true, message, moved: [{ slot, from, to, by, at }], plan?: <gym plan>, gate: <same shape as GET /status> }`. `message` is a line to show as it is. `by` is `cairn:<device name>`. A gym move returns `moved: []` and the moved `plan`.
- **400** `{error}`: bad input, or the move was refused (another day, a time already past, a third move, nothing movable). The error says why; show it as it is. **401/403** for auth, **503** while the gate is disabled.

## Phone wake (proxy to Cairn relay)

The proxy wakes Cairn on the phone when the shield should change, so the Screen Time shield follows the gate without Alex opening the app (`src/phone-wake.ts`, added 2026-11-02).

- **What triggers it:** every 15 s the authority proxy reads its shield signature, `state` from GET /status plus `bypass.active_until`. When that differs from the last one the relay accepted, it sends a wake. Followers never send.
- **The call:** `POST $CAIRN_GATE_WAKE_URL` (default `https://truenas-scale.taildf19.ts.net:8787/v1/gate/wake`) with body `{}` and `Authorization: Bearer <token>`. The token is read at call time from `$CAIRN_GATE_WAKE_TOKEN_FILE` (default `~/.config/cairn/gate-wake.token`). With no file, wakes are off and that is logged once. The push carries nothing; the phone reads GET /status.
- **Answers:** 2xx records the signature as sent. 429 waits `Retry-After` seconds (1-600; anything else counts as a failure). Any other status or no answer backs off 30 s, doubling to 10 min, and retries with the newest signature.
- **Two copies during a handoff** share `phone-wake.json` beside the gate state under a lock, with a 15 s send claim, so only one sends.
- `HYGIENE_PHONE_WAKE=off` turns it off. A failed wake never changes the gate; the phone also refreshes on open and on its own schedule.

## GET /photos?from=YYYY-MM-DD&to=YYYY-MM-DD

Accepted proofs grouped by day, newest day first. This feeds the "photo a day" view. `to` defaults to today and `from` to 29 days before `to`.

```json
{
  "from": "2026-09-08",
  "to": "2026-10-07",
  "days": [
    {
      "day": "2026-10-07",
      "photos": [
        {
          "sha256": "<64 hex>",
          "kind": "teeth",
          "slot": "2026-10-06/night-teeth",
          "at": "2026-10-07T07:37:00.000Z",
          "manual": true,
          "url": "/hygiene/api/v1/photos/<sha256>"
        }
      ]
    }
  ]
}
```

- **`day`** is the day the photo was accepted. **`slot`** is the requirement it filled. A photo sent after midnight for the day before has a `slot` dated the day before.
- **`reading`** appears on weigh-ins: the scale reading the classifier saw, such as `"72.4 kg"`.
- **`manual: true`** marks a proof that was checked by hand and seeded into the gate, not checked by the classifier.
- **Rejected photos** are never stored and never listed.

## GET /photos/{sha256}

Returns the original stored bytes, with EXIF intact, under the matching `content-type`. Send the same bearer auth. The response is `cache-control: private, immutable`, so cache it by hash.

## GET /weight-reviews

Returns `{reviews, pending}` with the same device authentication as `/status`.
Each review contains `sha256`, `day`, `at`, `reading`, `lb`, `file`, `result`, and
`reason`. `file` is the archived photo path on the gate machine; the same photo
is available through `/photos/{sha256}`. `pending` counts undelivered accepted
weigh-ins, including those not yet scanned by the delivery worker.

A passing proof can still need review before its number reaches Cairn. The gate
verdict is independent of delivery. See [Weigh-in delivery](weight-sync.md) for
rules, deployment, and backfill.

### Gate-fault escalation (local operator routes)

`POST /hygiene/debt/:id/resolve` continues to accept existing rulings. New
rulings should include `reasonClass: "other" | "gate_fault"`. A justified
`gate_fault` requires an `item` key and an actionable `fixRef`:

```json
{"verdict":"justified","reasonClass":"gate_fault","reason":"cancel did not stick","item":"morning-walk","fixRef":{"kind":"q","id":"gate-fault-escalation"}}
```

Alternatively use `{"kind":"chat","id":"<Today chat UUID>","eta":"2026-11-05T14:00:00-07:00"}`.
The ETA must be in the future. The queue item or chat task-ledger record must
exist and be open; missing, terminal or unreadable references return HTTP 422
with an `error`. Chat references pin the ledger record selected at ruling time. Supply `task`
(the numeric ledger record) to select one explicitly. Without it, the chat
must have exactly one open ledger record; multiple open records return 422.
Success remains HTTP 200 with `{ok:true,debt}`; the debt includes the reason
class, item and fix reference. Omitted reason classes remain supported for
older callers and stored debts.

A second justified gate fault for the same item within 24 hours suspends it.
The gate owner receives one message through the existing keyed wake sender;
delivery happens outside the gate lock, with the existing retry backoff and
24-hour give-up policy. Permanent delivery failures are not retried. Queue repairs close when their
state is `done` or `cancelled`; chat repairs close when the pinned ledger record
is `cancelled`, or when it is `done` and has a receipt. Unavailable repair stores keep the
suspension active. The wake timer and phone status reads persist closed repairs.
Both `/hygiene/status` and the authenticated `/hygiene/api/v1/status` include
`suspensions` (active entries with `item`, `at`, `debtId`, `fixRef`, and optional
`notificationQueuedAt`) and `cancellations` (item keys mapped to `{at,reason}`).
This exposes suspension data to Cairn; displaying a dedicated suspension banner
requires a Cairn client change.

`POST /hygiene/items/:item/cancel` with `{"reason":"no longer required"}`
cancels a recurring item immediately and returns HTTP 200
`{ok:true,item,at,reason}`. Repeating a cancellation preserves its original time.
Keys: `morning-teeth`, `night-teeth`, `shower`, `morning-weight`,
`morning-creatine`, `morning-walk`. Unknown keys return 404; a missing reason
returns 422. Cancellation removes existing and future lock text and proof slots;
old bypass debts remain available for explicit resolution. There is no resume
endpoint in this change. Gym's deliberate late-cancel rule is unchanged.

### Skips (Nov 10)

A skip excuses one requirement: a gym plan (status `skipped`, never a miss, never
locks, before or after its start) or one day's photo. Skips come from an agent's
judgement, never from a keyword Alex types to the gate.

- A justified ruling (`/hygiene/debt/:id/resolve` or `/revise`) skips the gym plans the
  bypass covered (a `gate_fault` ruling: only its faulty item). Photos stay due unless
  the ruling adds `"skip":true` (every covered item) or a list of item keys; `"skip":false`
  skips nothing. Only what the BYPASS captured as locking is skipped (a move debt: its
  `moveSlot`); an Emergency-tap debt, whose items are inferred, skips nothing by ruling
  (use `/hygiene/skip`). The debt records `skippedItems`; the response lists `notSkipped`.
- A penance slot `penance/<debt id>` names its debt: the id is everything after
  `penance/` (`penance/bedtime-1795801383756-52` is debt `bedtime-1795801383756-52`,
  not the bypass number). To lift a penance, revise that debt
  (`POST /hygiene/debt/<debt id>/revise` `{"verdict":"justified","reason"}`, within 12 h of
  its ruling). Since Nov 28, a justified ruling (`resolve` or `revise`) on a BYPASS that
  covered the penance also retires it when it adds `"skip":true` or lists `penance/<debt id>`:
  the penance debt becomes `justified`, its old verdict goes to `history`, and the ruled
  debt records `retiredPenances`. Without skip the penance stays due and locks again when
  the bypass ends. A shield (Emergency-tap) or move debt retires none.
- `POST /hygiene/skip` `{target, by, reason}` skips ahead of time or after the fact.
  `target` is `gym/<plan id>` or `YYYY-MM-DD/<item>` (the keys above, from yesterday
  to 31 days ahead). `POST /hygiene/unskip` `{target, by}` undoes it. Penances never
  skip. Also `POST /hygiene/gym/plans/:id/skip|unskip`, MCP `gym_plan_skip`, and
  `scripts/gym.ts skip ID --reason TEXT`.
- MCP (the `gym` server, `src/hygiene-mcp.ts`, Nov 20): `hygiene_status` (today's
  items in the gate's local day, what locks now, skips, bypass count, open debt
  count; never BYPASS words), `hygiene_skip {target | item, reason}` and
  `hygiene_unskip {target | item}`. `item` means today in the gate's day; a blank
  reason is refused before any request. `by` is `chat:<codex thread id>` from the
  call's `_meta.threadId` (Codex stamps it), else `<GYM_BY> (unattributed)`. These
  tools reach only `GET /hygiene/status` and `POST /hygiene/skip|unskip`; every call
  is logged to `$PROXY_STATE_DIR/hygiene-mcp.jsonl`.
- `/hygiene/status` and `/hygiene/api/v1/status` include `skips`: entries from
  yesterday on with `target`, `day`, `item` (`gym/<id>` for plans), `at`, `by`,
  `reason` and optional `debtId`. Gym plans in `/hygiene/gym` show `skipped`.
- A skip after an Emergency tap counts as a change since the tap, so the tap is charged.

The authority reads `~/.local/state/today-ops/queue.sqlite` and
`~/.local/state/today/daemon.sqlite` in read-only mode. Operators may override
these locations with `HYGIENE_QUEUE_DB` and `HYGIENE_TASK_DB`.

Shield reports mark their inferred item lists with `itemsComplete:false`;
an operator may identify a valid fault item missing from that partial list.
A terminal chat record without a receipt cannot be attached to a new ruling;
an already attached `done` repair stays suspended until that receipt exists.
Status exposes `repairStatus:"awaiting_receipt"` and one additional keyed owner
notice requests the missing receipt. Cancelled chat records close without a receipt.

Recurring slots that first arm within a suspension window remain unenforced
after the repair closes; previously armed slots can resume. Ordinary leniency
revisions use `reasonClass:"other"` and preserve the previous classification in
the debt history, rather than inheriting an untracked fault classification.

## Bedtime exceptions

Cairn owns its bedtime schedule, app selection and enabled setting. No server
registration is needed. Bedtime grants never open or arm the hygiene gate. Keep
sending `X-Device-Time-Zone` on status reads. The existing gate-wake push prompts
another status read when a bedtime grant starts, changes or expires.

`GET /status` adds optional `bedtime_unlock_until`, an ISO UTC timestamp. It is
omitted when there is no active grant. During its local bedtime schedule, the
phone stays shielded unless it has an unexpired grant or its own emergency tap.
The phone must schedule expiry locally; push delivery is not guaranteed.

### POST /bedtime/free

Phone-authenticated `{ "id": "stable-request-id" }` grants one free 15-minute
bedtime unlock per local calendar day. The gate uses its phone-zone history and
system tzdata. `bedtime_free` in status contains `available`, `day`, `zone`, and
`used_at` when used; `bedtime_unlock_until` carries the existing grant.

This writes a receipt (`id`, authenticated `by`, `at`, `until`, `zone`, `day`) in
`bedtime.freeUnlocks`, with no debt, bypass count, Bubble ruling, hygiene unlock,
or adult-filter pause. Retrying the same caller/id returns the original receipt
without extending it, even after expiry. A different request that day returns
409; the existing paid BYPASS path is unchanged. An active bedtime grant also
returns 409 without consuming the allowance.

A grant straddling midnight belongs to its start day. After a zone change, a
receipt consumes the allowance if its recorded calendar date matches today or
its start falls within today's interval in the new zone. It also remains spent
until the day it started has ended in its original zone. Moving the clock's zone
therefore cannot restore a free unlock within the same day. The additional
origin-day hold lasts less than 24 hours, bounded by the origin midnight; the
existing destination-date checks still apply after that.

Cairn installs an independent DeviceActivity expiry before lifting shields. Its
existing schedule rounds up to the next minute, so actual re-lock can trail the
proxy expiry by less than a minute plus iOS callback delivery time. The proxy
already considers the grant expired in that tail, and the free allowance stays
used. Physical-device delivery while the app is killed requires device testing.

### POST /bedtime/request

```json
{ "id": "<new UUID>", "reason": "I need to call a taxi" }
```

`id` is 1–80 letters, digits, `.`, `_`, `:`, or `-`. The trimmed reason is 1–1000
characters. A successful response is:

```json
{ "ok": true, "id": "<UUID>", "status": "pending", "duplicate": false, "message": "Request sent to Bubble. Waiting for permission.", "gate": {} }
```

`gate` has the same shape as status. Acceptance grants nothing. The proxy saves
the request and wakes Bubble with its id and reason. Repeating the id and reason
returns the stored request with `duplicate: true`; changing its reason is `409`.
Request receipts are retained for idempotency; an old id never becomes a fresh request.
Use a new id for a new request. Status is `pending`, `approved`, `denied`, or
`expired`. A pending request expires after 15 minutes; a later approval is refused.

Bubble's `gym` MCP server supplies `bedtime_unlock_approve` and
`bedtime_unlock_deny`, each taking `{id, reason}`. Only Bubble's Codex-stamped
calling chat may use them. They use local administrative proxy routes, protected
by the existing proxy API key when configured; these routes are not exposed by
Tailscale Serve or the Cairn API. As with the rest of the gate, local shell and
proxy administrator access are trusted, not a sandbox against other local agents.

Approval opens 15 minutes from the decision and records an open bypass debt with
item label `bedtime`, plus the decision's reason and caller. Denial opens nothing.
Repeating a decision is idempotent, including after its grant expires; reversing
one is `409`. A new approval can extend the current grant to now plus 15 minutes,
never add 15 minutes to its existing end. Bedtime debts cannot excuse or suspend
hygiene items through a fault ruling. Their usual justified/unjustified rulings
and penance remain available.

### POST /bedtime/bypass

```json
{ "phrase": "BYPASS" }
```

A bare `BYPASS` or incorrect words return `200` with
`{ok:true, granted:false, message:"Type BYPASS <three words> ...", gate:{...}}`.
Display `message`. Submit the complete phrase, including `BYPASS`, to grant 15
minutes and record a bypass debt. That response has `granted:true` and the expiry
in `gate.bedtime_unlock_until`. Poll status to apply it. An active grant returns
its original expiry without another charge or extension. The bedtime challenge
uses the existing three-word mechanism but has its own lifecycle, separate from
the hygiene challenge. Words are not exposed in status or agent tools.

### Offline emergency taps

Use the existing `POST /bypass` journal with `source: "cairn-bedtime"` while bedtime
is actively shielding. Preserve the source and original `at` on retry. This source
always counts, even when hygiene is clear or bypassed. The window is capped at 15
minutes from the original tap (`minutes` still accepts the existing 1–60 range).
A late report records the count and debt but opens no fresh window. Duplicate
source/time reports return their original result and never charge again. Existing
24-hour report age and 5-minute clock-skew bounds still apply; a permitted future
tap is anchored to receipt time. Other journal sources keep their prior behavior.

All bedtime mutations return `503` while the gate's terminal kill switch is set.
Existing clients can ignore the added status field; old proxy copies preserve the
optional stored bedtime state but cannot serve the new endpoints. Deploy the proxy
before enabling bedtime in Cairn.

## Screen Time diagnostics

`POST /screen-time/status` accepts this config-only report using the usual Cairn
bearer token. Every field is required, including fields whose value may be null.

```json
{
  "version": 1,
  "build": "123",
  "reported_at": "2026-11-24T10:00:00Z",
  "authorization": "approved",
  "time_zone": "Asia/Jakarta",
  "bedtime_enabled": true,
  "late_start_minute": 1380,
  "full_start_minute": 0,
  "wake_minute": 420,
  "late_app_count": 2,
  "late_category_count": 0,
  "late_web_count": 0,
  "allowlist_app_count": 1,
  "allowlist_category_count": 0,
  "allowlist_web_count": 0,
  "scheduled_at": null,
  "adult_filter_enabled": true,
  "adult_filter_applied": true,
  "adult_filter_unlock_until": null
}
```

Bodies are limited to 4096 bytes, including whitespace (`413` when exceeded).
Unknown fields, including client identity, are rejected with `400`; app names,
tokens, URLs and browsing data have no accepted fields. `build` is at most 64
characters; `time_zone` is a recognized IANA zone, at most 64 characters.
`authorization` is `approved`, `denied` or `notDetermined`. Minutes are integers
0–1439 and counts are integers 0–10000. All enabled/applied fields are booleans.
Timestamps are zoned ISO datetimes; `scheduled_at` and the reported unlock may
be null. Success is `200 {"ok":true}`.

The server stamps `device_id` from authentication and `received_at` from its
clock. Each device has only its latest received report, with no history.
`GET /hygiene/status` and the read-only `hygiene_status` MCP tool expose the most
recently received device report as `screen_time`, or null before any report.
`stale` is true when its server receipt is more than 24 hours old. Phone-reported
times are diagnostic, including the unlock field: they never create a grant,
change the hygiene zone or affect enforcement. Telemetry remains available when
the hygiene kill switch is set. Cairn tolerates unavailable telemetry and keeps
its own enforcement unchanged.

## Adult-filter bypass

`POST /adult-filter/bypass {"phrase":"BYPASS"}` returns the same challenge flow
as bedtime: `200 {ok:true, granted:false, message, gate}`. Correctly submitting
the complete phrase grants 15 minutes and returns `granted:true`. Its phrase and
expiry are independent of bedtime and hygiene. Repeating a request while the
grant is active returns the original expiry and does not charge or extend it.
There is no adult-filter request, approval, denial or agent grant tool.

The authoritative optional `adult_filter_unlock_until` appears in phone status,
local status and every embedded phone `gate` response only while unexpired. A
change or expiry triggers the existing phone wake mechanism. Cairn must also
schedule expiry locally. Bedtime grants, Bubble approvals, hygiene bypasses and
reported telemetry cannot open the adult filter. An adult-filter grant cannot
open bedtime or hygiene.

Each successful grant increments the shared bypass count/history and creates an
open debt with `kind: "adult-filter"`, also shown in open-debt status. Such debts
can receive ordinary justified/unjustified rulings and penance, but cannot excuse
or suspend hygiene items. The existing public debt `source` retains its meaning.
The adult-filter bypass remains available and counted when the hygiene kill switch
is set; its active grant still appears in status. Bedtime behavior is unchanged.
