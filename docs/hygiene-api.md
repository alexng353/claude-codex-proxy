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
- **`outstanding`** lists what locks the gate now. Its `kind` is `teeth`, `shower` or `penance`.
- **`due_today`** lists what is due later today but does not lock yet.
- **`open_debts`** lists BYPASS uses that the model has not ruled on yet, or penances that are still unpaid: `{ id, at, skipped[], status: "open" | "penance", penance?: { description, setAt } }`. A penance photo is sent in a chat; this API has no penance kind.
- **DELAY and BYPASS** are typed as chat messages, not sent through this API. Status reports their counters.

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
- **`manual: true`** marks a proof that was checked by hand and seeded into the gate, not checked by the classifier.
- **Rejected photos** are never stored and never listed.

## GET /photos/{sha256}

Returns the original stored bytes, with EXIF intact, under the matching `content-type`. Send the same bearer auth. The response is `cache-control: private, immutable`, so cache it by hash.
