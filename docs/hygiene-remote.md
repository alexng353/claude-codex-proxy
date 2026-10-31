# One hygiene gate across machines

Alex runs this proxy on two machines: arch (Codex Desktop) and Forge (Today). Each
proxy used to keep its own gate state. Cairn's proofs reached only arch's, so on
Oct 21 Forge's gate stayed armed all afternoon and answered Alex's Today turns with
the lock text instead of the model.

Forge now holds the only gate. Any other proxy follows it:

- **Set `HYGIENE_GATE_REMOTE`** to the authority's base URL. On arch it is
  `http://127.0.0.1:3466`, an SSH tunnel to Forge's `127.0.0.1:3456`
  (`hygiene-gate-tunnel.service`). The setting lives in the drop-in
  `~/.config/systemd/user/claude-codex-proxy.service.d/hygiene-remote.conf`.
- **Turn decisions.** Every gated turn asks the authority's `POST /hygiene/gate`
  with the header `x-hygiene-gate-only: 1`. The authority answers with a decision
  only: respond with the lock text, or forward with the (rewritten) request. The
  follower still preloads skills and runs Claude itself.
- **Routes pass through.** `/hygiene/*` (status and debt rulings) and Cairn's
  `/hygiene/api/v1` are passed to the authority, which checks the Cairn token. The
  bearer token and content type go along, but proxy-hop headers do not.
- **Plate activity** reads the authority's state from `GET /hygiene/state` (local
  callers only; 403 through Tailscale Serve), cached for 30 s.
- **Authority unreachable or state unreadable.** Turns and unknown photos still
  go through. Each image keeps its original content, with a short adjacent note:
  `[hygiene-gate: photo not checked yet (gate unreachable)]`. Connection errors,
  non-success responses and decision timeouts all use this behavior. Status
  calls still answer 502. The follower waits at most 85 s for a decision, below
  the model router's 90 s.
- **Recovery.** `hygiene-unchecked.json` retains each delivered photo's hash,
  image URL/data URL and receipt time. The file is private (0600), atomically
  replaced and locked across proxy copies. A background worker retries on startup
  and every 30 s, independently of chat requests. The authority's local-only
  `POST /hygiene/recheck` uses its normal serialized proof checks, with the
  original receipt time for slots and EXIF age. A stable hash-based source makes
  retries after a lost acknowledgement idempotent. Classifier errors keep the
  entry pending. Acknowledged entries lose their image data; delivered hashes
  remain so history never loses an image already shown to the model. URL images
  remain unclassified, matching the existing gate's inline-image-only checker.
- **Existing verdicts.** Photos the authority already withheld still get their
  normal marker, including during outages when the follower has cached that
  verdict. This covers duplicate proofs and photos classified as a hygiene kind,
  including accepted, unneeded and rejected hygiene proofs. These are withheld
  to keep bathroom/proof images out of the working model. Manual records and
  ordinary images classified as `none` retain their existing behavior. Photos
  delivered during an outage remain visible even if their later check identifies
  a hygiene proof. A reachable authority can still lock a turn for missing proofs.
- **Storage failures and upgrades.** An unreadable queue cannot block images.
  Failed writes retain pending photos in memory and are logged; a process crash
  before storage recovers can lose those unsaved photos. Legacy hash-only files
  release their old withheld images; their bytes can be queued when those images
  appear during an outage again. Historical image bytes cannot be recovered from
  the old hash alone. Deploy authority support for `/hygiene/recheck` before the
  follower: an older authority answers 404 and the follower retains its queue.
- **Loop guard.** Requests between proxies carry `x-hygiene-gate-hop`. A
  follower that receives one answers 508, so two followers pointed at each
  other fail at once instead of looping.

## Why Arch does not check locally during an outage

Keep Forge as the sole proof authority. Arch could run the classifier, but it
cannot safely award proof credit from a stale gate snapshot. Outstanding slots,
accepted hashes, near-duplicate checks, bypasses and penances can change on Forge
while the link is down. Merging independent verdicts would need a reconciliation
protocol to prevent conflicting decisions or duplicate credit. That is larger
than this delivery fix. Arch therefore delivers immediately and queues the
original photo for Forge's serialized check.

To intentionally move authority to another machine, reconcile the gate state
first and remove `HYGIENE_GATE_REMOTE` from the new authority. Use the documented
rolling handoff procedure; restarting a live proxy cuts active turns.

Tests: "following another machine's gate" in `test/hygiene-gate.test.ts` runs a
real authority server against a follower whose own state has nothing due.
