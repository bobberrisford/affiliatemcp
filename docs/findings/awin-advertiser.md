# Findings: Awin (advertiser)

Advertiser-side (agency/brand) findings for the Awin adapter. Companion to the
publisher-side `docs/findings/awin.md`.

## Summary

The advertiser adapter maps onto the canonical contract for the read operations
an agency account manager needs: `listBrands`, `listTransactions`,
`listMediaPartners`, `getProgrammePerformance`, plus a synthetic `listProgrammes`.
It is read-only at v0.1 (the client refuses any non-GET method). As of
2026-07-01 the adapter is `claim_status: partial`: multiple canonical operations
were verified live against the Awin UK demo account, with the operation-level
gaps declared honestly.

## Live verification (2026-07-01, Awin UK demo account)

Run via `scripts/verify-awin-live.ts` against the Awin UK demo advertiser
(dummy data), using a user-scoped OAuth token. All four advertiser reads
authenticated and returned data:

| Operation | Result |
| --- | --- |
| `listBrands` | 2 advertiser accounts; demo brand present |
| `listTransactions` (30 days) | 86,772 transactions returned and mapped without error |
| `listMediaPartners` | 1 partner, 0 pending |
| `getProgrammePerformance` (30 days) | 10 publisher rows |

The token also authenticated on the publisher side (a separate publisher account
under the same sign-in), confirming the shared-token model. The three
browser-handoff actions (`applyToProgramme`, `approvePublisher`,
`declinePublisher`) cannot be verified with an API token; their URLs need a
manual pass in a logged-in dashboard (see below).

### What the run proves and does not prove

- **Proves:** live auth works; the four reads reach the API and return
  structurally valid, mappable data on a live tenant.
- **Does not prove:** field-level mapping correctness. The harness checks that
  each operation runs and returns plausible counts, not that every field is
  mapped correctly. `getProgrammePerformance` in particular has tenant-specific
  column aliases (`pendingNo` vs `pendingNumber`, etc.) that remain unverified at
  the field level, so it stays `experimental` at operation granularity.

## Open questions surfaced by the live run

- **Roster vs report mismatch.** `listMediaPartners` returned a single joined
  partner while `getProgrammePerformance` returned rows for several publishers.
  Either the demo genuinely has one joined partner while others have historical
  performance, or the roster endpoint under-returns (a status filter or missing
  pagination). Unconfirmed against the dashboard; `// TODO(verify)`. The harness
  now prints a roster-vs-report diagnostic to help pin this down on the next run.
- **Transaction volume.** 86,772 transactions came back for a single 30-day
  window with no pagination cursor. The mapping handled it, but consumers (the
  cockpit, the locker, the fraud-review scan) should window or page rather than
  pull unbounded ranges.

## Known limitations (carried in network.json)

- Read-only at v0.1; the client refuses any non-GET method.
- Hard rate limit of 20 API calls per minute per user; the client token-buckets
  and queues rather than failing fast.
- Advertiser API is gated to Awin Accelerate / Advanced plans; Entry-tier brands
  appear in `listBrands` but data endpoints return 401/403. The adapter does not
  probe each brand, to conserve the rate budget.
- `listProgrammes` is synthetic (one programme per advertiser id); Awin
  programmes are UI-configured and not enumerable on every tenant.
- `declined` maps to canonical `reversed`.

## Browser-handoff URLs

The advertiser dashboard URLs were corrected on 2026-07-01 from the operator's
live session. The advertiser dashboard is served from `https://app.awin.com`,
and partner views live under
`/en/awin/advertiser/{advertiserId}/partnerships/{view}`:

- `.../partnerships/all` — the full partner list including pending applicants
  (the approve/decline queue and verify target).
- `.../partnerships/profile` — the advertiser profile.

`awin-advertiser.approvePublisher` / `declinePublisher` now build the start and
verify URL as `https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`,
interpolating the advertiser id (the previous `ui.awin.com/.../publishers/pending`
constant was wrong on host, path, and was not brand-scoped).

Confirmed 2026-07-01: the advertiser id in that path is the API advertiser
accountId. The two ids seen (**19011** = the demo account queried via the API,
**74386** = "Late Rooms") are two different brands the token can access, not an
account-vs-URL id mismatch: 74386 is both an API account and the id in its own
dashboard URL (`.../advertiser/74386/partnerships/all`). So interpolating the
API advertiser id yields the operator's real partnerships URL. What still needs
a manual pass is only that the page loads and the approve/decline action behaves
as described (there were 0 pending applicants on the demo).

The publisher-side `awin.applyToProgramme` URLs (`ui.awin.com/awin/affiliate/...`)
are a separate surface and remain unverified; the token's publisher account was
not used to check them.

`scripts/verify-awin-live.ts` prints the full handoff payloads (goal, start URL,
verify URL, expect, constraints) so they can be followed by hand or by a
Claude-in-Chrome consumer.

## Promotion path

`partial -> production` requires a live acceptance test against a **real**
(revenue) account covering every declared-supported operation with field-level
mapping confirmed, the roster-vs-report mismatch resolved, the browser-handoff
URLs confirmed, and an explicit maintainer decision, per
`docs/decisions/2026-06-15-adapter-promotion-gates.md`. The 180-day freshness
window applies from `last_verified`.
