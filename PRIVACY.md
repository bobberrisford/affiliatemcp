# Privacy Policy

_Last updated: 2026-07-14_

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

Silent auto-apply is **off by default** and separate from the check above. When
you turn it on (`affiliate-networks-mcp update enable`, or
`AFFILIATE_MCP_AUTO_UPDATE=1`), the server updates itself on launch for npm/npx
installs by running `npm install -g affiliate-networks-mcp@latest`, so the next
launch runs the new version. It never applies on host-managed surfaces (the
`.mcpb` bundle or desktop app, which update through their own channels), only
applies a release it has known about for at least 24 hours (a soak window,
configurable via `AFFILIATE_MCP_AUTO_UPDATE_MIN_AGE_HOURS`), and falls back to a
notice if the install fails. No data leaves your machine beyond the same
anonymous registry request and the standard `npm install` it performs.

Remove a network by deleting its keys from `~/.affiliate-mcp/.env`. Delete
locally cached results with `affiliate-networks-mcp cache clear`. To remove
everything, run `npx affiliate-networks-mcp uninstall` (or
`claude plugin uninstall affiliate-networks-mcp`), then delete the
`~/.affiliate-mcp/` directory.

## Hosted tier (pre-launch, opt-in)

> Appended alongside workstream slice H3 (`docs/product/hosted-mvp-workstream.md`),
> per the follow-up recorded in
> `docs/decisions/2026-07-12-hosted-credential-custody.md`. Everything above
> this section describes the local server, which does not change: your
> affiliate credentials and data stay on your machine unless you deliberately
> opt into the separate hosted tier described here. Local stays free and
> complete either way.

The hosted tier is not a public product yet. This section is written now, in
the same change set as the credential vault it describes, so the policy is
accurate before the first paying hosted customer rather than after.

**What is stored.** Per-user affiliate network API credentials and OAuth
tokens, plus per-tenant brand and client-strategy context. For paying
subscribers only, one more thing: the billing email address captured at
Stripe Checkout, stored with the subscription record (tier and status). It
is used for exactly two purposes — Stripe billing correspondence, and
delivering the scheduled digest emails the paid tiers include — never for
marketing, analytics, or anything else, and it is deleted completely with
the account (see "Deletion" below). Nothing else is stored. Browser session
credentials are never held; browser-driven operations and write actions stay
local-only until a separate hosted-action safety contract exists.

**Encryption.** Envelope encryption: a random AES-256-GCM data key is
generated for each user on their first connected network, and every stored
credential is encrypted under that key with a fresh initialisation vector.
The data key itself is never written to storage unencrypted; it is wrapped by
a master key first. The current implementation wraps that master key with a
Cloudflare Worker secret rather than an external key-management service.
`hosted/README.md` ("Vault threat model") states plainly what that design
does and does not protect against; the maintainer reviewed and accepted it
for the MVP on 2026-07-14, before any hosted credential is stored in a live
environment. Credentials are decrypted only at call time, in memory, to
serve the request that needs them; plaintext is never written to storage.

**Who can access it.** A stored credential serves only that user's own
requests and their own scheduled jobs. It is never used for aggregation
across users, never for analytics, and never for any purpose beyond serving
its owner.

**Deletion.** Deleting a hosted account deletes its stored data completely:
the encrypted credential data, the wrapped key protecting it, the account
record, and the subscription record including the billing email — after
deletion there is no address left to send a digest to, and the scheduled
digest's subscriber roster no longer contains the account. Deletion is not a
soft flag; once it runs, there is nothing left to decrypt and nobody left to
email. Cancelling the Stripe subscription itself happens on Stripe's side as
part of the same deletion runbook (`hosted/README.md`).

**No aggregation.** The hosted tier changes where a credential lives, not
what this project is allowed to do with it: no cross-tenant aggregation, no
analytics, no purpose beyond serving the key's owner, the same posture as
every other section of this policy.

## Contact

Questions about this policy: open an issue at
<https://github.com/bobberrisford/affiliatemcp/issues>.
