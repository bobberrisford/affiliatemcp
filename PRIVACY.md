# Privacy Policy

_Last updated: 2026-06-13_

**affiliate-networks-mcp** is local-first and open source. Affiliate credentials,
prompts, and affiliate-network data remain on your machine.

## Aggregate adoption metrics

The project reads aggregate statistics already exposed by npm and GitHub,
including npm package downloads, GitHub release-asset downloads, stars, forks,
repository clones, and repository views.

These statistics do not come from the running MCP package and require no
consent. npm downloads are downloads, not users: they can include repeated
`npx` runs, CI, caches, and other automated traffic.

## Optional anonymous usage telemetry

Anonymous runtime telemetry is **off by default**. It is sent only after you
explicitly opt in during setup, in the desktop setup app, in host-native MCPB
settings, or with:

```sh
affiliate-networks-mcp telemetry enable
```

An opted-in installation sends at most one summary for each active day. The
summary contains:

- A random installation identifier that rotates every UTC month.
- Package version and launch surface (`npm`, `mcpb`, `desktop-bundle`, or
  `unknown`).
- Counts by affiliate-network slug, operation name, and coarse outcome:
  success, authentication error, rate limit, configuration error, upstream
  error, or other error.
- Coarse lifecycle counts such as server starts, completed setup, and completed
  client installation.

The project never sends credentials, affiliate data, account identifiers,
prompts, tool arguments, tool results, amounts, URLs, error messages, stack
traces, exact timestamps, operating system, Node.js version, or locale.

Cloudflare necessarily receives the request IP while routing an opted-in
telemetry request. This project does not write that IP into telemetry storage,
and Worker observability/request logging is disabled.

## Storage and retention

- Consent, the rotating identifier, and pending daily counters are stored
  locally in `~/.affiliate-mcp/telemetry.json` with mode `0600`, separate from
  credentials.
- Raw opted-in summaries are stored in Cloudflare Analytics Engine for its
  current three-month retention period.
- Daily aggregate rollups are retained for trend analysis.
- Rotating monthly identifiers used to estimate opted-in active installations
  are deleted from the dashboard database after 35 days.
- npm and GitHub aggregate adoption snapshots are retained for trend analysis.

Telemetry is advisory and can be spoofed because the open-source client cannot
safely contain an ingestion secret.

## Your control

Check or change telemetry at any time:

```sh
affiliate-networks-mcp telemetry status
affiliate-networks-mcp telemetry enable
affiliate-networks-mcp telemetry disable
```

Disabling immediately deletes the local monthly identifier and pending
counters. Missing, malformed, or unreadable telemetry state always means
telemetry is off. A host-managed `AFFILIATE_MCP_TELEMETRY=true` environment
setting explicitly overrides the local preference; disable it in that host's
settings.

Credentials remain in `~/.affiliate-mcp/.env` with mode `0600`. They are sent
only to the official APIs of networks you configure. Affiliate data is fetched
live, processed locally, and is not forwarded to this project. Persistent
result caching is off by default. Setting `AFFILIATE_MCP_CACHE=on` stores
selected programme inventory and closed reporting-window results locally under
`~/.affiliate-mcp/cache/`, including raw upstream data. The cache directory uses
mode `0700`, entry files use `0600`, open or current reporting windows always go
live, and expired entries are deleted during later cache access. On a shared
machine where you cannot rely on file permissions to keep other users out of
your home directory, leave caching off so transaction-level results are never
written to disk.

## Update check

The server checks for a newer release so you are not stranded on an old build.
Once per day it reads the package's latest published version from the npm
registry (`https://registry.npmjs.org`). The request is anonymous: it carries no
credentials, account identifiers, affiliate data, or usage counters — only a
standard HTTP request for a public package's version, the same request `npm`
itself makes. The npm registry, like any web server, sees the originating IP
address of that request; this project does not receive or store it. The result
is cached in `~/.affiliate-mcp/update-check.json` (mode `0600`). The check is
**on by default** and fails silently when offline. Disable it by setting
`AFFILIATE_MCP_UPDATE_CHECK=0` (or `false`/`no`/`off`). It is independent of
telemetry consent.

Remove a network by deleting its keys from `~/.affiliate-mcp/.env`. Delete
locally cached results with `affiliate-networks-mcp cache clear`. To remove
everything, run `npx affiliate-networks-mcp uninstall` (or
`claude plugin uninstall affiliate-networks-mcp`), then delete the
`~/.affiliate-mcp/` directory.

## Contact

Questions about this policy: open an issue at
<https://github.com/bobberrisford/affiliatemcp/issues>.
