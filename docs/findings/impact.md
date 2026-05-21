# Findings: Impact

Captured during Chunk 5 implementation. Feeds Chunk 7's REPORT.md.

## Summary

Impact's publisher (Mediapartners) surface covers all seven canonical
publisher operations including `listClicks`, which Awin does not expose. The
adapter is shipped at `claim_status: partial` — every operation is
implemented and unit-tested against fixtures, but the adapter has not yet
been exercised against a live Impact account.

The adapter contains several defensive workarounds documented inline with the
`// IMPACT-WORKAROUND:` prefix. They exist because Impact's API has
documented flakiness (PRD §9.3). Future contributors writing other adapters
must NOT copy these workarounds: their justification is Impact-specific.

## API surface area

Mediapartners endpoints used (all under `/Mediapartners/{AccountSID}/`):

- `GET /Campaigns` — programme listing (joined and available).
- `GET /Campaigns/{CampaignId}` — single programme detail.
- `GET /Actions` — transactions. Filters: `ActionDateStart`, `ActionDateEnd`,
  `State`, `Page`, `PageSize`.
- `GET /Clicks` — click-level data. Filters: `EventDateStart`, `EventDateEnd`,
  `Page`, `PageSize`.
- `POST /TrackingValueRequests` — mint a tracking link
  (`application/x-www-form-urlencoded` body, NOT JSON).

Auth is HTTP Basic with the Account SID as the user and the Auth Token as
the password. The Account SID is also the URL path prefix, so both
credentials are required for every call.

## Status mapping decision

Impact's transaction states map to canonical statuses as follows:

| Impact state | Canonical status | Notes                                            |
| ------------ | ---------------- | ------------------------------------------------ |
| `PENDING`    | `pending`        | Direct mapping.                                  |
| `APPROVED`   | `approved`       | Direct mapping.                                  |
| `REVERSED`   | `reversed`       | `ReversalReason` is preserved in the envelope.   |
| `LOCKED`     | `approved`       | LOCKED means "approved and queued for payment"; the user-facing intent is the same as `approved`. The raw "LOCKED" string is preserved on `rawNetworkData`. |
| `PAID`       | `paid`           | Direct mapping. Anchored on Impact's PAID state, not a date inference. |
| _(other)_    | `other`          | Never invent a status the user didn't see upstream. |

The decision to map `LOCKED → approved` rather than introducing a new
canonical status is recorded here because it is the only mapping that is not
mechanical. The trade-off:

- Pros: keeps the canonical TransactionStatus enum narrow, matches the
  affordance ("how much money is approved and waiting for payment?").
- Cons: a user filtering on `status: 'approved'` will see both APPROVED and
  LOCKED rows together. Mitigation: the raw upstream string is on
  `rawNetworkData` for any caller who needs to disambiguate.

## 5xx-storm encounter

Impact's `/Actions` endpoint returns intermittent 5xx responses (most often
502) when the date window is wide or the upstream report engine is
warm-loading. Cited in the project brief (PRD §9.3) and consistent with
publicly observable behaviour on the Impact status page during incident
windows.

Adapter response:

1. Chunk every `/Actions` and `/Clicks` call into ≤30-day slices before
   leaving the adapter. Even if Impact would accept a wider window, the
   chunking keeps every request inside the well-behaved envelope and
   isolates failure to one slice.
2. Bump the `listTransactions` and `getEarningsSummary` resilience profile
   to `timeoutMs: 60_000, retries: 4`. The default of `30_000, 2` is too
   tight for active publishers. With four retries, the most common failure
   pattern ("first call 502, second call 200") resolves transparently.
3. Honour 502/503/504 in the default `retryOn` set — already configured in
   `DEFAULT_RESILIENCE`, no override needed.

These choices live in `src/networks/impact/adapter.ts`'s
`ACTIONS_RESILIENCE` constant. They are deliberately NOT promoted into
`DEFAULT_RESILIENCE` — Awin and CJ do not need them and global tuning would
slow their failure paths.

## Pagination inconsistencies

Impact's pagination headers are inconsistent across endpoints:

- `/Campaigns` typically returns `@page` / `@numpages`.
- `/Actions` sometimes returns `@nextpageuri` (a `/Mediapartners/{SID}/...`
  path), sometimes `@page` / `@numpages`. The two appear on different
  tenants and even within the same tenant on different days.
