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
{ "kind": "teeth_morning", "image": "<base64 or data:image/jpeg;base64,...>", "media_type": "image/jpeg" }
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
- **`image`** holds the original file bytes, with EXIF kept if possible. The gate uses EXIF `DateTimeOriginal`, when present, to reject photos taken more than 30 minutes before sending.
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
  "now": "2026-10-07T12:05:00.000Z",
  "today": "2026-10-07",
  "outstanding": [{ "slot": "2026-10-07/morning-teeth", "kind": "teeth", "label": "morning teeth photo" }],
  "due_today": [{ "slot": "2026-10-07/shower", "kind": "shower", "label": "shower photo (before midnight)" }],
  "bypass": { "count": 0, "active_until": null },
  "delay": { "active": false, "expires_at": null, "count": 0 },
  "moves": [],
  "open_debts": []
}
```

- **`state`:**
  - `armed`: chats are locked
  - `clear`: nothing is locked
  - `bypassed`: locked, but a BYPASS hour is open
  - `disabled`: the kill switch is on
- **`outstanding`** lists what locks the gate now. Its `kind` is `teeth`, `shower`, `weight`, `creatine`, `walk`, `penance` or `gym`. A `gym` item (slot `gym/<plan id>`, since 2026-11-02) is a planned gym session with no qualifying Uplifting session, for at most 24 h. This API has no gym kind for proofs; a geotagged gym photo counts only when sent in a chat (README, gym sessions).
- **`due_today`** lists what is due later today but does not lock yet, including today's planned gym sessions and one in progress.
- **`open_debts`** lists BYPASS uses that the model has not ruled on yet, or penances that are still unpaid: `{ id, at, skipped[], status: "open" | "penance", penance?: { description, setAt } }`. A penance photo is sent as kind `penance` (oldest first) or in a chat.
- **DELAY and BYPASS** are typed as chat messages, not sent through this API. Status reports their counters. The one exception is the app shield's emergency button, below.
- **`moves`** (since 2026-11-05) lists today's MOVE/LATER moves, oldest first: `{ slot, from, to, by, at }`. A moved requirement leaves `outstanding` until its new time and shows in `due_today` with `: moved to HH:MM` in its label. Each item moves at most twice a day; count an item's entries here to show how many are left. Moves are made with `POST /move` or typed in a chat.

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
- **`to`** is a 24-hour `HH:MM` (or `6:30pm`) on the phone's local day, or ISO 8601 with an offset. It must be later than now and than the item's current due time, and before midnight.
- **Limits:** each item moves at most twice per local day. Penances and missed gym plans never move; a gym plan that has started moves only before its start-by time (start + grace) or while its Start at the gym is open.
- **A move is a promise.** If the day ends with the moved photo still missing, the gate charges an open debt (`source: "move"`) on the next gated turn, which the model rules on like a BYPASS.
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
