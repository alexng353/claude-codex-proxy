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
- **Authority unreachable.** Turns still go through: a gate outage never stops
  a chat. Photos do not. Each photo in the turn is replaced with "photo not
  checked (gate unreachable); image withheld", and its hash is saved in
  `hygiene-unchecked.json` in the proxy's state directory. That photo stays
  withheld in every later request, also after the authority is back. Photos
  the authority has already ruled on are withheld from its last known state.
  Status calls answer 502. The follower waits up to 85 s for a decision, below
  the model router's 90 s.
- **Loop guard.** Requests between proxies carry `x-hygiene-gate-hop`. A
  follower that receives one answers 508, so two followers pointed at each
  other fail at once instead of looping.

To gate locally again, delete the drop-in and restart the proxy:
`systemctl --user daemon-reload && systemctl --user restart claude-codex-proxy`.

Tests: "following another machine's gate" in `test/hygiene-gate.test.ts` runs a
real authority server against a follower whose own state has nothing due.
