# Findings: eBay Partner Network

Captured during the `feature/network-ebay` chunk. Feeds the next REPORT.md
regeneration. The adapter was implemented from the public Partner Network
developer documentation (https://partnernetwork.ebay.com/) and the related
eBay developer reference; **no live API calls were made** during
implementation. The fixtures under `tests/fixtures/ebay/` are synthesised
from the documented response shapes.

## Summary

The eBay Partner Network adapter ships at `claim_status: experimental`. All
seven publisher operations are implemented and unit-tested against synthetic
fixtures, but the adapter has not been exercised against a real EPN account
and the upstream response shapes have not been verified beyond the public
documentation. The adapter should be promoted to `partial` after a single
real-account smoke test and to `production` after the standard live
acceptance test.

## The cardinal shape difference

EPN is structurally unlike Awin / CJ / Impact / Rakuten. There is only one
advertiser — eBay itself — and the concept that corresponds to "a programme"
on every other network is an EPN **campaign**: a tracking bucket the
publisher creates in their EPN dashboard to attribute traffic to a site, an
app, a content channel, etc.

This adapter therefore maps:

- `Programme.id` ← EPN `campaignId`
- `Programme.name` ← EPN `campaignName`
- `Programme.status` ← EPN campaign state (`ACTIVE` → `joined`,
  `PAUSED`/`EXPIRED` → `suspended`, `DRAFT` → `pending`)

A consequence is that the `programmeId` argument to `listTransactions`,
`generateTrackingLink`, and the `affiliate_ebay_*` tools is an EPN campaign
ID — not a merchant ID. This is documented in both `network.json`
`known_limitations` and the per-network setup doc.

## What worked well

- **Clean OAuth2 client-credentials flow.** EPN reuses the standard eBay
  developer OAuth2 endpoint (`POST /identity/v1/oauth2/token`). A single
  HTTP Basic + form-urlencoded exchange yields a two-hour bearer token. No
  refresh dance, no per-call OAuth handshake. The token cache lives in
  `src/networks/ebay/auth.ts` with the test-only `_resetTokenCache` helper.

- **Token exchange doubles as the auth check.** A successful client-
  credentials exchange proves both the App ID and the Cert ID are valid
  without any further EPN API call. `verifyAuth` forces a refresh so the
  wizard sees a fresh exchange rather than a stale cache hit.

- **Deterministic deep-link construction.** EPN's tracking ("Smart Link")
  URL uses the long-standing rover format
  (`https://rover.ebay.com/rover/1/{rotationId}/1?campid=...&toolid=10001&mpre=...`).
  We build it in-process — zero latency, no failure mode, no rate-limit
  cost. Mirrors Awin's deterministic pattern.

- **Stable status vocabulary.** EPN's `PENDING`/`CLEARED`/`PAID`/`CANCELLED`
  enum maps mechanically onto the canonical
  `pending`/`approved`/`paid`/`reversed` set. The decision to map `CLEARED`
  → `approved` (rather than `paid`) keeps cross-network semantics
  consistent with Awin and Impact: "approved-but-not-yet-paid" is a
  distinct user-facing state.

- **Reversed-sale visibility falls out cheaply.** EPN populates
  `cancelReason` on cancelled transactions; we surface it on
  `reversalReason` per PRD §15.10 with no extra fetch.

- **Click-level data is exposed via the API.** Unlike Awin, EPN's reporting
  surface includes a `/click` endpoint. `listClicks` is implemented as a
  real operation rather than a `NotImplementedError`.

## What didn't / friction points

- **No real-account verification.** This is the principal caveat. Every
  field name, status string, and pagination shape in the adapter is
  synthesised from the public documentation. The integration may need
  light fixup once it sees a real response — particularly around the
  reporting endpoints, which the docs describe in less detail than the
  Buy and Marketing APIs.

- **The "one advertiser" model is awkward for cross-network tooling.**
  A consumer of `affiliate_list_networks` who naively assumes "more
  programmes = more revenue" will misread an EPN account with a single
  campaign as a small player. The `known_limitations` entry calls this
  out explicitly so downstream skills can adjust their copy.

- **Reporting delay.** EPN's transaction reporting is documented to be
  delayed approximately 24-48 hours. A user calling `listTransactions`
  for "today" will not see today's clicks. This is honest behaviour but
  worth flagging in the setup doc so the wizard's `affiliate-mcp test
  ebay` output is interpretable on a fresh account.

- **90-day window cap on reporting endpoints.** Both `/transaction` and
  `/click` cap a single call at 90 days. We chunk wider windows
  transparently (sequential calls, not parallel — keeps us under EPN's
  burst tolerance, mirroring Awin's behaviour).

- **The `campaignId` requirement for tracking links.** EPN requires a
  campaign ID on every Smart Link (it is the `campid` query parameter on
  the rover URL). Unlike Awin's publisher ID — which we can derive from
  the token via `/publishers` — there is no documented "list my
  campaigns" endpoint that does not itself require the campaign-creation
  permission. We therefore prompt the user for the campaign ID
  explicitly in the wizard. A future enhancement: if the
  `/affiliate/campaign/v1/campaign` listing endpoint turns out to be
  available to standard publisher credentials, we can move this to the
  `derivedValues` pattern (offer the first active campaign as the
  default; let the user override).

- **Approval gate.** EPN requires the publisher's developer application
  to be enrolled in the Partner Network before its credentials can
  exchange for an EPN-scoped token. Typical wait time: 1-3 working
  days. We document this in the first setup-step's description so a
  user with a fresh developer account learns about the gate before the
  wizard fails to validate.

- **Marketplace header.** Many eBay APIs (including parts of the EPN
  surface) require `X-EBAY-C-MARKETPLACE-ID`. We send `EBAY_GB` by
  default and expose `EBAY_MARKETPLACE_ID` as a runtime override. A
  caller running US reporting will need to set the override; this is
  documented in `.env.example`.

## Token longevity + rate limits

- **Token longevity**: ~2 hours per the documented `expires_in`. The
  cache refreshes 30s before expiry to avoid races with in-flight
  requests.

- **Rate limits**: eBay's developer docs publish daily call-count quotas
  per application rather than per-second budgets. Practical effect: the
  resilience layer's default retry-on-429 + circuit-breaker policy is
  the right shape; we have not added any EPN-specific rate-limit
  signalling because the documented retry behaviour matches.

- **Latency**: not yet measured against a live account. Reporting
  endpoints get a 60s timeout and one extra retry by precaution
  (matches the Impact and Awin approach for slow reporting surfaces).

## Deep-link by construction — why it matters here

EPN's rover URL is fully determined by `{rotationId, campaignId,
destinationUrl}`. We can build it without any network round-trip. This is
the canonical "deterministic construction" pattern (Awin uses the same
approach with the `awin1.com/cread.php` URL).

- Latency: ~0ms (no network).
- Failure modes: none upstream — only local input validation.
- Rate-limit cost: zero.

We still require the credentials to be configured so a user with a
half-configured environment learns at link-generation time, not at
first-click time when nothing tracks.

## Future work

- **Live validation**: exercise the adapter against a real EPN account
  and bump `claim_status` from `experimental` → `partial`, then
  `production` after the standard acceptance test.

- **`derivedValues` for `EBAY_CAMPAIGN_ID`**: if the campaign-list
  endpoint turns out to be available to standard publisher credentials,
  expose the first active campaign as the wizard's default.

- **Subid / customid support**: EPN supports per-link `customid` for
  sub-tracking. The current adapter does not surface this on
  `generateTrackingLink`; widening the canonical
  `generateTrackingLink` input shape across all networks is the right
  fix (touching the shared type contract requires a separate PR).

- **Marketplace-aware listProgrammes**: the campaigns response includes
  a `marketplaceId` per row. We currently expose this only via
  `rawNetworkData`. A future iteration could surface it on
  `Programme.categories` or as a separate field once the canonical type
  has somewhere to put it.
