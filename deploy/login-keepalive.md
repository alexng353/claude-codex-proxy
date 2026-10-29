# Login renewal and warnings

The proxy's usage probe is the keepalive. Every 12 minutes it runs the local,
quota-free `/usage` command for every account, including accounts skipped for
quota or routing. There is no separate timer or model-turn fallback. Use Claude
Code 2.1.282 or newer; older versions are refused.

Claude owns credential refresh and locking. Refresh renews the access token but
does not extend `refreshTokenExpiresAt`. A warning during the three days before
that deadline gives time to sign in again. Stale expiry metadata and deadlines
already in the past do not produce expiry warnings; a dead login produces an
authentication warning instead.

Warnings persist per account name and directory. Delivery retries on failure;
a successful delivery suppresses another warning for six hours unless the
credentials file changes. A cross-process lock prevents concurrent sends, and
in-process memory prevents repeated sends if recording delivery fails. A crash
between sending and recording success can still duplicate a warning until Today
supports an idempotency key. The sender receives the incident ID for that future
integration.

No credentials, diagnostic bodies, or bearer tokens enter warning text or state.
See the README for the account status fields and sign-in behavior.