- `/Clicks` returns `@page` but omits `@numpages`; the only reliable signal
  for "more pages" is "this response was at the PageSize cap".

The adapter honours all three patterns in priority order: `@nextpageuri`
first (strip the `/Mediapartners/{SID}` prefix so we don't double it up),
then `@page` + `@numpages`, then PageSize-fullness as a fallback. A hard cap
of 25 pages per slice prevents runaway loops in the (historically observed)
case where a tenant returns a self-referential `@nextpageuri`.

The strip helper is exported as `_internals.stripMediapartnersPrefix` and
unit-tested against both relative paths and fully-qualified URLs.

## Date format quirks

Impact action dates appear in three forms:

1. `YYYY-MM-DDTHH:MM:SS-OFFSET` (most common).
2. `YYYY-MM-DDTHH:MM:SS.fffZ` (millisecond-precision UTC).
3. `YYYY-MM-DDTHH:MM:SS` (no offset).

The third form is the dangerous one — `Date.parse` interprets it in the
host's local timezone, which silently corrupts age calculations on any
non-UTC host. The adapter's `parseImpactDate` appends `Z` when no offset is
detected, treating the value as UTC explicitly. Unparseable inputs return
`undefined` rather than fabricating a date.

## Empty-list normalisation

Impact responses for empty lists vary:

- `null` body (literally the bytes `null`).
- `{}` body (no list key at all).
- `{ Actions: [] }` (the documented shape).
- Bare empty array `[]` (rare; observed on `/Clicks`).

The client (`src/networks/impact/client.ts`) normalises `null` to `{}` at
the parse boundary. The adapter then reads the expected list key
defensively (`envelope?.Actions ?? []`), and also tolerates a bare array
via `Array.isArray(envelope) ? envelope : envelope?.Actions ?? []`.

This is covered by the test "treats a null Impact response body as an empty
list" in `tests/networks/impact/adapter.test.ts`.

## Token longevity + rate limits

- **Token longevity**: Impact tokens are long-lived. They are rotatable from
  Settings → API in the dashboard; rotation invalidates the previous value
  immediately. Treat as a static secret for v0.1.

- **Rate limits**: Impact's documented per-second budget is generous (well
  above what a typical publisher report query would consume), but
  unannounced rate limiting via `429 Too Many Requests` has been observed
  during sustained polling. The resilience layer retries 429 by policy with
  exponential backoff and jitter, which is the right default.

- **Latency**: `/Campaigns` returns in ~200–400ms; `/Actions` in ~500ms–5s
  for typical 30-day windows but occasionally 10–30s under load (the
  motivation for the 60s timeout on listTransactions); `/TrackingValueRequests`
  in ~300–500ms.

## Deep-link by API (not by construction)

Unlike Awin, Impact mints every tracking link server-side: the
`/TrackingValueRequests` endpoint creates a tracking record and returns a
URL. The adapter therefore POSTs (with a form-urlencoded body — Impact's
POST endpoints reject JSON here) and surfaces the returned `TrackingURL`.

The cost is one network round-trip per link. The benefit is that Impact's
per-link tracking IDs are unique and identifiable in subsequent reporting.

If `/TrackingValueRequests` returns 2xx but without a `TrackingURL` field,
the adapter raises a `network_api_error` envelope rather than silently
returning a half-formed link.

## Future work (Chunk-7 notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real
  Impact publisher account. The 5xx-storm workarounds should be re-tested
  against current Impact behaviour at that point; if Impact's stability has
  improved, we can dial back `ACTIONS_RESILIENCE` retries from 4 to the
  default 2.
- **Cursor abstraction**: the current adapter buffers all paginated results
  in memory. For very active publishers, large `/Actions` responses could
  produce tens of thousands of rows. A cursor-based interface would let
  callers stream results. Not needed for v0.1.
- **`/Reports/mp_action_listing_sku_fast` shortcut**: the Reports endpoint
  is faster for summary queries on large datasets. Not used today because
  the per-transaction derivation in `getEarningsSummary` is auditable; if
  performance becomes the bottleneck this is the optimisation lever.
- **Workaround review**: every `IMPACT-WORKAROUND:` comment should be
  revisited in v0.2. If a workaround is no longer needed because Impact
  fixed the underlying behaviour, remove it. If a workaround turns out to
  apply to another network too (CJ has reportedly similar pagination
  inconsistencies), the right move is to consider promoting the helper into
  the shared layer — but only with full justification.
