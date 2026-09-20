# Security policy

Copyright (c) 2026 Crux Experts LLC. This policy applies to the standalone
`@cruxexperts/cruxomni-omp-client` package and its published documentation.

## Reporting a vulnerability

Do **not** open a public issue, paste a credential into a ticket, or disclose a
working exploit in a pull request. Use the repository host's private security
advisory/reporting channel shown on the project's **Security** page. If that
channel is unavailable, use the project's current verified maintainer contact
listed there and request a private exchange before sending details. This
repository intentionally does not embed a personal email address or private
infrastructure URL in the package.

Include, when safe:

- package version, OMP host version, and the affected OmniRoute HTTP capability;
- affected command, operation ID, route category, or file;
- a concise impact statement and attacker prerequisites;
- a minimal reproduction that uses placeholders and disposable loopback data;
- whether a runtime key, metadata key, admin key/cookie, model data, prompt,
  export, or other sensitive value may have been exposed; and
- logs or traces after removing keys, cookies, authorization headers, account
  identifiers, local paths, hostnames, request bodies, and transcripts.

The maintainer will acknowledge a private report when the reporting channel
supports acknowledgement, reproduce it in an isolated disposable profile, and
coordinate a fix, release note, and disclosure date with the reporter. Do not
assume that a report is accepted until a maintainer confirms receipt through
the same private channel.

## Supported security surface

Security fixes target the currently documented package release, OMP hosts in
the declared `>=18.2.3 <19` range, and the functional OmniRoute HTTP boundary it
consumes. The minimum and latest stable OMP hosts receive lifecycle smoke
coverage; a new major version remains unsupported until that evidence passes.
OMP 18.2.3 is the minimum because earlier hosts do not provide the masked native
provider-login contract required for credential handling. A changed OmniRoute
descriptor source snapshot requires contract regeneration, but the extension
does not install, build, or pin OmniRoute's application dependency graph.

## Threat model

The extension handles three intentionally separate credential domains:

1. **Runtime inference** — the native OMP key or the atomic pair
   `OMP_OMNIROUTE_API_KEY` plus `OMP_OMNIROUTE_BASE_URL`, used only for
   `/v1/models` and inference transport.
2. **Metadata** — `OMP_OMNIROUTE_METADATA_API_KEY`, used only for optional
   same-deployment catalog enrichment.
3. **Administration** — a session-only API key or cookie, or the explicit
   `OMP_OMNIROUTE_ADMIN_API_KEY` / `OMP_OMNIROUTE_ADMIN_COOKIE` reference, used
   only for allowlisted management operations.

A runtime key is never promoted to management authority, a metadata key is not
used as a runtime fallback, and an admin secret is not persisted in plugin
configuration. Endpoint and credential generation are one binding: changing
one invalidates the other and cancels in-flight work.

The principal threats and controls are:

- **Credential leakage:** native OMP AuthStorage owns the runtime key;
  management secrets are masked and session-only; config is `0700`/`0600` and
  contains no keys; notifications, tool output, logs, and error details are
  redacted.
- **Endpoint confusion or credential forwarding:** endpoint URLs reject
  userinfo, query, fragments, unsupported schemes, and authenticated redirects;
  redirects use `redirect: error`; conflicting environment URLs fail closed;
  remote HTTP needs an explicit interactive warning.
- **Malicious or oversized gateway data:** JSON is bounded to eight MiB and
  depth 24; malformed live data cannot become an empty success; route identity
  comes only from authenticated `/v1/models`.
- **Unauthorized administration:** the operation registry uses closed IDs and
  strict validators; the read tool exposes only ordinary safe reads; mutation
  and sensitive reads require human plan/apply, target re-read, drift checks,
  and a fresh short-lived plan. Every route, including upstream-public routes,
  requires an enabled exact binding and a separate management credential.
- **Write replay or ambiguous outcomes:** writes are not automatically retried;
  uncertain outcomes are reconciled once and remain explicitly unknown; plans
  cannot be applied after expiry, endpoint/credential changes, or drift.
- **Inference replay and selector cache:** one extension invocation permits one
  outbound POST and rejects redirects. Tested OMP 18.2.x hosts have no extension
  hook to disable their provider-name selector cache or identify a later outer-loop retry,
  so cached rows may remain visible and session-wide no-replay is not claimed.
  Binding guards still prevent stale rows from dispatching after endpoint,
  credential, generation, or shutdown changes.
- **Path and artifact disclosure:** imports/exports use validated paths,
  restricted permissions, size/type checks, and no symlink overwrite. Raw
  backups, prompts, cookies, account identifiers, and key material stay
  human-only.
- **Stale economics:** source-backed pricing carries expiry, snapshot hashes,
  exact seller/product/native-ID joins, and an explicit state. Unknown,
  conditional, or stale prices never become current cash prices or selectable
  model identities.

## Out of scope

This extension cannot make a compromised OmniRoute server trustworthy, repair a
provider's account, guarantee upstream billing correctness, protect a host
already controlled by malware, or replace OMP's own credential storage and
permission model. Report those concerns to the affected upstream or host
project as well as privately here when the extension contributes to the impact.

## Safe handling for maintainers

Use disposable loopback fixtures and an isolated OMP profile. Never use
production mounts, paid credentials, public listeners, tunnels, real account
cookies, or copied model databases for a reproduction. Keep security fixes
small and reviewable; update the relevant contract/provenance record without
publishing exploit details or secret-bearing fixtures.
