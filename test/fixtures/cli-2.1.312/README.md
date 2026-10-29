This minimal synthetic fixture reconstructs the meter-less success reported on
Arch with Claude Code 2.1.312 on 2026-10-28. It is not a captured stdout transcript.
No credentials, account data, or usage amounts are included.

Read-only inspection of Arch's installed 2.1.312 binary confirmed that the
structured twin still uses usage_report.rate_limits.limits. Its builder permits
rate_limits:null and limits:null, and can omit the twin if schema validation
fails. The text can contain "What's contributing to your usage?" independently
of the subscription meters. The existing 2.1.302 successful-meter fixture covers
the same structured format; this inspection did not exercise a live account.
