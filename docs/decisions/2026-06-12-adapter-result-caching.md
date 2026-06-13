# Persistent adapter-result caching at the tool dispatcher

- **Date:** 2026-06-12
- **Status:** Proposed
- **Affects:** `src/tools/generate.ts` (tool dispatcher seam), a new cache
  module, the CLI command surface (`cache clear`), `.env.example`, setup docs
- **Depends on:** nothing merged; supersedes the triage state of the
  implementation branch in [#6](https://github.com/bobberrisford/affiliatemcp/pull/6)

## Context

Affiliate work is repetitive in a specific way: the same programme inventory
and the same closed reporting windows get queried many times across a session
and across sessions (QBR prep, reconciliation, anomaly review). Today every
tool call pays a full network round-trip, which is slow for the user and
wasteful against networks with tight rate limits.

PR #6 implements an on-disk result cache: one JSON file per entry under
`~/.affiliate-mcp/cache/`, wrapped around the adapter invocation in
`src/tools/generate.ts`, keyed by sha256 of network, operation, canonical
args, and a credential fingerprint, with per-operation TTLs and a
`cache clear` CLI command. The maintainer triaged it: persistent caching
changes shared and tool behaviour and raises data-freshness, raw-data-at-rest,
retention, invalidation, and user-control questions, so a decision must land
first and the implementation branch must be refreshed or replaced against it.

This document takes a position on each of those questions.

## Decision

Adopt persistent on-disk result caching, wrapped at the tool dispatcher in
`src/tools/generate.ts`, as a file-per-entry JSON store under the config
directory. Adapters, `src/shared/resilience.ts`, and the per-network
`client.ts` files are untouched; the cache is a new module, not a change to
any existing stable primitive. Cached results are returned byte-identical to
what the adapter produced, so no public tool output contract changes.

### Data freshness

Caching is **default-deny by operation**. An operation is uncached unless the
TTL policy names it explicitly. The v1 policy:

- `verifyAuth` and `generateTrackingLink`: never cached. Auth state must
  always be live, and a tracking link is a write-shaped action whose output
  may embed per-request identifiers.
- `listProgrammes` and `getProgramme`: cached for 24 hours. Programme
  inventory shifts slowly; a day-old commission rate or join status is an
  acceptable and documented trade for most discovery work.
- `listTransactions`, `getEarningsSummary`, `listClicks`: cached for 30 days
  **only** when the request carries an explicit `to` date that ended at least
  48 hours ago (the settlement margin). A closed past window is effectively
  immutable upstream; reversals that land later are why the margin exists.
- Any request with an open or current date window (no `to`, a malformed `to`,
  or a `to` inside the settlement margin) **always goes live**. When the user
  asks for current data, the server must not answer from disk.
- Advertiser-side operations (`listMediaPartners`,
  `getProgrammePerformance`) are uncached at v1. They fall out of the
  default-deny rule; caching them needs its own freshness argument later.
- Errors are never cached. Only a successful adapter result is written; a
  `NetworkError` envelope bubbles per principle 4.1 and the next call retries
  live.

### Raw data at rest

Cached entries contain real transaction-level data, including each record's
`rawNetworkData` passthrough. The posture:

- Entries live under the config directory: `~/.affiliate-mcp/cache/`, or
  `$AFFILIATE_MCP_CONFIG_DIR/cache/` when the override is set, matching how
  `src/shared/config.ts` resolves the `.env` location.
- The cache directory is created with mode `0700` and every entry file is
  written with mode `0600`. This matches the sensitivity of the adjacent
  `.env` credentials file: same directory, same owner-only posture.
- Credential values are never written to cache files. The credential
  fingerprint in the key is a sha256 over the network's env vars, used only
  so rotation changes the key; the hash is the filename component, not file
  content.
- Local-first holds: cached data is the user's own API output, written only
  to the user's machine, and never transmitted anywhere. No remote cache, no
  telemetry about cache behaviour.
- Encryption at rest is rejected for v1: any local key would sit beside the
  data and beside the plaintext `.env`, adding complexity without changing
  the real threat model (an attacker who can read the cache can read the
  credentials and fetch the data live).

### Retention

- Entries carry an expiry timestamp: 24 hours for inventory, 30 days for
  closed windows. Expired entries are never served.
- Cache access performs a best-effort opportunistic sweep that deletes every
  expired cache entry, not only the entry for the current query. A sweep
  failure is logged to stderr and never breaks the live call. This makes the
  TTL an actual data-retention bound rather than only a freshness rule.
- There is **no size cap, no LRU, and no background process at v1**. This is
  acceptable because entries are written only on explicit tool calls, each
  entry expires within 30 days, opportunistic sweeps remove expired data, and
  `cache clear` plus ordinary file deletion give full manual control.
- A size cap or LRU policy is a deferred follow-up, to be added when there is
  evidence of real-world growth, not speculatively.

### Invalidation

- **Credential rotation auto-invalidates.** The cache key includes a
  fingerprint of the network's credential env vars, so rotating a key orphans
  every prior entry for that network without any explicit step.
- **Args are canonicalised** (recursive key sort) before hashing, so
  equivalent argument shapes share an entry. Advertiser calls would also fold
  the resolved `networkBrandId` into the key so two brands on one credential
  set never share entries; this matters once advertiser ops become cacheable.
- **Schema and adapter changes invalidate via a version component.** The key
  must include a cache format version plus the adapter's version string, so a
  released change to an adapter's normalised output shape orphans stale
  entries instead of serving an old shape to new code. The #6 branch does not
  do this yet; it is a required change in the refresh.
- **`cache clear`** is the explicit user-facing invalidation:
  `affiliate-networks-mcp cache clear` deletes every entry file and reports
  the count and directory. It removes only `*.json` entry files and preserves
  the directory and any unrelated files.
- A corrupt or unreadable entry is treated as a miss, never as an error. A
  cache write failure is logged to stderr and the live result is still
  returned; the cache must never break a call.

### User control

- **Explicit opt-in.** Persistent caching is off unless
  `AFFILIATE_MCP_CACHE=on` is configured. The current public privacy promise
  says affiliate data is fetched live and not stored; silently changing that
  default would make the promise false for existing users. Setup may offer the
  option, but it must explain that transaction-level API results, including
  `rawNetworkData`, will persist locally before enabling it.
- **Env var control.** `AFFILIATE_MCP_CACHE=on` enables reads and writes;
  missing, malformed, or any other value means off. It is documented in
  `.env.example`, the setup docs, the README, and `PRIVACY.md`.
- **Visibility.** At v1, cached results are byte-identical to live results
  and cache hits are logged to stderr. The tool output shape is a stable
  public contract; injecting a `servedFromCache` marker into every result
  changes it for all downstream clients. Because the policy only serves
  immutable or slow-moving data, the freshness gap is bounded and documented
  rather than annotated per response. Surfacing `fetchedAt` in tool output is
  a possible follow-up if users ask for it, and would be its own small
  contract decision.

## Security

When explicitly enabled, transaction-level affiliate data, including raw
upstream payloads, persists on disk between sessions. Mitigations: opt-in
enablement, `0700` directory, `0600` files, config-directory co-location with
the already-sensitive `.env`, no credential values in entries, opportunistic
expiry deletion, and `cache clear`. This touches shared and tool behaviour plus
data handling, so it is a risk-based review item for `@offmann`.

## Rejected alternatives

- **SQLite (or any embedded store).** Adds a dependency against the stated
  dependency policy for indexing the project does not need. File-per-entry is
  inspectable with `ls` and `cat`, partially deletable by hand, and corruption
  is contained to one entry instead of one database.
- **In-memory only.** The cost being addressed is cross-session: MCP server
  processes are typically short-lived per client session, so an in-process
  map would expire exactly when the user comes back tomorrow to continue the
  same QBR. It also offers no rate-limit relief across restarts.
- **Per-adapter caching.** Pushing caching into each network's adapter or
  `client.ts` duplicates TTL policy across every network, lets policies
  drift, and caches raw paginated HTTP responses that are harder to key and
  invalidate. The dispatcher seam keeps one policy, applied uniformly to
  normalised results, with adapters unaware of it.
- **Caching inside `src/shared/resilience.ts`.** Same raw-response problem as
  per-adapter caching, and it would modify a stable load-bearing primitive
  that AGENTS.md deliberately fences off.
- **Stale-while-revalidate.** Background refresh after serving a stale entry
  adds async work that outlives the tool call, awkward in a stdio server
  lifecycle, for little gain given the TTLs already track how fast the data
  actually changes.
- **Encryption at rest.** Rejected for v1 as argued above: the key would live
  next to the data and next to the plaintext credentials it nominally
  protects.

## Consequences

- One new module owns key construction, TTL policy, read/write, and clear;
  `src/tools/generate.ts` gains a thin wrap around adapter invocation. No
  adapter, resilience, or error-envelope code changes.
- The CLI gains a `cache` command group (`clear` at v1).
- `.env.example`, `PRIVACY.md`, and the setup docs gain
  `AFFILIATE_MCP_CACHE=on` and a short section describing what is stored,
  where, with what permissions, how expiry deletion works, and how to clear or
  disable it.
- Disk usage grows with query variety between opportunistic expiry sweeps;
  bounded by usage and the 30-day maximum TTL, not by a hard size cap, at v1.
- Users on shared machines who cannot rely on file permissions should leave
  caching disabled; the docs must say this explicitly.

## Implementation follow-ups

Refresh or replace PR #6 against this decision once it is accepted. Required
deltas from the current #6 branch:

1. add the cache format version and adapter version to the cache key
   (schema-change invalidation);
2. require explicit `AFFILIATE_MCP_CACHE=on` opt-in, with missing or any other
   value disabling both reads and writes;
3. confirm advertiser-side operations resolve to TTL 0 explicitly, not just
   by falling through a default case, and fold `networkBrandId` into the key
   for any future cacheable advertiser op;
4. add a best-effort opportunistic sweep that deletes all expired entries on
   cache access, so TTL is an enforced retention bound;
5. document the cache in `.env.example`, `PRIVACY.md`, the setup docs, and the
   README (opt-in, location, permissions, TTLs, expiry deletion, `cache clear`,
   and the shared-machine note);
6. rebase onto current `main` (the branch predates the Tradedoubler and
   advertiser-side changes to `src/tools/generate.ts`).

Keep the implementation PR draft until this decision merges. A size cap or
LRU sweep and any `fetchedAt` visibility in tool output are explicitly
deferred, each needing its own small decision if pursued.
