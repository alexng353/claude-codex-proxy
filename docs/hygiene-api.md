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
- **`open_debts`** lists BYPASS uses that the model has not ruled on yet, or penances that are still unpaid: `{ id, at, skipped[], status: "open" | "penance", penance?: { description, setAt } }`. A penance photo is sent in a chat; this API has no penance kind.
- **DELAY and BYPASS** are typed as chat messages, not sent through this API. Status reports their counters. The one exception is the app shield's emergency button, below.

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
