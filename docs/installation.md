# Installation and Guided Setup

## Requirements

- Oh My Pi `>=18.2.3 <19`; the tested compatibility points are `18.2.3` and
  `18.2.6`.
- Bun `>=1.4.2` when installing from source or running package checks.
- An OmniRoute-compatible HTTPS endpoint and a runtime API key.

The package identity is `@cruxexperts/cruxomni-omp-client`. The provider ID
remains `omniroute`, preserving native model and credential identity.

## Install and link

```bash
bun add @cruxexperts/cruxomni-omp-client
omp plugin link "$PWD/node_modules/@cruxexperts/cruxomni-omp-client"
```

Restart OMP after changing a plugin link. For a local checkout, link its root:

```bash
omp plugin link /path/to/CruxOmni-OMP-Client
```

## Guided setup

Run this command in an interactive OMP terminal:

```text
/cruxomni setup
```

The wizard has independent sections:

1. **Connection** asks for a gateway URL and runtime API key. The key is
   entered in a masked prompt and handed to OMP's native credential store.
2. **Metadata (optional)** stores a separate API key or keeps it session-only.
3. **Administration (optional)** stores a separate API key or cookie, then
   explicitly enables the verified administration boundary for the exact active
   endpoint.
4. **Pricing (optional)** selects a local source-backed JSON projection.
5. **Summary** reports state without revealing secrets.

Save and activation are transactional. A cancelled section does not discard
earlier saved sections. An offline or malformed endpoint cannot be reported as
success; a URL-only draft may be saved without a runtime key for later setup.
After a successful native login, use `/cruxomni refresh` to activate and read
back the exact endpoint in the current process.

## Environment-managed mode

For an intentionally read-only binding, set both variables:

```bash
export OMP_OMNIROUTE_BASE_URL="https://gateway.example"
export OMP_OMNIROUTE_API_KEY="$RUNTIME_KEY"
```

A partial pair fails closed. Environment mode takes precedence over profile
setup and cannot be edited by the wizard. Administration credentials remain separate:
`OMP_OMNIROUTE_ADMIN_API_KEY` or `OMP_OMNIROUTE_ADMIN_COOKIE`.

## What is stored

The private profile file contains endpoint generations, flags, optional
credential references, and non-secret pricing/setup state. Runtime keys remain
in OMP AuthStorage. Optional remembered credentials use exact opaque native
records; session-only values are memory-only. No key, cookie, or credential
value belongs in `config.json`, a screenshot, or a support transcript.
