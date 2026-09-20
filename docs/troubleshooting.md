# Troubleshooting and Recovery

## The provider does not appear

Check that the package is linked to the OMP profile you actually started and
restart OMP after changing the link.

## `/cruxomni setup` says setup is unavailable

The wizard is interactive-only. Run it in an OMP TUI session, not a headless
job. A non-TUI host can still use the paired environment binding for runtime
discovery.

## Environment binding is rejected

Verify that `OMP_OMNIROUTE_BASE_URL` and `OMP_OMNIROUTE_API_KEY` are both set.
Userinfo, query strings, fragments, unsupported schemes, and unapproved remote
HTTP are rejected.

## Setup saved a draft or remains auth-only

This means endpoint reachability, native persistence, readback, or activation
did not complete. A URL-only draft never contains a runtime key. Sign in again
through OMP's native masked prompt, then run `/cruxomni refresh`; do not test a
new key against an old endpoint manually. A pending marker after process exit
is deliberately fail-closed and requires fresh sign-in.

## Models are stale or missing

Run `/cruxomni refresh`. A valid empty live catalog removes the extension-owned
rows for that cycle; a failed or malformed response is not treated as an empty
success. Endpoint or credential-generation changes cancel in-flight discovery
and prevent stale rows from making a request. OMP 18.2.x may retain its own
provider-name selector rows until the host refreshes them; this extension
cannot disable that host cache.

## Administration says an operation is unavailable

Enable administration in the optional setup section and bind a separate
management credential. Then inspect the operation's reason in the UI. The
operation registry is visible for audit, but only entries in
`contracts/release-eligibility.json` with matching pinned-source and behavior
evidence can be read, planned, applied, or dispatched. A valid generic schema
is not sufficient evidence. No retry or gateway request is made for an
unavailable operation.

## Credential or config recovery

Use `/cruxomni setup` to forget only the affected optional credential, or use
`/cruxomni-admin logout` to clear the administration session. Never edit a key
into `omniroute/config.json`. If the private config file is corrupt or has
loose permissions, repair it while OMP is stopped and restart; the extension
will not silently reset a conflicting or insecure file.

When reporting a problem, include package/OMP versions, command and sanitized
error code. Remove keys, cookies, authorization headers, account identifiers,
local paths, endpoint hostnames, request bodies, and transcripts first. See
[SECURITY.md](../SECURITY.md) before sharing a reproduction.
