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
- **Authority unreachable.** Turns go through untouched, as when a local gate
  fails. A gate outage never stops a chat. Status calls answer 502.

To gate locally again, delete the drop-in and restart the proxy:
`systemctl --user daemon-reload && systemctl --user restart claude-codex-proxy`.

Tests: "following another machine's gate" in `test/hygiene-gate.test.ts` runs a
real authority server against a follower whose own state has nothing due.
