# Contributing to CruxOmni-OMP-Client

Thank you for improving `@cruxexperts/cruxomni-omp-client`. Contributions should
keep the extension standalone, public-safe, OMP-versioned, and disabled in
production unless a separate explicit authorization changes that policy.

## Scope and boundaries

The package owns its provider/setup/recovery implementation, typed transport,
model projection, pricing inspection, administration registry/executor/UI,
contracts, provenance, fixtures, scripts, and package documentation. It must
remain exportable without a parent MyRig checkout or a runtime dependency on
LocalSetup, Envman, a local database, or a private service.

Preserve the public `CruxOmni-OMP-Client` identity and the protocol-facing
`omniroute` provider ID unless a reviewed contract change explicitly says
otherwise. The setup entry point is `/cruxomni setup`.

Do not add:

- private hostnames, filesystem paths, account identifiers, credentials,
  cookies, prompts, transcripts, copied databases, or production snapshots;
- a second OMP runtime, an arbitrary HTTP/path administration tool, automatic
  server repair, credential guessing, provider rerouting, or silent retries of
  writes/inference;
- an extension enablement change in the parent production configuration; or
- a dependency whose install hook fetches mutable source.

Original graphics in `assets/` are reserved Crux Experts LLC assets. Do not
replace them with downloaded logos, third-party art, or screenshots containing
real profiles. Fixture screenshots must be clearly labeled and contain no
credentials, account identifiers, private hostnames, or real model data. See
[ASSET_LICENSE.md](ASSET_LICENSE.md).

## Before opening a change

Read [README.md](README.md) and [SECURITY.md](SECURITY.md). Establish which
release pair the change targets from [`provenance/upstreams.json`](provenance/upstreams.json).
Compatibility means the recorded GitHub Latest selectors, tags, commits, and
hashes; it does not mean “whatever is newest when this branch is built.” If a
selector moved, stop and refresh the contract evidence before changing code.

Use a disposable checkout/profile and fixture credentials only. Do not put
secrets in environment-capture files, shell history, test output, screenshots,
fixtures, or commits. Security-sensitive changes should be reported privately
before public discussion; see [SECURITY.md](SECURITY.md).

## Change workflow

1. Keep one behavioral concern per change and describe the user-visible
   contract in the pull request.
2. Reuse existing module boundaries: setup/auth in `src/auth.ts`, non-secret
   profile state in `src/config.ts`, bounded requests in `src/transport.ts`,
   live identity/capability projection in `src/catalog.ts`, health/recovery in
   `src/health.ts`, pricing in `src/pricing.ts`, and administration in
   `src/admin/`.
3. For a new upstream operation, update the typed descriptor and its validator,
   adapter, projection, risk/confirmation/retry metadata, source hash, and
   deterministic fixture together. A GET that triggers a process action,
   token refresh, download, or other effect is not automatically read-only.
4. Regenerate the operation inventory only from its recorded source corpus.
   Keep source behavior authoritative when OpenAPI text disagrees, and record
   the discrepancy instead of guessing. The corpus version is descriptor
   provenance, not a runtime dependency on OmniRoute's application packages.
5. Update provenance when host selectors, descriptor source snapshots, release
   artifacts, or package hashes change. Never replace immutable evidence with
   a moving branch or npm `latest`.
6. Update public docs and third-party notices when a user-visible contract,
   credential flow, compatibility claim, or dependency changes.
7. Add a release-eligibility record only when exact pinned source bytes and
   behavior evidence support the operation. Generic schema validity is not
   evidence; unsupported operations remain visible with an unavailable reason.

## Focused checks

Run from this package root after dependencies are already available. These
commands are intentionally explicit; they do not publish, create a remote, or
enable production:

```bash
bun run check:upstreams
bun run verify:contracts
bun run typecheck
bun test
bun run verify:package
bun run smoke
OMP_BINARY_PATH="$(command -v omp)" bun run smoke:installed
```

Use an isolated OMP profile and disposable loopback fixtures for behavior
checks. Both smoke lanes remove inherited runtime/admin credentials. The
release-asset lane requires its verified absolute artifact; the installed-CLI
lane resolves the provided path, validates the OMP package identity and declared
range, and records its digest. Test the minimum supported OMP version and the
latest stable release whenever the compatibility range changes. Do not install
or build OmniRoute's web application as an extension compatibility prerequisite.

Useful focused areas include:

- native sign-in cancellation, masked prompts, pending persistence, auth-only
  restart with fresh sign-in recovery, and explicit `/cruxomni refresh`;
- endpoint and credential generation changes, offline recovery, bounded body
  and JSON depth handling, redirect rejection, and notification transitions;
- exact `/v1/models` identity, endpoint/modality mapping, empty-versus-failed
  discovery, stale same-generation rows, and source-backed pricing states;
- operation validation, allowlisted projections, secret redaction, plan expiry,
  drift, denial/headless behavior, duplicate apply, and lost-response
  reconciliation; and
- package extraction/imports, public-safe file contents, and provenance/hash
  drift.

Do not run a formatter or broad repository gate solely to make an unrelated
change appear clean. Match the surrounding style and keep generated files
regenerated by their owning script.

## Pull requests

A pull request should state:

- the exact behavior changed and the release pair used;
- files/contracts/provenance affected;
- focused checks run and their observable result;
- any acceptance evidence that remains unavailable; and
- whether documentation, compatibility claims, security notes, or third-party
  notices were updated.

Keep commits reviewable. Do not squash away provenance evidence, generated
contract diffs, or a security fix's rationale. Reviewers may request a
throwaway reproduction instead of a permanent test when the behavior is not a
stable public contract.

## Licensing

By contributing, you agree that your contribution is provided under the
project's [MIT License](LICENSE). Contributions must be original or clearly
compatible with that license, and copied upstream material must retain its
required notices and remain outside the package unless expressly permitted.
