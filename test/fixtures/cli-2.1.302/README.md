These stdout fixtures were captured from Claude Code 2.1.302 by the review's
loopback API stub (2026-10-28). The stub used fake tokens and returned controlled
OAuth/usage responses; no real accounts were used. Source: reviewer scratch
`101181-halal-opus/runs/<scenario>/stdout`. Streams are unchanged. Paths and
session IDs are historical fixture data, not directories tests should create.

`m-dead`: CLI dead-token marker. `m-empty`: empty OAuth object.
`m-refresh-dead`: refresh invalid_grant. `m-refresh-500`: transient refresh error.
`m-revoked`: fresh bearer rejected. `m-u429`: usage endpoint rate limited.
`m-fresh200b`: successful usage meters. `m-turn-fresh401`: model turn auth error.

Replay helpers may advance meter reset dates to keep fixtures useful after their
capture date. Other parser and diagnostic edge cases use explicitly labelled synthetic data.

`m-turn-refresh500`: a transient refresh 500 followed by a model-turn 401 with
an expired access token. This must back off routing without demanding login.
