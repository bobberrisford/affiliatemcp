# Findings: CJ Affiliate

Captured during Chunk 3 implementation. Feeds Chunk 7's REPORT.md.

## Summary

CJ maps onto the canonical adapter contract for six of the seven publisher
operations. `listClicks` is structurally unsupported on the modern GraphQL
surface; the adapter throws `NotImplementedError` with a CJ-specific reason
rather than partially-supporting an inconsistent legacy REST report. The
adapter ships at `claim_status: partial` — every other op is implemented and
unit-tested, but it has not yet been exercised against a live publisher
account.

## GraphQL + REST hybrid

CJ's modern public API is GraphQL. Two endpoints — different schemas:

- `https://commissions.api.cj.com/query` — `publisherCommissions`, `me`.
- `https://ads.api.cj.com/query` — `advertisers`, `advertiser`.

A REST link-builder is also published at
`https://link-builder.api.cj.com/v1/links`, but for v0.1 we use the legacy
deterministic redirect URL (`https://www.dpbolvw.net/click-{publisherId}-{advertiserId}?url=...`)
because it requires no API round-trip and is universally supported.

The client (`src/networks/cj/client.ts`) exposes two helpers:

- `cjGraphQL<T>({ endpoint, query, variables, operation, ... })` — handles
  both GraphQL endpoints. Caller picks `endpoint`.
- `cjRest<T>({ baseUrl, path, method, body, operation, ... })` — handles
  link-builder REST (and future legacy report endpoints if reachable).

Both go through `withResilience`. Both throw `HttpStatusError` on non-2xx.

### GraphQL-on-200 errors

CJ may return HTTP 200 with a populated `errors` array (the GraphQL spec
permits partial success). We synthesise an `HttpStatusError(200, body, ...)`
so the verbatim body reaches the error envelope (PRD §15.4) and the user sees
CJ's actual error message rather than a paraphrase. The synthesised 200
falls through to "no retry" in the resilience layer, which is correct —
repeating a malformed query gets the same error.

A test (`surfaces GraphQL `errors` payloads verbatim even on HTTP 200`)
exercises this path.

## Schema documentation quality

CJ publishes a GraphQL schema at https://developers.cj.com/. The schema is
typed and introspectable; field names are stable in practice (most recent
notable rename was the move from `commissions` to `records` inside
`publisherCommissions` a few years ago).

Caveats observed while reading the docs:

- The `me` query's exact field set varies between tenants. We read a minimal
  set (`id companyId name email company { id name }`) and tolerate missing
  fields defensively.
- The `advertisers` query wraps results in `resultList` on the modern schema
  but some tenants flatten to a top-level array. The adapter accepts either.
- Numeric fields are sometimes returned as JSON strings (e.g.
  `pubCommissionAmountUsd: "8.00"`) and sometimes as numbers. The `toNumber`
  helper accepts both.
- `actionStatus` vs `commissionStatus`: depending on schema version, the
  status lives on different fields. We read both.

The lesson generalises beyond CJ: in any network's GraphQL surface, prefer
narrow queries plus defensive transformers over a strict schema mirror.
Networks add fields more often than they remove them, and the cost of
breaking on a new optional field outweighs the safety of a tighter type.

## Status mapping (the load-bearing decision)

CJ's commission lifecycle vocabulary (modern schema):

| CJ value     | Canonical | Notes                                                    |
| ------------ | --------- | -------------------------------------------------------- |
| `NEW`        | pending   | Recorded, not yet locked.                                |
| `EXTENDED`   | pending   | CJ is holding for review; still pending from publisher.  |
| `LOCKED`     | approved  | Approved, cleared for payment, but not yet paid.         |
| `CLOSED`     | reversed  | Cancelled / reversed by the advertiser.                  |
| `CORRECTED` -> default | other     | Adjusted post-fact; raw preserved on rawNetworkData.     |
| anything else | other    | Never invent a status the user didn't see.               |

Two paid signals override `actionStatus`:

- `paidToPublisher: true` — explicit boolean (some tenants).
- `clearedDate: <ISO>` populated — equivalent signal (other tenants).

Either of those forces `status = 'paid'` regardless of the action status
string. Same lesson Awin teaches with `paidToPublisher`: trust both
boolean/date signals AND the string, not just one.

## PAT longevity

CJ Personal Access Tokens are long-lived. They do not auto-rotate; users
revoke manually from the same dashboard tab where they were generated
(Account → Personal Access Tokens). We treat the token as a static secret,
read once from `~/.affiliate-mcp/.env`.

## Rate-limit observations

CJ does not publish a precise per-second budget in the public docs. The
modern GraphQL endpoint tolerates modest sustained traffic; aggressive bursts
get a `429 Too Many Requests`. Our resilience layer retries 429 by policy
with exponential backoff + jitter, which is the right default.

Observed latency (per the orchestrator's prior notes and CJ docs):

- `{ me }`: sub-second.
- `advertisers(...)`: a few hundred ms to ~1s.
- `publisherCommissions(...)`: highly variable. Wide date windows can take
  10–30s. We bump `listTransactions`'s timeout to 60s and retries to 3.

## Click data

There is a legacy REST report endpoint (`commission-detail-report`) that
some accounts can reach via the older support.cj.com tools. It exposes
click-level data but:

- It's not consistently available across accounts.
- The response shape predates the modern schema and would need a bespoke
  transformer.
- Partial support would silently return empty arrays on accounts that
  don't have it, violating PRD principle 4.1.

For v0.1 we throw `NotImplementedError`. The reason string explains the
landscape so the user knows it's not a configuration mistake.

## Deep-link by construction

CJ's legacy click-redirect URL format
`https://www.dpbolvw.net/click-{publisherId}-{advertiserId}?url=...` is
stable and documented; we construct it deterministically. The modern
link-builder REST API (`POST /v1/links`) returns a friendlier URL with a
tracking ID, but every CJ account supports the deterministic redirect, so
it's the safer default for v0.1.

## derivedValues — CJ_COMPANY_ID bootstrap

`verifyAuth` runs `{ me { id companyId ... } }` and returns
`derivedValues: { CJ_COMPANY_ID }` on success. The setup wizard uses this to
skip the follow-up prompt — same pattern Awin uses for `AWIN_PUBLISHER_ID`.

If the token has access to multiple companies, we pick the one on `me.companyId`
(falling back to `me.company.id`). Users with that situation can override
the derived value by setting `CJ_COMPANY_ID` explicitly.

The adapter also implements `derivedValues()` (returning a
`DerivedValueResult[]`) so callers can introspect what was auto-extracted
without re-running the auth check.

## Future work (Chunk-7-style notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real CJ
  publisher account.
- **Pagination cursor**: `publisherCommissions` paginates internally; for v0.1
  we request a wide window and don't expose a cursor. Adding one is
  straightforward.
- **Click data via the legacy REST report**: if it turns out to be reachable
  on enough accounts, implement `listClicks` against the legacy endpoint
  rather than throwing. The known-limitation comment in `META` documents the
  fall-back path.
- **Link-builder REST** for tenants that need a tracking ID rather than the
  deterministic redirect.
- **Multi-publisher accounts**: the deep-link uses `CJ_COMPANY_ID` as the
  publisher identifier in the URL path. Most accounts have a single web-site
  PID; multi-site publishers may need an explicit `CJ_WEBSITE_ID`.
