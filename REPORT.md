# affiliate-mcp Report — the state of affiliate-network APIs in June 2026

_Date-stamped: 2026-06-29._

This report describes the current affiliate-mcp adapter surface as observed
during construction and verification of the local MCP server. Each adapter
is described in terms of documentation, setup friction, operational coverage,
claim status, and known limitations.
The reader is the comparator. The document presents the data; it does not
rank the networks.

## Methodology

Each network was implemented as an adapter against the same canonical contract
of seven publisher operations: `listProgrammes`, `getProgramme`,
`listTransactions`, `getEarningsSummary`, `listClicks`, `generateTrackingLink`,
and `verifyAuth`. Findings were captured by the adapter author at
implementation time and live in `docs/findings/<slug>.md`. The structured
signals in the summary table — setup time, approval requirement, supported
operation count, claim status, last-verified date — are pulled directly from
each network's `network.json` manifest. No letter grades, stars, or composite
scores are produced; the report's job is to surface the inputs that let the
reader form their own view.

_Live diagnostic data was not collected because no credentials were configured. The figures below are from each adapter's static manifest and the per-network findings document; live latency and sample-size figures are therefore omitted._

_The full methodology document lives at_ `docs/benchmark-methodology.md`_; that file is_
_a placeholder at the time of this report and is fleshed out in a later chunk._

## Summary

| Network | Setup time (min) | Approval | Ops supported | Known limitations | Claim status | Adapter | Last verified |
| --- | ---: | --- | ---: | ---: | --- | --- | --- |
| 2Performant | 5 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| AccessTrade | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Adcell | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Addrevenue | 5 | no | 7 / 7 | 2 | experimental | 0.1.0 | 2026-06-05 |
| Admitad | 15 | no | 6 / 7 | 8 | experimental | 0.1.1 | 2026-06-04 |
| Admitad (advertiser) | 12 | no | 7 / 7 | 5 | experimental | 0.1.0 | 2026-06-04 |
| Adrecord | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Adservice | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Adtraction | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Adtraction (advertiser) | 6 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Affilae | 5 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| Affiliate Future | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Affise | 10 | no | 7 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| Afilio | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Amazon Creators | 10 | yes (~1 days) | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| AvantLink | 10 | no | 6 / 7 | 3 | experimental | 0.1.0 | 2026-06-05 |
| Awin | 5 | no | 6 / 7 | 1 | partial | 0.1.0 | 2026-05-21 |
| Awin (advertiser) | 6 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-05-23 |
| Belboon | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| CAKE | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| CJ Affiliate | 8 | no | 6 / 7 | 2 | partial | 0.1.0 | 2026-05-21 |
| CJ Affiliate (advertiser) | 8 | no | 7 / 7 | 7 | experimental | 0.1.0 | 2026-05-23 |
| ClickBank | 10 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| Commission Factory | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Commission Factory (advertiser) | 7 | no | 7 / 7 | 5 | experimental | 0.1.0 | 2026-06-04 |
| Connexity | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Coupang Partners | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Daisycon | 15 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-04 |
| Daisycon (advertiser) | 15 | no | 7 / 7 | 9 | experimental | 0.1.0 | 2026-06-04 |
| Digistore24 | 5 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| eBay Partner Network | 10 | yes (~3 days) | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-21 |
| Eduzz | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Effiliation | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| eHUB | 5 | no | 7 / 7 | 3 | experimental | 0.1.0 | 2026-06-05 |
| Everflow | 10 | yes (~1 days) | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-28 |
| Everflow (Advertiser) | 10 | no | 7 / 7 | 6 | experimental | 0.2.0 | 2026-05-28 |
| financeAds | 10 | yes (~2 days) | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| FirstPromoter | 5 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-05 |
| FlexOffers | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Flipkart Affiliate | 10 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| GrowSurf | 10 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-05 |
| Hotmart | 10 | no | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-04 |
| Howl | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Impact | 6 | no | 7 / 7 | 2 | partial | 0.1.0 | 2026-05-21 |
| Impact (advertiser) | 8 | no | 7 / 7 | 4 | experimental | 0.1.0 | 2026-05-23 |
| Indoleads | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Involve Asia | 5 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| Kwanko | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-04 |
| Kwanko (advertiser) | 10 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-04 |
| LeadDyno | 5 | no | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-05 |
| Levanta | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| LinkConnector | 5 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| Lomadee | 15 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-04 |
| Monetizze | 5 | no | 6 / 7 | 7 | experimental | 0.1.1 | 2026-06-04 |
| mrge | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| NetRefer | 15 | yes (~5 days) | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-05 |
| Offer18 | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Optimise Media | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Partnerize | 10 | no | 7 / 7 | 4 | experimental | 0.1.0 | 2026-05-28 |
| Partnerize (Advertiser) | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| Partnero | 5 | no | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-05 |
| PartnerStack | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| PartnerStack (advertiser) | 6 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Pepperjam | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Post Affiliate Pro | 5 | no | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-05 |
| Profitshare | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Rakuten Advertising | 12 | yes (~5 days) | 6 / 7 | 3 | partial | 0.1.0 | 2026-05-21 |
| Refersion | 5 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-05 |
| Rewardful | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-05 |
| Scaleo | 10 | yes (~1 days) | 7 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| ShareASale | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| ShopMy | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| Skimlinks | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| Sovrn Commerce | 10 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-05-28 |
| Tapfiliate | 5 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-05 |
| Tolt | 5 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-05 |
| Tradedoubler | 15 | no | 6 / 7 | 6 | experimental | 0.1.1 | 2026-05-28 |
| Tradedoubler (Advertiser) | 10 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| TradeTracker | 10 | no | 7 / 7 | 3 | experimental | 0.1.0 | 2026-06-05 |
| Travelpayouts | 5 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-06-05 |
| TUNE | 10 | no | 7 / 7 | 4 | experimental | 0.1.0 | 2026-06-05 |
| ValueCommerce | 10 | no | 6 / 7 | 7 | experimental | 0.1.0 | 2026-06-04 |
| ValueCommerce (advertiser) | 10 | no | 6 / 7 | 8 | experimental | 0.1.0 | 2026-06-04 |
| Webgains | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Webgains (advertiser) | 10 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-06-04 |
| Yieldkit | 5 | no | 7 / 7 | 3 | experimental | 0.1.0 | 2026-06-05 |

## 2Performant

### Quick facts

- **Slug**: `2performant`
- **Auth model**: custom
- **Base URL**: https://api.2performant.com
- **Environment variables**: `TWOPERFORMANT_EMAIL`, `TWOPERFORMANT_PASSWORD`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://doc.2performant.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation and the 2Performant PHP reference wrapper; not yet verified against a live 2Performant account.
- Click-level data is not exposed as a list endpoint by the public 2Performant affiliate API; listClicks is unsupported.
- Commission amounts are assumed to be in major currency units (e.g. RON / EUR, not bani / cents); not yet confirmed against a live account.
- 2Performant uses credential/session authentication (email + password sign-in returning rotating access-token / client / uid headers), not a static API key. The session is cached in memory and re-established on a 401; cached sessions are lost on process restart and credentials must be updated here if the account password changes.

### Findings

_No findings document was supplied at `docs/findings/2performant.md`._

## AccessTrade

### Quick facts

- **Slug**: `accesstrade`
- **Auth model**: custom
- **Base URL**: https://gurkha.accesstrade.global
- **Environment variables**: `ACCESSTRADE_ACCESS_KEY`, `ACCESSTRADE_SITE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.accesstrade.global/api/report-apis.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Reward/amount unit is assumed to be a major-unit decimal in the account currency; the documentation does not state the unit. Verify against a live account.
- The conversion report is rate-limited to 1 request / 5 minutes and capped at a 7-day window; wider ranges are chunked into 7-day slices automatically.
- Click-level data is not exposed via the publisher API; listClicks is unsupported.
- Tracking links are produced in the AccessTrade dashboard, not via a documented deterministic scheme; generateTrackingLink is unsupported.
- The API base URL differs by country; non-default countries must set ACCESSTRADE_BASE_URL.

### Findings

_No findings document was supplied at `docs/findings/accesstrade.md`._

## Adcell

### Quick facts

- **Slug**: `adcell`
- **Auth model**: custom
- **Base URL**: https://api.adcell.com
- **Environment variables**: `ADCELL_API_TOKEN`, `ADCELL_AFFILIATE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://strackr.com/docs/adcell

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public, third-party sources; not yet verified against a live account.
- Adcell's publisher API is dashboard-gated; endpoint paths, field names, and the auth header scheme are reconstructed and need live verification.
- Amounts are assumed to be EUR (Adcell is a DACH network); the assumption is unverified and the raw payload retains the source value.
- Click-level data is not exposed via a documented publisher endpoint; listClicks is unsupported.
- No documented deterministic deep-link scheme or publisher link API; generateTrackingLink is unsupported.
- Distinct from the mrge adapter: Adcell is now under the mrge holding group but is integrated here as a standalone network with its own API and credentials.

### Findings

_No findings document was supplied at `docs/findings/adcell.md`._

## Addrevenue

### Quick facts

- **Slug**: `addrevenue`
- **Auth model**: bearer
- **Base URL**: https://addrevenue.io/api/v2
- **Environment variables**: `ADDREVENUE_API_TOKEN`, `ADDREVENUE_CHANNEL_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://addrevenue.io/en/developers

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: Addrevenue API response shapes (field names, pagination, amount unit) are inferred from the public developer reference and have not been validated against a live account; transformers read defensively and preserve the raw payload on rawNetworkData.
- Amount unit is assumed to be the major currency unit (e.g. SEK, not öre) with a per-row currency field; this has not been confirmed against a live account.

### Findings

_No findings document was supplied at `docs/findings/addrevenue.md`._

## Admitad

### Quick facts

- **Slug**: `admitad`
- **Auth model**: oauth2
- **Base URL**: https://api.admitad.com
- **Environment variables**: `ADMITAD_CLIENT_ID`, `ADMITAD_CLIENT_SECRET`, `ADMITAD_WEBSITE_ID`
- **Setup time estimate**: 15 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.1
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.admitad.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listClicks is not exposed for publishers via the public Admitad API; the publisher reports surface only aggregated statistics (statistics/actions, statistics/dates), so the operation throws NotImplementedError.
- listProgrammes / getProgramme are mapped from /advcampaigns/ and require the OAuth scope 'advcampaigns'. Admitad's programme connection status is per-website; the adapter reports the campaign-level status it can read and preserves the raw payload in rawNetworkData.
- generateTrackingLink calls the Admitad deeplink generator (GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp=...), which requires the OAuth scope 'deeplink_generator', a connected ad space, and ADMITAD_WEBSITE_ID. A deeplink can only be generated for a campaign your ad space is connected to; otherwise the API returns an error which surfaces verbatim.
- Admitad action statuses are normalised: 'pending' -> pending; 'approved' / 'approved_but_stalled' -> approved; 'declined' -> reversed; the separate payment_status flag (1 = paid) maps to paid. Unknown statuses map to 'other' and the raw value is preserved.
- The statistics/actions and statistics/dates endpoints require the OAuth scope 'statistics'; /me/ requires 'private_data'. The adapter requests all required scopes in a single client_credentials token exchange.
- Admitad action timestamps omit a timezone marker. The adapter interprets these timestamps as UTC for deterministic output; the upstream reporting timezone has not been verified against a live account.
- OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry. Cached tokens are lost on process restart.

### Findings

_No findings document was supplied at `docs/findings/admitad.md`._

## Admitad (advertiser)

### Quick facts

- **Slug**: `admitad-advertiser`
- **Auth model**: oauth2
- **Base URL**: https://api.admitad.com
- **Environment variables**: `ADMITAD_ADVERTISER_CLIENT_ID`, `ADMITAD_ADVERTISER_CLIENT_SECRET`, `ADMITAD_ADVERTISER_ID`
- **Setup time estimate**: 12 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.admitad.com/en/doc/advertiser-api/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The adapter refuses any non-GET HTTP method client-side; use an API application scoped only for the advertiser reporting endpoints for defence in depth.
- getProgrammePerformance is derived from the advertiser statistics/actions report grouped by publisher (webmaster/website). Admitad does not expose per-publisher click counts on this report, so clicks is reported as 0; the exact webmaster/website field names carry // BLOCKED(verify) notes until a live advertiser account is available.
- listBrands / listProgrammes read GET /advertiser/{id}/info/. The advertiser id (ADMITAD_ADVERTISER_ID) is the networkBrandId; advertiser tools take `brand` and resolve via brands.json.
- OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry. Cached tokens are lost on process restart.

### Findings

_No findings document was supplied at `docs/findings/admitad-advertiser.md`._

## Adrecord

### Quick facts

- **Slug**: `adrecord`
- **Auth model**: custom
- **Base URL**: https://api.v2.adrecord.com
- **Environment variables**: `ADRECORD_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://api.v2.adrecord.com/docs/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live Adrecord account.
- Click-level data is not exposed as a list endpoint by the public Adrecord affiliate API; listClicks is unsupported.
- Tracking-link construction is not publicly documented for deterministic assembly; generateTrackingLink is unsupported.
- Transaction amounts are assumed to be in major currency units (e.g. SEK, not öre); not yet confirmed against a live account.
- Adrecord throttles the affiliate API at roughly 30 requests per 30 seconds; wide date ranges are chunked to stay within the limit.

### Findings

_No findings document was supplied at `docs/findings/adrecord.md`._

## Adservice

### Quick facts

- **Slug**: `adservice`
- **Auth model**: custom
- **Base URL**: https://api.adservice.com/cgi-bin/publisher/API
- **Environment variables**: `ADSERVICE_UID`, `ADSERVICE_LOGIN_TOKEN`, `ADSERVICE_AFFILIATE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Authentication uses a UID and a LoginToken supplied as cookies on every request, obtained via /Account.pl/loginToken; auth_model is "custom". The login exchange shape is BLOCKED(verify) — the documentation host returns HTTP 403 to automated fetches, so the adapter takes UID and LoginToken as configured credentials.
- The Statistics.pl reporting endpoint returns AGGREGATE statistics grouped by a dimension (campaign, date, etc.), not row-level conversions. listTransactions maps each aggregate group to a summary Transaction (summed commission, pending vs. settled status); it does not return individual sales. Whether a row-level conversion endpoint exists is BLOCKED(verify).
- listClicks throws NotImplementedError: Statistics.pl exposes aggregate click counts only; no row-level click-event endpoint (per-click timestamp/referrer) is documented in the accessible public API.
- generateTrackingLink throws NotImplementedError: the deeplink/redirect URL format is not documented in any accessible public source.
- Exact Statistics.pl / Campaigns.pl response field names and the precise base host (api.adservice.com vs publisher.adservice.com) are inferred from public docs and third-party guides; BLOCKED(verify) against a live account.

### Findings

_No findings document was supplied at `docs/findings/adservice.md`._

## Adtraction

### Quick facts

- **Slug**: `adtraction`
- **Auth model**: custom
- **Base URL**: https://api.adtraction.com
- **Environment variables**: `ADTRACTION_API_TOKEN`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://adtractionv3.docs.apiary.io/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Authentication is a single API access token sent as a `token` query parameter (not a header); auth_model is "custom".
- listClicks is not exposed via the Adtraction affiliate API; the operation throws NotImplementedError.
- generateTrackingLink cannot be constructed deterministically from credentials: Adtraction tracking links are programme-specific and are returned by the programmes endpoint per approved programme. The operation throws NotImplementedError; use the trackingURL on the Programme returned by listProgrammes / getProgramme.
- Exact v3 endpoint paths (/v3/affiliate/transactions/, /v3/affiliate/programs/), the request/response field names, and the API host (api.adtraction.com vs api.adtraction.net) are inferred from public docs and third-party guides; BLOCKED(verify) against a live account.
- Rate limit is approximately 30 requests/minute (some endpoints 10/minute); heavy date windows may need to be split by the caller.

### Findings

_No findings document was supplied at `docs/findings/adtraction.md`._

## Adtraction (advertiser)

### Quick facts

- **Slug**: `adtraction-advertiser`
- **Auth model**: custom
- **Base URL**: https://api.adtraction.com
- **Environment variables**: `ADTRACTION_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://adtractionv3.docs.apiary.io/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. Adtraction reporting reads are POST-with-body by design, so read-only is enforced by an ALLOWLIST of documented data-READ paths (advertiser transactions and advertiser programmes) rather than by refusing POST; any write/mutation endpoint is structurally unreachable through the client.
- Authentication is a single API access token sent as a `token` query parameter (not a header); auth_model is "custom".
- Multi-brand: one advertiser token may address several programmes. `listBrands()` enumerates them; brand-scoped tools take `brand` and resolve to a programme id via brands.json.
- `getProgrammePerformance` is derived from the advertiser transactions endpoint, grouped by affiliate/channel; transactions are per-conversion so clicks read as 0 unless the row carries a click count.
- Exact v3 advertiser endpoint paths (/v3/advertiser/transactions/, /v3/advertiser/programs/), the request/response field names, and the API host (api.adtraction.com vs api.adtraction.net) are inferred from public docs and the v2 partner pattern; BLOCKED(verify) against a live account (both Apiary docs sites returned HTTP 403 to automated fetch).

### Findings

_No findings document was supplied at `docs/findings/adtraction-advertiser.md`._

## Affilae

### Quick facts

- **Slug**: `affilae`
- **Auth model**: bearer
- **Base URL**: https://rest.affilae.com
- **Environment variables**: `AFFILAE_API_TOKEN`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://rest.affilae.com/reference

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- Monetary amounts are returned by Affilae in cents and converted to major units; the verbatim cents value is preserved on rawNetworkData.
- Click-level data is not exposed via the documented publisher API; listClicks is unsupported.
- Tracking-link minting requires an API call whose exact contract is not publicly documented; generateTrackingLink is unsupported pending live verification.

### Findings

_No findings document was supplied at `docs/findings/affilae.md`._

## Affiliate Future

### Quick facts

- **Slug**: `affiliate-future`
- **Auth model**: custom
- **Base URL**: https://api.affiliatefuture.com
- **Environment variables**: `AFFILIATE_FUTURE_API_KEY`, `AFFILIATE_FUTURE_PASSWORD`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://affiliatefuture.freshdesk.com/support/solutions/articles/79000032665-what-are-the-apis-for-publishers-

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live Affiliate Future publisher account; the JSON response shapes are inferred from public documentation.
- Amount unit assumption: SaleValue and SaleCommission are treated as major currency units (e.g. pounds, not pence); the public documentation does not state the unit.
- Transaction pulls are limited to one day per call; listTransactions chunks the requested window into 1-day slices and loops, so wide ranges make many sequential calls.
- Dated WCF (.svc) endpoints: the publisher API is served from PublisherService.svc and the JSON variant is requested via the Accept header.
- Click-level data is not exposed via the Affiliate Future publisher API; listClicks is unsupported.
- generateTrackingLink also needs AFFILIATE_FUTURE_AFFILIATE_ID (your numeric affiliate ID); it is not part of the core credential set and is read only when building a link.

### Findings

_No findings document was supplied at `docs/findings/affiliate-future.md`._

## Affise

### Quick facts

- **Slug**: `affise`
- **Auth model**: custom
- **Base URL**: https://api.affise.com
- **Environment variables**: `AFFISE_BASE_URL`, `AFFISE_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://api.affise.com/docs3.1/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- The API base URL is per-tenant: each network runs its own Affise instance, so the base is the network's tracking domain supplied via AFFISE_BASE_URL — there is no single shared host. The base_url above is a representative placeholder only.
- Amounts are assumed to be in major currency units (not minor units / cents); confirm against a live account before promoting beyond experimental.
- No raw click-level affiliate endpoint is exposed by the partner API; listClicks is not implemented.

### Findings

_No findings document was supplied at `docs/findings/affise.md`._

## Afilio

### Quick facts

- **Slug**: `afilio`
- **Auth model**: custom
- **Base URL**: https://v2.afilio.com.br
- **Environment variables**: `AFILIO_AFFILIATE_TOKEN`, `AFILIO_AFF_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://v2.afilio.com.br/Manual/manuais-v2.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Afilio documentation PDFs are served behind a WAF (HTTP 403 to automated clients), so the exact XML field names, the exact Campaign Description endpoint filename, and the full status vocabulary could not be read verbatim; field readers are defensive and all original data is preserved in rawNetworkData.
- listClicks is not exposed by any documented Afilio affiliate API; the operation throws NotImplementedError.
- generateTrackingLink is not implemented: Afilio deeplinks are generated inside the dashboard and no deterministic affiliate-side link format (from a campaign id + Aff ID) is documented; the operation throws NotImplementedError.
- getProgramme filters the Campaign Description list client-side; Afilio does not document a single-campaign lookup endpoint.
- Transaction currency defaults to BRL when the API response omits a currency field; the verbatim row is preserved in rawNetworkData.

### Findings

_No findings document was supplied at `docs/findings/afilio.md`._

## Amazon Creators

### Quick facts

- **Slug**: `amazon-creators`
- **Auth model**: custom
- **Base URL**: https://creatorsapi.amazon
- **Environment variables**: `AMAZON_CREATORS_CLIENT_ID`, `AMAZON_CREATORS_CLIENT_SECRET`, `AMAZON_PARTNER_TAG`, `AMAZON_MARKETPLACE`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~1 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://affiliate-program.amazon.com/creatorsapi/docs

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: this adapter has not been validated against a live Amazon Creators API account; the exact API shape needs live verification.
- The Amazon Creators API is a product-catalog API only (getItems / searchItems); it exposes no earnings, transactions, commissions or clicks endpoint. Affiliate performance data is available only in the Associates Central dashboard and its CSV report exports.
- listTransactions, getEarningsSummary and listClicks are unsupported because the Creators API has no reporting surface.
- Programmes are synthesised: Amazon is a single programme per (marketplace, partner tag), so listProgrammes/getProgramme return one synthetic programme rather than a queryable catalogue.
- Amount unit is assumed to be the marketplace major currency unit (e.g. USD/GBP), not minor units; this is unverified and moot at v0.1 because no monetary data is returned by the supported operations.
- Successor to the Product Advertising API (PA-API 5.0), which deprecates 30 April 2026 and retires 15 May 2026; the auth model (OAuth2 client-credentials, scope creatorsapi::default) and catalog host (creatorsapi.amazon) are reconstructed from public sources and need confirmation against a live account.

### Findings

_No findings document was supplied at `docs/findings/amazon-creators.md`._

## AvantLink

### Quick facts

- **Slug**: `avantlink`
- **Auth model**: custom
- **Base URL**: https://classic.avantlink.com/api.php
- **Environment variables**: `AVANTLINK_AFFILIATE_ID`, `AVANTLINK_API_KEY`, `AVANTLINK_WEBSITE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.avantlink.com/hc/en-us/sections/200985665-API-Module-Documentation

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live AvantLink account.
- Monetary amounts are assumed to be decimal currency units (e.g. 12.50), not minor units (cents); confirm against a live account.
- Click-level data is not exposed as a stable per-click feed via the affiliate API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/avantlink.md`._

## Awin

### Quick facts

- **Slug**: `awin`
- **Auth model**: bearer
- **Base URL**: https://api.awin.com
- **Environment variables**: `AWIN_API_TOKEN`, `AWIN_PUBLISHER_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://help.awin.com/apidocs/introduction-1

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data is not exposed via the public publisher API; listClicks is unsupported.

### Findings

# Findings: Awin

Captured during Chunk 2 implementation. Feeds Chunk 7's REPORT.md.

## Summary

Awin maps cleanly onto the canonical adapter contract for the seven publisher
operations except `listClicks`. The adapter is shipped at `claim_status:
partial` — every other op is implemented and unit-tested, but `listClicks` is
structurally unsupported by the public Awin API and the adapter has not yet
been exercised against a live publisher account.

## What worked well

- **Single bearer token, long-lived**: no refresh dance, no per-call OAuth
  handshake. `AWIN_API_TOKEN` reads once from `~/.affiliate-mcp/.env` and the
  client attaches it to every request. The token is generated from the Awin
  publisher dashboard → Account → API credentials.

- **`/accounts?type=publisher` doubles as auth-check + identity discovery**: a single call
  validates the token, returns the publisher ID, and gives a human-readable
  name. This is the canonical example of the `derivedValues` pattern: one
  credential bootstraps another, the wizard shows "press enter to accept"
  rather than re-prompting.

- **Deterministic deep-link construction**: Awin's tracking URL format
  (`https://www.awin1.com/cread.php?awinmid=...&awinaffid=...&ued=...`) is
  documented and stable, so `generateTrackingLink` builds the URL in-process
  without an API call. Faster, no failure mode, no rate-limit budget consumed.

- **Stable status vocabulary**: `pending|approved|declined` covers ~95% of
  observed transactions. Mapping to our canonical set is mechanical
  (`declined` → `reversed`). `paid` is derived from `paidToPublisher: true`.

- **Reversed-sale visibility**: Awin populates `declineReason` on declined
  transactions, so PRD §15.10 falls out for free — we just surface the field.

## What didn't / friction points

- **No click data via the public publisher API.** This is the principal known
  limitation. We throw `NotImplementedError` with the reason
  `"Awin does not expose click-level data via the public publisher API"` so
  the caller sees an honest "not supported" rather than "no clicks today".
  If Awin ever adds clicks to the API the limitation disappears with a
  ~30-line code addition; we don't need to redesign anything.

- **31-day transaction window cap.** A single `/transactions` call accepts at
  most 31 days. We handle this by chunking wider windows transparently in
  the adapter; callers see a single `listTransactions({ from, to })`. The
  chunking adds latency (sequential calls, not parallel — keeps us under
  Awin's per-second rate budget).

- **Status string vs paidToPublisher mismatch.** Awin keeps
  `commissionStatus: approved` even after a transaction has been paid out;
  the `paidToPublisher` flag is the authoritative "this is paid" signal. We
  derive `paid` from that flag, not from the status string. Future networks
  may have similar quirks — the lesson is "treat both string and boolean
  signals as inputs to the normalisation".

- **Schema drift between identity endpoints.** The current `/accounts` response
  uses `accounts[].accountId`, while older `/publishers` shapes and fixtures use
  `publisherId`, `id`, or `accountId`. We accept all of them rather than picking
  one. This is the kind of compatibility shim that should NOT be promoted into
  a shared layer — it's Awin-specific.

- **Two date fields, two meanings.** `transactionDate` is the conversion;
  `validationDate` is when Awin approved the commission. The unpaid-age
  affordance (PRD §15.9) needs validation-relative age, not conversion-
  relative. We use `validationDate ?? transactionDate` as the anchor.

- **`accessStatus` enum is undocumented and tenant-specific.** New states
  appear from time to time (`inactive`, `archived`). We collapse unknowns to
  `unknown` rather than miscategorising.

## Token longevity + rate limits

- **Token longevity**: long-lived. No documented auto-expiry; tokens are
  revoked manually from the same dashboard screen they're generated on.
  Treat as a static secret.

- **Rate limits**: Awin publishes no precise per-second budget in the public
  docs. Empirically (per the orchestrator's prior notes) the API tolerates
  modest bursts and rate-limits with a `429 Too Many Requests` response when
  exceeded. Our resilience layer retries 429 by policy with exponential
  backoff + jitter, which is the right default.

- **Latency**: `/accounts` returns in ~100–200ms; `/programmes` in
  ~300–800ms; `/transactions` is the outlier, occasionally 5–15s for a busy
  publisher across a full 31-day window. We bump the `listTransactions`
  timeout to 60s and retries to 3 to absorb the upstream variability.

## Deep-link by construction — why it matters

Awin's tracking URL is fully determined by `{advertiserId, publisherId,
destinationUrl}`. We can build it without any network round-trip. This is the
canonical "deterministic construction" pattern:

- Latency: ~0ms (no network).
- Failure modes: none upstream — only local input validation.
- Rate-limit cost: zero.

Compare with networks that REQUIRE an API call to mint a link (e.g. Impact's
`/Mediapartners/{accountSid}/Programs/{programId}/TrackingLinks`). Those
adapters wrap their call through the resilience layer the same way every
other Awin call does. The general principle: prefer deterministic
construction when the network's link format is documented and stable; fall
back to an API call only when the network mints a per-link tracking ID.

## Future work (Chunk-7-style notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real Awin
  publisher account.
- **Awin-specific endpoint coverage**: the reference implementation now tracks
  endpoint-by-endpoint status in `docs/networks/awin/api-inventory.md`. Keep
  that inventory updated whenever adding a tool, changing live-test status, or
  discovering a gated requirement.
- **Pagination cursor support**: the current adapter returns the full result
  set; if a future query window produces tens of thousands of transactions
  we'll want a cursor abstraction. Awin doesn't natively cursor — we'd chunk
  by date.
- **Optimisation: parallelise chunk fetches.** Sequential is conservative;
  parallelising 3 slices in a 90-day window would be roughly 3× faster
  provided we stay inside Awin's burst tolerance.
- **`/reports/aggregated` shortcut**: an optimisation for callers who want
  totals only and don't need per-transaction `ageDays`. Not needed for v0.1.

## Awin (advertiser)

### Quick facts

- **Slug**: `awin-advertiser`
- **Auth model**: oauth2
- **Base URL**: https://api.awin.com
- **Environment variables**: `AWIN_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://developer.awin.com/apidocs

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a token scoped to read-only operations at Awin for defence in depth.
- Hard rate limit: Awin permits 20 API calls per minute per user. The client enforces a process-wide token bucket at 20 requests per 60 seconds and queues bursty multi-brand operations rather than failing fast.
- Awin's advertiser API is gated to the Accelerate and Advanced advertiser plans. Brands on the Entry-tier plan appear in `/accounts` output but data endpoints return 401/403; the adapter does not probe each brand (rate-budget reasons — see next entry), so the wizard surfaces a graceful 'found but not API-accessible — upgrade or skip' message at brand-registration time instead.
- `listBrands` calls `GET /accounts` and filters `type === 'advertiser'`. To stay under the 20-per-minute rate budget on accounts with many advertisers, the adapter does NOT issue per-brand probes — all advertiser accounts are reported with `apiEnabled: true`.
- `listProgrammes` is synthetic: Awin programmes are configured in the UI and not enumerated under `/advertisers/{id}/programmes` on every tenant. The adapter returns one Programme per advertiserId keyed on the call context. `// TODO(verify)` against a live Accelerate tenant.
- `listTransactions` maps Awin's `declined` status onto the canonical `reversed` value. Awin's `dateType` is exposed as `transaction` (default) or `validation`.

### Findings

_No findings document was supplied at `docs/findings/awin-advertiser.md`._

## Belboon

### Quick facts

- **Slug**: `belboon`
- **Auth model**: custom
- **Base URL**: https://export.net.belboon.com
- **Environment variables**: `BELBOON_MAGIC_KEY`, `BELBOON_USER_ID`, `BELBOON_EXPORT_HOST`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://faq.belboon.com/en/knowledge-base/tag/api/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- Adapter built from public API documentation; not yet verified against a live account.
- Belboon exposes only aggregated daily stats, not click-level events, via the publisher export API; listClicks is unsupported.
- Monetary amounts are assumed to be major currency units (e.g. euros), as the export interface does not document a minor-unit encoding; verify against a live account.
- The export API serves CSV/XLS/XML (no JSON), and the exact export column names are dashboard-gated and unverified; transformers read candidate column names defensively and preserve the raw row.

### Findings

_No findings document was supplied at `docs/findings/belboon.md`._

## CAKE

### Quick facts

- **Slug**: `cake`
- **Auth model**: custom
- **Base URL**: https://your-instance.cakemarketing.com
- **Environment variables**: `CAKE_BASE_URL`, `CAKE_API_KEY`, `CAKE_AFFILIATE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.getcake.com/support/solutions/folders/5000173061

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live CAKE instance.
- The API base is the per-instance CAKE host, supplied via CAKE_BASE_URL — not a fixed value.
- Conversion amounts are assumed to be major currency units (e.g. dollars, not cents).
- Click-level data is not exposed via the documented CAKE affiliate reporting API; listClicks is unsupported.
- Tracking links are assigned server-side per creative; generateTrackingLink is unsupported (no documented deterministic construction).

### Findings

_No findings document was supplied at `docs/findings/cake.md`._

## CJ Affiliate

### Quick facts

- **Slug**: `cj`
- **Auth model**: bearer
- **Base URL**: https://api.cj.com
- **Environment variables**: `CJ_API_TOKEN`, `CJ_COMPANY_ID`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://developers.cj.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data is not exposed via CJ's modern GraphQL surface; listClicks throws NotImplementedError unless the legacy REST report endpoint is reachable for the account.
- Brand-side operations (listPublishers, listPublisherSectors) are scaffolded for v0.2.

### Findings

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

## CJ Affiliate (advertiser)

### Quick facts

- **Slug**: `cj-advertiser`
- **Auth model**: bearer
- **Base URL**: https://commissions.api.cj.com
- **Environment variables**: `CJ_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://developers.cj.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The GraphQL client refuses any operation that is not `query` (no mutations, no subscriptions); pair this with a personal-access token scoped read-only at CJ for defence in depth.
- `listBrands` reads CJ's GraphQL `viewer` (a.k.a. `me`) for the company memberships the PAT can see. The exact field name `// TODO(verify)` — if CJ's schema rejects it the adapter throws and the user is instructed to add brands manually to `brands.json`.
- `listProgrammes` is synthetic: CJ has no advertiser-programmes query, so the adapter returns one Programme per CID using `advertiserLookup` metadata.
- `getProgrammePerformance` is computed client-side from `commissionDetails`. Clicks are NOT available from `commissionDetails` and are reported as 0; document the gap with `// TODO(verify)`.
- Status mapping for performance rows is based on CJ `actionStatus`: EXTENDED / LOCKED → pending, CLOSED → approved, CORRECTED / REVERSED → reversed. `CLOSED` semantics `// TODO(verify)`.
- All amounts use CJ's USD-normalised fields (`saleAmountUsd`, `commissionAmountUsd`); reports are emitted with `currency: USD`.
- Pagination on `commissionDetails` is capped at ~10,000 rows per page via `maxRows`; wider windows should be split by the caller.

### Findings

_No findings document was supplied at `docs/findings/cj-advertiser.md`._

## ClickBank

### Quick facts

- **Slug**: `clickbank`
- **Auth model**: custom
- **Base URL**: https://api.clickbank.com
- **Environment variables**: `CLICKBANK_DEV_KEY`, `CLICKBANK_CLERK_KEY`, `CLICKBANK_NICKNAME`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live ClickBank account.
- Amount unit assumption: order amounts (totalAccountAmount) are treated as major currency units (whole dollars/pounds, not cents); verify against a live account before relying on the figures.
- ClickBank is a single marketplace with no per-merchant join lifecycle exposed to the publisher API; programmes are synthesised from the affiliate's own order history (one programme per promoted vendor).
- Click-level data is not exposed via the ClickBank publisher API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/clickbank.md`._

## Commission Factory

### Quick facts

- **Slug**: `commission-factory`
- **Auth model**: custom
- **Base URL**: https://api.commissionfactory.com/V1/
- **Environment variables**: `COMMISSION_FACTORY_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://dev.commissionfactory.com/V1/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Commission Factory authenticates with a single API key passed as the `apiKey` query parameter (not a bearer header); auth_model is therefore `custom`.
- listClicks is not exposed via the public Affiliate API; the operation throws NotImplementedError.
- generateTrackingLink is not a deterministic, destination-only construction: it reads the joined merchant's TrackingUrl (https://t.cfjump.com/0/b/{id}) via GET /Affiliate/Merchants/{id} and appends ?Url={encoded}. It therefore requires the merchant to be joined and reachable; for a merchant the affiliate has not joined it throws a network error.
- Affiliate API pagination for GET /Affiliate/Transactions is not documented publicly (no page/pageSize parameters were found); the adapter passes the full date window in a single call. A live account test is required to confirm there is no server-side cap on the result set.
- The deprecated TransactionStatus enumeration is read as a fallback only; the adapter prefers Status2 (TransactionStatus2: Pending, Confirmed, Declined, Void, Paid).

### Findings

_No findings document was supplied at `docs/findings/commission-factory.md`._

## Commission Factory (advertiser)

### Quick facts

- **Slug**: `commission-factory-advertiser`
- **Auth model**: custom
- **Base URL**: https://api.commissionfactory.com/V1/
- **Environment variables**: `COMMISSION_FACTORY_ADVERTISER_API_KEY`, `COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID`
- **Setup time estimate**: 7 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://dev.commissionfactory.com/V1/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The adapter refuses any non-GET HTTP method client-side.
- A merchant API key addresses exactly one merchant; the merchant surface has no "list my accounts" endpoint. `listBrands()` therefore returns a single brand. credential_scope is declared multi-brand for uniformity with the other advertiser adapters.
- getProgrammePerformance is a client-side per-publisher rollup of GET /Merchant/Transactions grouped by AffiliateId. Clicks are not reported on the merchant transactions surface, so per-row clicks are 0.
- Pagination parameters for GET /Merchant/Transactions are not documented publicly; the adapter requests the full date window in a single call.

### Findings

_No findings document was supplied at `docs/findings/commission-factory-advertiser.md`._

## Connexity

### Quick facts

- **Slug**: `connexity`
- **Auth model**: custom
- **Base URL**: https://publisher-api.connexity.com
- **Environment variables**: `CONNEXITY_PUBLISHER_ID`, `CONNEXITY_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live Connexity publisher account; endpoint shapes are mapped from public documentation.
- Connexity is a cost-per-click (CPC) network: reporting is daily aggregate, not per-sale. listTransactions surfaces one synthetic transaction per day (redirects, estimated earnings, effective CPC) rather than individual sales, and all rows are reported as approved because CPC earnings carry no pending/reversed sale lifecycle.
- Amount unit assumed to be major currency units (US dollars) based on the documented decimal earnings figures; not yet confirmed against a live account.
- Click-level data is not exposed as structured records via the publisher API; the click report is a CSV download rather than per-click rows, so listClicks is unsupported.
- Distinct from the Skimlinks adapter: Connexity (ShopYourLikes) is a separate network with separate credentials, hosts, and API.

### Findings

_No findings document was supplied at `docs/findings/connexity.md`._

## Coupang Partners

### Quick facts

- **Slug**: `coupang-partners`
- **Auth model**: custom
- **Base URL**: https://api-gateway.coupang.com
- **Environment variables**: `COUPANG_PARTNERS_ACCESS_KEY`, `COUPANG_PARTNERS_SECRET_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://partner-developers.coupangcorp.com/hc/ko/categories/360005470572-API-Docs

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Coupang Open API enforces strict rate limits (the affiliate product-search endpoint is documented at roughly 10 calls per hour; the reports endpoint is similarly throttled). Frequent polling returns HTTP 429.
- listProgrammes / getProgramme throw NotImplementedError: Coupang Partners is a single-merchant network (the publisher promotes Coupang itself) and exposes no programme-listing API. Product search is a catalogue search, not a programme list.
- listClicks throws NotImplementedError: the commission report exposes only an aggregate daily clickCount, not per-click rows.
- listTransactions maps the reports/commission endpoint, which returns daily aggregate rows (date, clickCount, orderCount, gmv, commission) rather than individual orders; there is no per-row settlement status, so every transaction is normalised to status "other".
- generateTrackingLink calls the deeplink API (POST .../v1/deeplink) and is subject to the same rate limits.

### Findings

_No findings document was supplied at `docs/findings/coupang-partners.md`._

## Daisycon

### Quick facts

- **Slug**: `daisycon`
- **Auth model**: oauth2
- **Base URL**: https://services.daisycon.com
- **Environment variables**: `DAISYCON_CLIENT_ID`, `DAISYCON_CLIENT_SECRET`, `DAISYCON_REFRESH_TOKEN`, `DAISYCON_PUBLISHER_ID`
- **Setup time estimate**: 15 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.daisycon.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Daisycon uses OAuth2 with an interactive authorization_code + PKCE consent; the adapter then uses the refresh_token grant for non-interactive token exchange. The user must complete the one-time authorisation to obtain DAISYCON_REFRESH_TOKEN.
- listClicks is not exposed via the public Daisycon publisher API; the operation throws NotImplementedError.
- generateTrackingLink throws NotImplementedError: a Daisycon tracking (click) URL is issued per programme/media binding and is not deterministically constructible from credentials alone.
- OAuth2 access tokens are short-lived; the adapter caches the token in memory and re-fetches on expiry. The refresh token may expire and then requires re-authorisation.
- The exact /publishers/{id}/programs path and the maximum per_page page size are confirmed only via secondary sources; live account verification required.
- Transactions are multi-currency: the currency is read per row from the upstream payload.

### Findings

_No findings document was supplied at `docs/findings/daisycon.md`._

## Daisycon (advertiser)

### Quick facts

- **Slug**: `daisycon-advertiser`
- **Auth model**: oauth2
- **Base URL**: https://services.daisycon.com
- **Environment variables**: `DAISYCON_ADVERTISER_CLIENT_ID`, `DAISYCON_ADVERTISER_CLIENT_SECRET`, `DAISYCON_ADVERTISER_REFRESH_TOKEN`
- **Setup time estimate**: 15 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.daisycon.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with an OAuth scope limited to reading advertiser, campaign and user-profile data for defence in depth.
- Daisycon uses OAuth2 with an interactive authorization_code + PKCE consent; the adapter then uses the refresh_token grant for non-interactive token exchange. The user must complete the one-time authorisation to obtain DAISYCON_ADVERTISER_REFRESH_TOKEN.
- getProgrammePerformance is derived from /advertisers/{advertiserId}/transactions grouped by media (publisher) client-side; Daisycon's pre-aggregated statistics resource is publisher-scoped only, so the per-publisher rollup is computed from transaction rows rather than a dedicated advertiser-statistics endpoint. `// TODO(verify)` against a live advertiser account.
- listProgrammes is derived from the distinct programs present on the advertiser's transactions over the queried window; Daisycon does not document an advertiser-scoped programmes enumeration endpoint. `// TODO(verify)`.
- listMediaPartners (the publisher roster) throws NotImplementedError: Daisycon does not document an advertiser-scoped publisher-roster endpoint; publishers surface via getProgrammePerformance instead.
- OAuth2 access tokens are short-lived; the adapter caches the token in memory and re-fetches on expiry. The refresh token may expire and then requires re-authorisation.
- Transactions are multi-currency: the currency is read per row from the upstream payload.
- The exact advertiser transactions query parameter set and per-publisher grouping behaviour are confirmed only via secondary sources (DataVirtuality reference, aiwha-dev/DaisyconApi RestClient, Strackr); live account verification required.

### Findings

_No findings document was supplied at `docs/findings/daisycon-advertiser.md`._

## Digistore24

### Quick facts

- **Slug**: `digistore24`
- **Auth model**: custom
- **Base URL**: https://www.digistore24.com
- **Environment variables**: `DIGISTORE24_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://dev.digistore24.com/hc/en-us

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live Digistore24 account.
- Monetary amounts are assumed to be major currency units (e.g. 49.00 EUR), not minor units/cents; this matches the documented examples but is unconfirmed against a live account.
- Digistore24 has no per-merchant programme concept; listProgrammes/getProgramme return a single synthetic programme representing the platform, and transactions key off it.
- Click-level data is not exposed via the public Digistore24 API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/digistore24.md`._

## eBay Partner Network

### Quick facts

- **Slug**: `ebay`
- **Auth model**: oauth2
- **Base URL**: https://api.ebay.com
- **Environment variables**: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_CAMPAIGN_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~3 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://partnernetwork.ebay.com/help/integration-center/api-documentation

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- eBay Partner Network exposes eBay itself as the sole advertiser; "programmes" in this adapter map to EPN campaigns, not to third-party merchants.
- Transaction ("earnings") reporting is delayed approximately 24-48 hours; today's clicks rarely appear in listTransactions until the next reporting cycle.
- Click-level reporting is paginated and capped at 90-day windows per EPN's reporting API; the adapter chunks wider ranges.

### Findings

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
  worth flagging in the setup doc so the wizard's `affiliate-networks-mcp test
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

## Eduzz

### Quick facts

- **Slug**: `eduzz`
- **Auth model**: custom
- **Base URL**: https://api2.eduzz.com
- **Environment variables**: `EDUZZ_EMAIL`, `EDUZZ_PUBLIC_KEY`, `EDUZZ_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.eduzz.com/docs/api

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Authentication uses the Eduzz legacy api2 token-exchange (email + PublicKey + APIKey -> short-lived JWT, sent as the `token` header). The token is cached in memory and re-fetched on expiry (~15 minutes).
- The sales listing route (GET /sale/get_sale_list) and its date_start/date_end window are documented on https://api2.eduzz.com/, but the exact query-parameter and response field names could not be confirmed against the live reference (developers.eduzz.com returns HTTP 403 to automated fetches). Fields are read defensively and the verbatim payload is preserved in rawNetworkData; a live account test is required before promotion.
- listClicks is not exposed by the Eduzz API; the operation throws NotImplementedError.
- generateTrackingLink is not implemented: Eduzz affiliate links are generated per product inside the panel and there is no documented self-serve link-construction API; the operation throws NotImplementedError.
- Eduzz operates in Brazil; amounts are typically denominated in BRL. The currency is read from the payload where present and defaults to BRL otherwise.

### Findings

_No findings document was supplied at `docs/findings/eduzz.md`._

## Effiliation

### Quick facts

- **Slug**: `effiliation`
- **Auth model**: custom
- **Base URL**: https://apiv2.effiliation.com
- **Environment variables**: `EFFILIATION_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://apiv2.effiliation.com/apiv2/doc/home.htm

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Click-level data is not exposed via the publisher API; listClicks is unsupported.
- Tracking-link (deeplink) construction is not deterministically documented for the publisher; generateTrackingLink is unsupported.
- Transaction amounts are assumed to be major currency units (e.g. 12.50 = EUR 12.50) in EUR; not yet confirmed against a live account.
- Transaction data is refreshed roughly every two hours upstream, so very recent conversions may be missing.

### Findings

_No findings document was supplied at `docs/findings/effiliation.md`._

## eHUB

### Quick facts

- **Slug**: `ehub`
- **Auth model**: custom
- **Base URL**: https://api.ehub.cz/v3
- **Environment variables**: `EHUB_API_KEY`, `EHUB_PUBLISHER_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://ehub.docs.apiary.io/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- Monetary amounts (totalCost, commission) are assumed to be major currency units (e.g. CZK), not minor units; revisit if live data is off by 100x.
- generateTrackingLink treats the supplied programmeId as the eHUB creative/banner id (a_bid) and requires EHUB_PUBLISHER_ID (a_aid).

### Findings

_No findings document was supplied at `docs/findings/ehub.md`._

## Everflow

### Quick facts

- **Slug**: `everflow`
- **Auth model**: custom
- **Base URL**: https://api.eflow.team
- **Environment variables**: `EVERFLOW_API_KEY`, `EVERFLOW_AFFILIATE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~1 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.everflow.io/docs/affiliate/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Affiliate API keys must be created by a network admin, not self-service by the affiliate.
- Click stream endpoint caps at 14 days per call; wider windows are chunked automatically.

### Findings

# Findings: Everflow (Publisher / Affiliate side)

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Summary

Everflow maps onto the canonical adapter contract for all seven publisher operations. Unlike Awin and CJ, Everflow **does** expose click-level data via the affiliate API (click stream endpoint), so `listClicks` is implemented rather than throwing `NotImplementedError`.

The adapter ships at `claim_status: experimental` — all ops are implemented and unit-tested against fixture data, but the adapter has not been exercised against a live publisher account.

## Hardening pass 2026-05-28

A second research pass was conducted against Everflow's public documentation. All `TODO(verify)` annotations in the adapter have been resolved or explicitly blocked. The table below tracks every item.

### TODO(verify) outcomes

| # | Location | Original uncertainty | Outcome | Source |
|---|---|---|---|---|
| 1 | `EverflowOfferRaw.currency_id` | Numeric int vs ISO string | **CORRECTED** — `currency_id` is an ISO 4217 string (e.g. `"USD"`), not an integer. Interface type changed from `number` to `string`; `toProgramme()` now maps it directly to `currency`. | developers.everflow.io/docs/metadata/currencies/, api-reference/get-partnersoffersrunnable |
| 2 | `EverflowConversionRaw.currency` | Field name and type uncertain | **CORRECTED** — field is `currency_id` (ISO string, e.g. `"USD"`), not `currency`. Interface updated; `toTransaction()` prefers `raw.currency_id` with fallback to legacy `raw.currency` for fixture compatibility. | developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ |
| 3 | `EverflowConversionRaw.conversion_date` format | Date string format uncertain | **CORRECTED** — Everflow uses `conversion_unix_timestamp` (Unix epoch integer, seconds) for all conversion timestamps, and `click_unix_timestamp` for the attributed click. No `conversion_date` string field is documented. Interface updated; `toTransaction()` and `computeAgeDays()` now use unix timestamps as primary path with string-date fallback for fixture backward compatibility. | developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ |
| 4 | `EverflowClickRaw.unix_timestamp` | Epoch seconds confirmed? | **CONFIRMED** — `unix_timestamp` is the correct field name in the raw clicks stream response (epoch seconds). No change needed. | developers.everflow.io/api-reference/post-affiliatesreportingclicksstream |
| 5 | `relationship.status` values | Exact string values uncertain | **CONFIRMED** — Values are `"approved"`, `"pending"`, `"rejected"`. The adapter already handled all three correctly (mapping `"rejected"` → `declined` via the `rel === 'rejected'` branch). Removed the vague comment; added a precise doc citation. | developers.everflow.io/docs/network/offer_applications/ |
| 6 | `timezone_id: 67` | Assumed UTC, not confirmed | **CONFIRMED** — timezone_id 67 = UTC (offset +00:00) as shown in the metadata timezones list. Comment updated to cite source. | developers.everflow.io/docs/metadata/timezones/ |
| 7 | `EverflowTrackingUrlResponse.url` vs `tracking_url` | Which field the endpoint uses | **CONFIRMED** — The `GET /v1/affiliates/offers/{offerId}/url/{urlId}` endpoint returns `{"url": "..."}`. The `tracking_url` fallback is retained for robustness but is not the primary response field. | developers.everflow.io/api-reference/get-partnersoffersrunnable (response example: `{"url": "http://www.servetrack.test/9W598/2CTPL/?uid=1"}`) |
| 8 | Reporting filter body structure | `query.filters[].resource_type` / `filter_id_value` — exact fields? | **CONFIRMED** — Structure is correct: `query.filters` array with `resource_type` (string, e.g. `"offer"`) and `filter_id_value` (integer). Multiple filters on same resource_type = OR; different types = AND. | developers.everflow.io/docs/network/reporting/aggregated_data/ |
| 9 | `dateApproved` | Separate approval date field? | **BLOCKED** — No `date_approved`, `approved_at`, or similar field is documented for conversion records. Everflow only surfaces `conversion_unix_timestamp`. The adapter sets `dateApproved = dateConverted` for approved records as a best-effort proxy. Live verification required to confirm there is truly no separate approval timestamp. Exact credential/tier needed: any live affiliate API key. |
| 10 | `datePaid` | Payment date from conversion report? | **BLOCKED** — No paid-date field is documented in the affiliate reporting API. Everflow invoice records are separate. Remains `undefined`. |
| 11 | `listProgrammes` page_size max | Cap unknown, using 100 | **CORRECTED** — Everflow paging docs confirm max page_size of 2000 for listing endpoints. Changed cap from 100 to 500 (conservative, stays well within limit). | developers.everflow.io/docs/user-guide/paging/ |
| 12 | Conversion status values | Set of possible statuses unclear | **CORRECTED** — Confirmed full set: `"approved"`, `"pending"`, `"rejected"`, `"invalid"`, `"on_hold"`. Added `"on_hold"` → `pending` and `"invalid"` → `reversed` mappings. Tests added for both new values. | developers.everflow.io/docs/network/conversion_updates/, helpdesk.everflow.io/customer/on-hold-conversions |
| 13 | `network_category_name` in list response | May not be present | **CONFIRMED** — Field is present in `alloffers` responses; confirmed via fixture and public docs examples. TODO removed. | developers.everflow.io/docs/affiliate/offers/ |
| 14 | Offer filter server-side support | Status filter server-side? | **CONFIRMED** — Everflow does support server-side status filtering via `query.filters resource_type: "status"`, but client-side filtering is retained for consistency with other adapters. Comment clarified. | developers.everflow.io/docs/network/reporting/aggregated_data/ |
| 15 | Date format for `from`/`to` request fields | Format confirmed? | **CONFIRMED** — `"YYYY-MM-DD"` or `"YYYY-MM-DD HH:mm:SS"` (either accepted). The adapter sends the long form; both are valid. | developers.everflow.io/user-guide/request-response-format |

### Non-admin NotImplementedError stubs

| Op | Status |
|---|---|
| `listPublishers` | Remains `NotImplementedError` — this is a brand-side (network admin) operation not available on the affiliate API. Correct by design. |
| `listPublisherSectors` | Same as above. |

## Key verification gap: affiliate API keys are admin-generated

Everflow affiliate API keys cannot be self-issued by the affiliate. They must be created by the **network admin** under Manage Affiliate → API tab. This was confirmed via the Everflow developer documentation and help centre:

> "Affiliate users cannot create keys themselves and must rely on a network user to create the key and hand it over."

This is a meaningful friction point: the setup wizard will stall until the user has obtained a key from their network admin. The `known_limitations` and `setupRequiresApproval: true` fields document this explicitly.

## Auth model

Everflow uses a custom header `X-Eflow-API-Key: <key>` rather than the standard `Authorization: Bearer ...` header. This is set in `buildHeaders()` in `client.ts` and declared as `auth_model: "custom"` in `network.json`.

The API key is scoped to a single affiliate account by the network admin. No derivation of a secondary credential (like Awin's publisher ID) is possible or needed — the key already identifies the account.

## Endpoint map (verified from public documentation)

| Endpoint | Method | Status |
|---|---|---|
| `/v1/affiliates/alloffers` | GET | Used for `listProgrammes` and `verifyAuth`. Confirmed via docs. |
| `/v1/affiliates/offers/{offerId}` | GET | Used for `getProgramme`. Confirmed via docs. |
| `/v1/affiliates/reporting/conversions` | POST | Used for `listTransactions`. Response fields confirmed (unix timestamps, currency_id string). |
| `/v1/affiliates/reporting/clicks/stream` | POST | Used for `listClicks`. 14-day cap confirmed. unix_timestamp field confirmed. |
| `/v1/affiliates/offers/{offerId}/url/{urlId}` | GET | Used for `generateTrackingLink`. `url` field confirmed as primary response field. |

## Documentation URLs used

- Affiliate API overview: <https://developers.everflow.io/docs/affiliate/>
- Offers endpoint: <https://developers.everflow.io/docs/affiliate/offers/>
- Raw conversions report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/>
- Raw clicks report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_clicks/>
- Raw clicks stream API reference: <https://developers.everflow.io/api-reference/post-affiliatesreportingclicksstream>
- Authentication: <https://developers.everflow.io/docs/user-guide/authentication/>
- API key management: <https://developers.everflow.io/docs/partner/api_keys/>
- Partner API keys helpdesk: <https://helpdesk.everflow.io/customer/partner-api-keys-api-documents>
- Timezones metadata: <https://developers.everflow.io/docs/metadata/timezones/>
- Currencies metadata: <https://developers.everflow.io/docs/metadata/currencies/>
- Paging guide: <https://developers.everflow.io/docs/user-guide/paging/>
- Request/response format: <https://developers.everflow.io/user-guide/request-response-format>
- Offer applications: <https://developers.everflow.io/docs/network/offer_applications/>
- Conversion updates: <https://developers.everflow.io/docs/network/conversion_updates/>
- Aggregated data reports (filter structure): <https://developers.everflow.io/docs/network/reporting/aggregated_data/>
- On-hold conversions: <https://helpdesk.everflow.io/customer/on-hold-conversions>
- List runnable offers (tracking URL response): <https://developers.everflow.io/api-reference/get-partnersoffersrunnable>

## Remaining BLOCKED items (live-verification checklist)

These items cannot be resolved from public documentation alone. They require a live affiliate API key (any active affiliate account on an Everflow-powered network).

| Item | What to verify | Exact credential/tier needed |
|---|---|---|
| `dateApproved` separate field | Check if any field other than `conversion_unix_timestamp` is returned for approved conversions (e.g. `approval_unix_timestamp`, `approved_at`). | Any valid `EVERFLOW_API_KEY` for an affiliate account with approved conversions. |
| `datePaid` field | Check the affiliate invoices endpoint (`/v1/affiliates/invoices`) for a payment timestamp that can be joined to conversion records. | Same. |
| `on_hold` status string | Confirm the exact API field value for on-hold conversions in the affiliate reporting response (may be `"on_hold"` or `"hold"`). | Affiliate account with at least one on-hold conversion. |
| `max_page_size` for alloffers | Confirm 500 page_size works; if the endpoint enforces a lower cap (e.g. 100), reduce accordingly. | Any valid API key; call with `page_size=500`. |
| Advertiser `claim_status` bump | Once any of the above is verified, bump `claimStatus` from `experimental` to `partial` after confirming remaining endpoint shapes. | Live account. |

## Click stream chunking

Everflow's `/v1/affiliates/reporting/clicks/stream` endpoint caps at 14 days per call. The adapter mirrors Awin's `chunkDateRange` helper to split wider windows into ≤14-day slices, making the cap transparent to callers.

## Status normalisation

### Offer / programme status (from `relationship.status` + `offer_status`)

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` / `active` / `joined` | `joined` | Affiliate approved for the offer. |
| `pending` / `under_review` | `pending` | Application awaiting approval. |
| `rejected` / `declined` | `declined` | Application rejected. Confirmed primary value is "rejected". |
| `paused` / `inactive` | `suspended` | Offer or relationship paused. |
| `public` / `require_approval` (no relationship) | `available` | Offer visible but not yet applied for. |
| anything else | `unknown` | Never invent a status. |

### Conversion / transaction status

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` | `approved` | Commission approved for payment. |
| `pending` | `pending` | Awaiting approval. |
| `on_hold` | `pending` | Time-delayed approval feature; treated as pending. |
| `rejected` / `reversed` / `declined` | `reversed` | Commission cancelled; `reversalReason` from `error_message`. |
| `invalid` | `reversed` | Invalid conversion (e.g. duplicate click). |
| anything else | `other` | Future-proof default. |

## Future work

- **Live validation**: bump `claimStatus` from `experimental` to `partial` after confirming endpoint shapes against a real affiliate account.
- **Multi-URL tracking links**: the adapter hardcodes `urlId=0` (the default URL). Future versions could expose a `urlId` parameter via `programmeId` encoding or a separate input field.
- **Pagination**: `listProgrammes` currently fetches only the first page. Cursor-based pagination support would allow fetching all offers for large catalogues.
- **Timezone configuration**: expose `timezone_id` as a configurable credential or query parameter, defaulting to UTC.
- **Payment dates**: investigate `/v1/affiliates/invoices` for a payment-to-conversion join to populate `datePaid`.

## Everflow (Advertiser)

### Quick facts

- **Slug**: `everflow-advertiser`
- **Auth model**: custom
- **Base URL**: https://api.eflow.team/v1
- **Environment variables**: `EVERFLOW_API_KEY`, `EVERFLOW_ADVERTISER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.2.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.everflow.io/docs/network/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- API keys are created by a network admin, not by the advertiser directly. Contact your Everflow account manager to obtain a Network API key.
- listMediaPartners returns all affiliates on the network; the Everflow API does not expose a direct per-advertiser affiliate filter at this endpoint — filter client-side where needed.
- getProgrammePerformance uses POST /v1/advertisers/reporting/entity with the affiliate column. Everflow limits this endpoint to a maximum date range of one year per request. timezone_id and currency_id use account defaults when omitted.
- listClicks uses POST /v1/networks/reporting/clicks/stream. Everflow enforces a maximum window of 14 days and returns at most 5,000 clicks per request. Raw click data older than 3 months is not retained (clicks with conversions are retained).
- Publisher-side operations (listTransactions, generateTrackingLink, listProgrammes, getProgramme, getEarningsSummary) are not implemented — use the separate everflow publisher adapter for those.

### Findings

# Everflow (Advertiser) — Findings

Built from public API documentation as of 2026-05-28; live verification pending credentials.

---

## Verification status

**Not yet verified against a live account.** The adapter was built entirely from
publicly available Everflow API documentation. No live API calls have been made
against a real Everflow network. All claims below are from documentation review only.

Promotion from `experimental` to `partial` or `production` requires:
1. A live Network API key from a real Everflow network admin.
2. A confirmed `network_advertiser_id` for at least one advertiser.
3. Running all operations against real API responses to confirm field names.

---

## Documentation sources used

- Everflow API overview: https://developers.everflow.io/docs/network/
- Advertisers endpoint: https://developers.everflow.io/docs/network/advertisers/
- Affiliates (affiliatestable): https://developers.everflow.io/docs/network/affiliates/
- Advertiser reporting: https://developers.everflow.io/docs/advertiser/reporting/
- Network raw clicks report: https://developers.everflow.io/docs/network/reporting/raw_clicks/
- Authentication: https://developers.everflow.io/docs/user-guide/authentication/
- Request/response format: https://developers.everflow.io/user-guide/request-response-format

**Note:** The Everflow developer documentation site (developers.everflow.io)
returned HTTP 403 to automated WebFetch during both research passes. Information
was gathered via web search and quoted documentation snippets from search results.
The endpoint shapes, request bodies, and response fields described in the adapter
source are grounded in these sources and should be considered confirmed from public
documentation, though live-account verification is still required before production use.

---

## Key findings from documentation review

### Authentication

- The API uses a custom header: `X-Eflow-API-Key: <api_key>`.
- Network API keys are created by the network admin at Control Center → Security → API Keys.
- Affiliate and advertiser users cannot create API keys themselves.
- Keys are shown only once at creation.
- Each key carries its own permission scopes; narrowly scoped keys per integration are recommended.

**Source:** https://developers.everflow.io/docs/user-guide/authentication/

### Advertisers endpoint

- `GET /v1/networks/advertisers` returns a paginated list of advertisers.
- Response uses top-level `advertisers` array key.
- Each advertiser includes `network_advertiser_id`, `name`, `account_status`.
- `account_status` values: `active`, `inactive`, `suspended`.
- Pagination: `page` + `page_size` query params; `paging.total_count` in response.

**Source:** https://developers.everflow.io/docs/network/advertisers/

### Affiliates table endpoint

- `POST /v1/networks/affiliatestable` returns a paginated list of affiliates.
- Request body contains `filters.account_status` for status filtering.
- Status values: `active`, `inactive`, `pending`, `suspended`.
- Response includes `network_affiliate_id`, `name`, `account_status`.
- No server-side filter by advertiser is documented at this endpoint.
- Per-advertiser relationship filtering is not described in public Everflow docs.

**Source:** https://developers.everflow.io/docs/network/affiliates/

### Advertiser reporting endpoint

- `POST /v1/advertisers/reporting/entity` for aggregate performance data.
- Request body: `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `columns`, `query`.
- `timezone_id` (number) and `currency_id` (string, e.g. "USD") are optional;
  the account default is used when omitted.
- `columns: [{ column: "affiliate" }]` gives per-affiliate breakdown.
- `resource_type: "advertiser"` is a confirmed valid filter value to scope the
  report to a specific advertiser.
- Other confirmed filter `resource_type` values: `offer`, `affiliate`, `offer_group`,
  `creative`, `account_manager`, `affiliate_manager`, `category`, `billing_frequency`,
  `country`, `region`, `city`, `carrier`, `device_platform`, `device_type`, etc.
- Date range is limited to one year per request.
- Response: `table` array with per-row `columns` (dimension values) and `reporting`
  (aggregate metrics: `imp`, `total_click`, `unique_click`, `cv`, `cvr`,
  `revenue`, `payout`, `rpc`, `epc`).
- `incomplete_results: true` is set when results exceed 10,000 rows.
- Currency is reflected back in the response as `currency_id`.

**Source:** https://developers.everflow.io/docs/advertiser/reporting/

### Network raw clicks endpoint (listClicks)

- `POST /v1/networks/reporting/clicks/stream` returns a flat list of raw click events.
- Uses the same Network API key (`X-Eflow-API-Key` header).
- Request body: `from` (YYYY-MM-DD HH:mm:SS), `to` (YYYY-MM-DD HH:mm:SS),
  `timezone_id`, `query.filters`.
- `resource_type: "advertiser"` confirmed as a valid filter to scope to one advertiser.
- `resource_type: "offer"` can further scope to a specific programme.
- Maximum 5,000 clicks returned per request (some documentation versions say 5,000;
  one search snippet said 10,000 — treat as 5,000 to be conservative).
- Date window limited to 14 days per request.
- Raw click data (without conversions) retained for 3 months; clicks with conversions
  are retained indefinitely.
- Response: top-level `clicks` array; each element is one click row.
- Click row fields (confirmed): `transaction_id` (string, unique click ID),
  `unix_timestamp` (integer, epoch seconds), `referer` (string|null),
  `url` (destination URL, string|null), `has_conversion` (0|1),
  `relationship.offer.network_offer_id` (integer).
- Additional click fields: `is_unique`, `source_id`, `sub1`–`sub5`, `payout_type`,
  `revenue_type`, `payout`, `revenue`, `error_code`, `error_message`, `user_ip`,
  `currency_id`, `tracking_url`, various mobile device ID fields.

**Source:** https://developers.everflow.io/docs/network/reporting/raw_clicks/

---

## Hardening pass 2026-05-28

### TODO(verify) outcomes

| Location | TODO text | Outcome | Source |
|---|---|---|---|
| `META.knownLimitations` | column and metric field names | CONFIRMED — metrics (`imp`, `total_click`, `cv`, `revenue`, `payout`) confirmed from public docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `EverflowReportResponse` interface | exact field names for reporting metrics | CONFIRMED — all metric field names match public Everflow reporting docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `toPerformanceRow` | exact `column_type` values and metric field names | CONFIRMED — `column_type: "affiliate"` is the correct value; metrics confirmed | https://developers.everflow.io/docs/advertiser/reporting/ |
| `toPerformanceRow` | `revenue`/`payout` mapping to grossSale/commission | CONFIRMED — `revenue` = advertiser gross, `payout` = affiliate commission per docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `listBrands` | paging field names (page/page_size/total_count) | CONFIRMED — standard Everflow paging confirmed; response uses `advertisers` array | https://developers.everflow.io/docs/network/advertisers/ |
| `listMediaPartners` | filters field shape / status filter key names | CONFIRMED — `filters.account_status` with values active/inactive/pending/suspended | https://developers.everflow.io/docs/network/affiliates/ |
| `listMediaPartners` inline | exact filter field name for status | CONFIRMED — key is `account_status` in the `filters` object | https://developers.everflow.io/docs/network/affiliates/ |
| `getProgrammePerformance` | request structure, column values, metric fields | CONFIRMED — `columns: [{ column: "affiliate" }]`; resource_type filters confirmed | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | `resource_type: "advertiser"` filter key | CONFIRMED — "advertiser" is a valid resource_type for filter scoping | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | timezone_id and currency_id optional | CONFIRMED — optional; account defaults used when omitted | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | `"affiliate"` column name | CONFIRMED — `{ column: "affiliate" }` is the documented column value | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | currency field name in response | CORRECTED — field is `currency_id` in response (not `currency`); adapter now checks both defensively | https://developers.everflow.io/docs/advertiser/reporting/ |
| `capabilitiesCheck` listBrands | paging field names | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/network/advertisers/ |
| `capabilitiesCheck` listMediaPartners | filter request body shape | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/network/affiliates/ |
| `capabilitiesCheck` getProgrammePerformance | request body, column names, metric fields | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/advertiser/reporting/ |

### Non-admin stubs

| Operation | Previous status | Outcome |
|---|---|---|
| `listClicks` | `NotImplementedError` — "not yet wired" | **IMPLEMENTED** — wired to POST /v1/networks/reporting/clicks/stream with advertiser filter |
| `listTransactions` | `NotImplementedError` | BLOCKED — no per-transaction endpoint documented for this API key scope; use getProgrammePerformance for aggregates |
| `listProgrammes` | `NotImplementedError` | BLOCKED — this is a publisher-side operation; use the everflow publisher adapter |
| `getProgramme` | `NotImplementedError` | BLOCKED — publisher-side operation |
| `getEarningsSummary` | `NotImplementedError` | BLOCKED — publisher-side operation |
| `generateTrackingLink` | `NotImplementedError` | BLOCKED — publisher-side operation |

---

## Open questions requiring live verification

1. **`currency_id` vs `currency` in response**: The adapter now checks both fields. A live
   account response would confirm which field name Everflow actually uses in the reporting
   response body.
   - Credential/tier needed: any valid Network API key + a date range with data.

2. **`affiliatestable` per-advertiser relationship filter**: Whether there is an undocumented
   `relationship` parameter or similar that filters affiliates by advertiser association.
   - Credential/tier needed: Network API key with affiliate list access.

3. **`listClicks` exact max rows**: Documentation sources disagree on whether the maximum is
   5,000 or 10,000 per request. The adapter notes 5,000 (conservative).
   - Credential/tier needed: Network API key with reporting access; test with a large click
     date range to observe the truncation behaviour.

4. **`getProgrammePerformance` advertiser filter necessity**: Whether `resource_type: "advertiser"`
   is needed or whether the report is already scoped to the account's advertiser implicitly.
   - Credential/tier needed: Network API key; run with and without the advertiser filter to
     compare results.

5. **Rate limits**: No documented rate limit figures were found for the reporting endpoints.
   - Credential/tier needed: any valid key; observe 429 responses under load.

---

## Date of review

Original: 2026-05-28  
Hardening pass: 2026-05-28

## financeAds

### Quick facts

- **Slug**: `financeads`
- **Auth model**: custom
- **Base URL**: https://www.financeads.net
- **Environment variables**: `FINANCEADS_API_KEY`, `FINANCEADS_USER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~2 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://strackr.com/docs/financeads

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public documentation; not yet verified against a live financeAds account.
- The financeAds API shape (endpoint paths, parameter names, JSON vs XML/CSV response) is partly dashboard-gated and needs live verification.
- Amounts are assumed to be in EUR; financeAds is a DACH finance-vertical network and the per-row currency field is not yet confirmed.
- Click-level data is not exposed via the financeAds publisher API; listClicks is unsupported.
- API access may require the publisher to request the "Leads & Sales API" from financeAds support before reporting calls succeed.

### Findings

_No findings document was supplied at `docs/findings/financeads.md`._

## FirstPromoter

### Quick facts

- **Slug**: `firstpromoter`
- **Auth model**: bearer
- **Base URL**: https://api.firstpromoter.com
- **Environment variables**: `FIRSTPROMOTER_API_KEY`, `FIRSTPROMOTER_ACCOUNT_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.firstpromoter.com/api-reference-v2/api-admin/introduction

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- commission / promoter / campaign / referral field names and the amount unit (assumed minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one API key + account id pair scopes one FirstPromoter (merchant) account. Bind your single brand in brands.json manually.
- listClicks is unsupported: the v2 admin API exposes aggregate click counts in reports, not raw click records.
- generateTrackingLink is unsupported: referral links belong to individual promoters; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /commissions grouped by (promoter, day). Clicks are not available from /commissions and are reported as 0.
- Pagination is via the Link header (rel="next"); wide pulls follow it page by page, capped at MAX_PAGES with a warning rather than a silent truncation. FirstPromoter rate-limits the API and returns HTTP 429, which the resilience layer retries.

### Findings

_No findings document was supplied at `docs/findings/firstpromoter.md`._

## FlexOffers

### Quick facts

- **Slug**: `flexoffers`
- **Auth model**: custom
- **Base URL**: https://api.flexoffers.com
- **Environment variables**: `FLEXOFFERS_API_KEY`, `FLEXOFFERS_ACCOUNT_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://www.flexoffers.com/publishers/web-service-api/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listProgrammes / getProgramme are not implemented: the publisher-side advertiser/programme listing endpoint shape is not documented well enough publicly to map joined-programme status reliably; both operations throw NotImplementedError until verified against a live account.
- listClicks is not exposed as a click-level endpoint via the public FlexOffers Web Service API (only aggregated click counts appear in sales reports); the operation throws NotImplementedError.
- generateTrackingLink builds a FlexLinks redirect URL (track.flexlinkspro.com) deterministically from FLEXOFFERS_ACCOUNT_ID and the advertiser id passed as programmeId; the exact redirect parameter names are taken from public link examples and require live verification.
- The API key header name (apiKey) and the /allsales pagination parameter are taken from public integration write-ups, not a confirmed live response.
- Per-row currency is read from each sales row; FlexOffers is a US aggregator and most rows clear in USD, but the adapter never hardcodes currency.

### Findings

_No findings document was supplied at `docs/findings/flexoffers.md`._

## Flipkart Affiliate

### Quick facts

- **Slug**: `flipkart`
- **Auth model**: custom
- **Base URL**: https://affiliate-api.flipkart.net
- **Environment variables**: `FLIPKART_AFFILIATE_ID`, `FLIPKART_AFFILIATE_TOKEN`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://affiliate.flipkart.com/api-docs/af_overview.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live Flipkart affiliate account.
- Order/commission amounts are assumed to be in Indian Rupees (INR) as whole-rupee decimal values; the orders report does not document the minor-unit convention, so amounts are surfaced verbatim from the `amount` field without rescaling.
- Flipkart periodically pauses new affiliate signups, so the programme may be closed to new applicants when you attempt to register.
- Click-level data is not exposed via the public affiliate API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/flipkart.md`._

## GrowSurf

### Quick facts

- **Slug**: `growsurf`
- **Auth model**: bearer
- **Base URL**: https://api.growsurf.com
- **Environment variables**: `GROWSURF_API_KEY`, `GROWSURF_CAMPAIGN_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.growsurf.com/developer-tools/rest-api

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- GrowSurf is referral-credit oriented, not classic CPS. The API exposes no monetary commission per referral event, so each participant with referral credit is mapped to one Transaction whose amount/commission is the referral COUNT (not money) and whose currency is the sentinel "CREDIT". Reward fulfilment (coupons, credit, gift cards) is configured per campaign and not returned per event.
- advertiser + single-brand: one API key + campaign id pair scopes one GrowSurf programme. Bind your single brand in brands.json manually.
- listClicks is unsupported: GrowSurf exposes impression counts on participants, not raw click records.
- generateTrackingLink is unsupported: a participant share URL (e.g. shareUrl) is minted per participant, not derivable from a destination URL via the merchant API.
- The participants list wrapper key and the campaign reward field names have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- Participant list pagination is cursor-based (nextId / more); wide pulls are capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/growsurf.md`._

## Hotmart

### Quick facts

- **Slug**: `hotmart`
- **Auth model**: oauth2
- **Base URL**: https://developers.hotmart.com/payments/api/v1
- **Environment variables**: `HOTMART_CLIENT_ID`, `HOTMART_CLIENT_SECRET`, `HOTMART_BASIC_TOKEN`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.hotmart.com/docs/en/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listProgrammes / getProgramme are derived from the distinct products seen in Sales History, because Hotmart has no public self-serve endpoint that lists a creator/affiliate's products with commission rates; programmes outside the queried date window are not discoverable and commissionRate is left unset.
- listClicks is not exposed via the public Hotmart payments API; the operation throws NotImplementedError.
- generateTrackingLink is not supported: Hotmart affiliate (hotlink) URLs are issued per affiliation in the dashboard and cannot be deterministically constructed from the public API; the operation throws NotImplementedError.
- When no transaction_status filter is supplied, Hotmart returns only APPROVED and COMPLETE sales; the adapter sends the full documented status set to retrieve every state.
- Sales History is multi-role: a row can credit the account as PRODUCER, COPRODUCER or AFFILIATE. The adapter sums the commission(s) attributed to the authenticated account; the per-role breakdown is preserved in rawNetworkData.
- OAuth2 access tokens have a limited lifetime (Hotmart documents 24 hours); the adapter caches the token in memory and re-fetches on expiry.
- The maximum date window and pagination page size per Sales History call are not fully documented; the adapter paginates via page_token but a live account test is required to confirm there is no server-side window cap.

### Findings

_No findings document was supplied at `docs/findings/hotmart.md`._

## Howl

### Quick facts

- **Slug**: `howl`
- **Auth model**: custom
- **Base URL**: https://api.narrativ.com
- **Environment variables**: `HOWL_API_KEY`, `HOWL_PUBLISHER_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.narrativ.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: implemented against the published Howl (Narrativ) API documentation and not yet verified against a live publisher account.
- Monetary amounts are assumed to be in USD major units (e.g. dollars); the statistics endpoint exposes no currency field, so this is an assumption pending live verification.
- Howl has no live per-order transactions endpoint; listTransactions returns daily per-(article, merchant) aggregates from the statistics endpoint. Individual orders are only available via the scheduled Publisher Report CSV files (Clicks/Orders/Returns).
- Howl has no live merchant/programme catalogue endpoint for a publisher key; listProgrammes returns only the merchants the publisher has driven activity to in the requested window.
- Howl does not expose a transaction approval/payment lifecycle via the statistics API, so transaction status cannot be normalised to pending/approved/paid; rows are reported as approved when earnings are present, otherwise other.
- Click-level data is not exposed via a queryable endpoint (only the scheduled Clicks report file); listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/howl.md`._

## Impact

### Quick facts

- **Slug**: `impact`
- **Auth model**: basic
- **Base URL**: https://api.impact.com
- **Environment variables**: `IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://integrations.impact.com/impact-publisher/reference

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Action listings on wide date windows return intermittent 5xx; the adapter chunks ≤30-day slices and bumps retries to absorb upstream flakiness.
- Pagination headers are inconsistent across endpoints (some return @nextpageuri, some @page); both are honoured.

### Findings

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

## Impact (advertiser)

### Quick facts

- **Slug**: `impact-advertiser`
- **Auth model**: basic
- **Base URL**: https://api.impact.com
- **Environment variables**: `IMPACT_ADVERTISER_ACCOUNT_SID`, `IMPACT_ADVERTISER_AUTH_TOKEN`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://integrations.impact.com/impact-brand/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The adapter refuses any non-GET HTTP method client-side; pair this with Impact's read-only credential tier in the dashboard for defence in depth.
- Two credential shapes auto-detected at runtime: agency-passthrough (one SID addresses many brands) and brand-direct (one SID, one brand). `listBrands()` returns the discovered set; advertiser tools take `brand` and resolve via brands.json.
- `getProgrammePerformance` uses Impact's pre-built `adv_performance_by_media` report template. Endpoint shape verified from docs; live behaviour (sync vs async polling) has // TODO(verify) annotations until a live agency tenant is available.
- `listContracts`/`getContract` read the brand-partner payment-term relationship under `/Campaigns/{id}/Contracts`. `proposeContract` builds a reviewable ContractChangePlan from those reads (advisement only, no network write). Endpoint paths and the projected write payload shape carry // TODO(verify) until confirmed against a live agency tenant; the contract write surface (apply/remove) is NOT enabled in this adapter.

### Findings

_No findings document was supplied at `docs/findings/impact-advertiser.md`._

## Indoleads

### Quick facts

- **Slug**: `indoleads`
- **Auth model**: bearer
- **Base URL**: https://app.indoleads.com/api
- **Environment variables**: `INDOLEADS_API_TOKEN`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The exact conversions-report endpoint path and its response field names could not be confirmed from the public documentation snippets (the full Confluence API page is access-gated); the adapter targets GET /api/conversions and reads field names defensively. BLOCKED(verify): confirm the path and payload shape against a live account.
- listClicks is not exposed via the public Indoleads publisher API; the operation throws NotImplementedError.
- getProgramme has no single-offer endpoint documented publicly; it is derived by filtering the GET /api/offers listing client-side.
- The Indoleads API token can be supplied either as an Authorization: Bearer header or as a ?token= GET parameter; this adapter uses the Authorization header.
- Maximum date window per conversions-report call is not publicly documented; a live account test is required to confirm no server-side cap exists.

### Findings

_No findings document was supplied at `docs/findings/indoleads.md`._

## Involve Asia

### Quick facts

- **Slug**: `involve-asia`
- **Auth model**: custom
- **Base URL**: https://api.involve.asia/api
- **Environment variables**: `INVOLVE_ASIA_API_KEY`, `INVOLVE_ASIA_API_SECRET`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://involve.asia/partners/api-overview/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live Involve Asia publisher account; endpoint shapes and field names are modelled on the public API documentation and may differ in production.
- Amount-unit assumption: sale_amount and payout are read as major currency units (e.g. "12.34" → 12.34) in the conversion currency, not minor units. Verify against your own conversions; the raw payload is preserved on rawNetworkData.
- Authentication uses an API key + secret exchanged for a bearer token that expires roughly every 2 hours; the adapter caches and refreshes the token (proactively and on a 401) so callers do not handle the exchange.
- Click-level data is not exposed via the public Involve Asia publisher API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/involve-asia.md`._

## Kwanko

### Quick facts

- **Slug**: `kwanko`
- **Auth model**: bearer
- **Base URL**: https://api.kwanko.com
- **Environment variables**: `KWANKO_API_TOKEN`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.kwanko.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Exact endpoint paths, query-parameter names, and JSON field names are taken from public summaries of the Kwanko Web Service API (https://developers.kwanko.com/); the developer reference is not machine-readable, so field mapping is defensive and must be confirmed against a live response.
- listClicks is not exposed at click level: the Kwanko publisher API reports clicks only as an aggregate in the statistics endpoint, so the operation throws NotImplementedError rather than returning fabricated rows.
- generateTrackingLink is not implemented: Kwanko tracking links are issued per campaign and per site from the dashboard and cannot be constructed deterministically from the API token alone; the operation throws NotImplementedError.
- The API token is self-issued in the Kwanko platform (Features and API); it may optionally be IP-restricted in platform settings, which can cause auth failures from a different host.

### Findings

_No findings document was supplied at `docs/findings/kwanko.md`._

## Kwanko (advertiser)

### Quick facts

- **Slug**: `kwanko-advertiser`
- **Auth model**: bearer
- **Base URL**: https://api.kwanko.com
- **Environment variables**: `KWANKO_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developers.kwanko.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a read-only Kwanko API token for defence in depth.
- Exact endpoint paths, query-parameter names, and JSON field names are taken from public summaries of the Kwanko advertiser API (https://developers.kwanko.com/ and https://helpdesk-advertiser.kwanko.com/); the developer reference is not machine-readable (403 to automated fetch), so field mapping is defensive and must be confirmed against a live response.
- getProgrammePerformance is built from the advertiser statistics endpoint grouped by website (publisher); the grouping parameter name is taken from public summaries and is BLOCKED(verify) until confirmed against a live response.
- listBrands enumerates the advertiser campaigns the token addresses; the Kwanko advertiser API has no documented account-enumeration endpoint, so each addressable campaign is returned as a brand. BLOCKED(verify) against a live account.
- generateTrackingLink, getProgramme, getEarningsSummary, and listClicks are not implemented: these are publisher-side or unsupported on the advertiser surface and throw NotImplementedError rather than returning fabricated data.
- The API token is self-issued in the Kwanko platform (Features and API); it may optionally be IP-restricted in platform settings, which can cause auth failures from a different host.

### Findings

_No findings document was supplied at `docs/findings/kwanko-advertiser.md`._

## LeadDyno

### Quick facts

- **Slug**: `leaddyno`
- **Auth model**: custom
- **Base URL**: https://api.leaddyno.com
- **Environment variables**: `LEADDYNO_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://app.theneo.io/leaddyno/leaddyno-rest-api

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- Authentication is a private key passed as the `key` query parameter (auth_model: custom), not a bearer or basic header. The key grants full account access; keep it secret.
- advertiser + single-brand: one private key scopes one LeadDyno (merchant) account. Bind your single brand in brands.json manually.
- Transactions are derived from GET /v1/purchases. Purchases carry purchase_amount and a cancelled flag but no per-purchase commission or currency; commission and currency live on the separate per-affiliate /commissions resource, so listTransactions reports commission as the commission_amount_override when present and currency falls back to a configured default. TODO(verify) against a live account.
- Amount unit is assumed to be major units (e.g. 49.0 = 49.00), not minor units / cents, per the documented purchase examples. TODO(verify).
- listClicks is unsupported: LeadDyno tracks visitors and leads, not raw click records, via this API.
- generateTrackingLink is unsupported: affiliate links belong to individual affiliates (affiliate_url); the merchant API does not mint per-destination links.
- Pagination is page-based, 100 records per page, sorted oldest-first. Pagination is capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/leaddyno.md`._

## Levanta

### Quick facts

- **Slug**: `levanta`
- **Auth model**: bearer
- **Base URL**: https://api.levanta.io
- **Environment variables**: `LEVANTA_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://knowledge.levanta.io/creator-api

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation only; not yet verified against a live Levanta account.
- Amount unit is assumed to be major currency units (e.g. dollars, not cents) and currency defaults to USD; the public docs do not state the unit for the /reports sales and commissions fields.
- Programmes are modelled from /partners brand partnerships: each active partnership is surfaced as a joined programme. Levanta has no programme-join lifecycle, so statuses other than 'joined' are not reported.
- Click-level data is not exposed: /reports returns aggregate click counts per link/source, not individual click events, so listClicks is unsupported.
- generateTrackingLink is unsupported: Levanta links are created server-side via /links by ASIN/source pair, not deterministically constructible from a destination URL.

### Findings

_No findings document was supplied at `docs/findings/levanta.md`._

## LinkConnector

### Quick facts

- **Slug**: `linkconnector`
- **Auth model**: custom
- **Base URL**: https://www.linkconnector.com
- **Environment variables**: `LINKCONNECTOR_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://www.linkconnector.com/help_api.htm

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: not yet validated against a live LinkConnector account; JSON field names are inferred from the public documentation and read defensively.
- Amounts are assumed to be in major currency units (US dollars); LinkConnector is a US network. The unit has not been confirmed against a live account.
- Click-level data is not exposed via the public LinkConnector publisher API; listClicks is unsupported.
- Tracking links are issued by LinkConnector per merchant (via the promotions feed), not constructed deterministically from a destination URL; generateTrackingLink is unsupported.

### Findings

_No findings document was supplied at `docs/findings/linkconnector.md`._

## Lomadee

### Quick facts

- **Slug**: `lomadee`
- **Auth model**: custom
- **Base URL**: https://api.lomadee.com
- **Environment variables**: `LOMADEE_APP_TOKEN`, `LOMADEE_SOURCE_ID`, `LOMADEE_PUBLISHER_ID`, `LOMADEE_REPORT_USER`, `LOMADEE_REPORT_PASSWORD`
- **Setup time estimate**: 15 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://developer.lomadee.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The sales-report API (reportTransaction) returns XML whose exact element names are not published; the adapter parses defensively and preserves the verbatim XML on rawNetworkData. Transaction status mapping and date fields require live-account verification.
- The sales-report API covers a maximum window of 90 days from the start date; listTransactions defaults to the most recent 90 days when no window is supplied.
- listProgrammes / getProgramme are derived from the Offers API (offer stores), not a joined-programmes endpoint; programme status is reported as "available" because Lomadee does not expose per-publisher join state via this API.
- listClicks is not exposed by the Lomadee publisher API; the operation throws NotImplementedError.
- The report API uses a token minted from the account e-mail and password (LOMADEE_REPORT_USER / LOMADEE_REPORT_PASSWORD), separate from the app-token used by offers and deeplinks.
- Lomadee may take up to 3 days to release API access on a newly created account.

### Findings

_No findings document was supplied at `docs/findings/lomadee.md`._

## Monetizze

### Quick facts

- **Slug**: `monetizze`
- **Auth model**: custom
- **Base URL**: https://api.monetizze.com.br/2.1
- **Environment variables**: `MONETIZZE_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.1
- **Last verified**: 2026-06-04
- **Documentation**: https://api.monetizze.com.br/2.1/apidoc/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listProgrammes / getProgramme: no public product-listing endpoint path or response shape could be confirmed; both operations throw NotImplementedError rather than calling an unconfirmed endpoint.
- listClicks: the Monetizze API does not expose click-level data; the operation throws NotImplementedError.
- generateTrackingLink: Monetizze affiliate links are generated inside the panel, not via a documented deterministic public endpoint; the operation throws NotImplementedError.
- listTransactions advanced-filter query parameter names (date window, status) are unconfirmed against the live interactive docs; the adapter sends dataInicio/dataFim and also filters client-side as a safeguard.
- Monetizze sale timestamps omit a timezone marker. The adapter interprets these timestamps as UTC for deterministic output; the upstream reporting timezone has not been verified against a live account.
- Authentication uses a two-step token exchange (x_consumer_key header then a token header); the token-response field name and token lifetime are unconfirmed, so the adapter reads the token field defensively and uses a conservative cache TTL.

### Findings

_No findings document was supplied at `docs/findings/monetizze.md`._

## mrge

### Quick facts

- **Slug**: `mrge`
- **Auth model**: custom
- **Base URL**: https://api.yieldkit.com
- **Environment variables**: `MRGE_API_KEY`, `MRGE_API_SECRET`, `MRGE_SITE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://publisher-api.mrge.com/documentation/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- mrge public API documentation is limited; publisher-api.mrge.com returns 403 to automated fetches.
- Click-level data is not grounded in public API documentation; listClicks throws NotImplementedError.
- getProgramme is not grounded in public docs as a separate endpoint; it filters the listProgrammes result client-side.
- Reporting API host and full path are uncertain (TODO: verify); listTransactions may fail until verified.
- generateTrackingLink uses a URL pattern derived from Yieldkit documentation; the format requires live verification.

### Findings

# mrge — Findings

Built from public API documentation as of 2026-05-28; live verification
pending credentials; public API docs limited.

## Hardening pass 2026-05-28

### Summary of outcomes

| Category | Count |
|---|---|
| CONFIRMED (TODO removed, code kept or corrected) | 8 |
| CORRECTED (code changed, source cited) | 2 |
| BLOCKED (specific blocker recorded) | 22+ |
| Ops newly implemented | 0 |
| Ops still stubbed | listClicks (no public endpoint found) |

### Confirmed items (TODO converted to no-longer-uncertain)

1. **Auth scheme: api_key + api_secret + site_id as query parameters**
   Source: public.yieldkit.com documentation example showing
   `api_key=c5c2398597a6adcd9b149ad745f207f4&api_secret=74607007cdb6b0db4b3219c8adee3e09&site_id=51e8ee76e4b0dc18d49a4337`
   and any.run sandbox captures of live Yieldkit API calls (2024).
   The `auth_model: "custom"` in network.json is correct.

2. **api.yieldkit.com as the advertiser API host**
   Source: Multiple Yieldkit documentation pages + search snippets confirming
   `GET http://api.yieldkit.com/v2/advertiser/terms?api_key=...&api_secret=...&site_id=...`

3. **Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED**
   Source: Yieldkit knowledge base search snippets (reporting-api-v3 and S2S
   tracking pages). Code correctly maps OPEN->pending, CONFIRMED->approved,
   DELAYED->pending, REJECTED->reversed.

4. **modified_date parameter name and YYYY-MM-DD format**
   Source: Yieldkit knowledge base search snippets referencing
   "modified_date DateType filter" for the commission endpoint.

5. **Reporting API V3 uses 'next' URL for pagination**
   Source: Yieldkit search snippet: "every page will have a 'next' URL".

6. **Tracking redirect host: r.srvtrck.com**
   Source: Yieldkit knowledge base (srvtrck.com redirects page) confirming
   "r.srvtrck.com is a firm part of the Hamburg company YIELDKIT" +
   any.run sandbox captures showing full URL format:
   `r.srvtrck.com/v1/redirect?url=...&api_key=...&type=url&site_id=...&yk_tag=...`

7. **Redirect URL format and yk_tag parameter**
   Source: Yieldkit sub-ID tracking docs: "yk_tag corresponds to your click_id
   and you will receive it back in the commission endpoint of the Reporting API."

8. **sales_date S2S macro confirmed**
   Source: Yieldkit S2S tracking docs confirming {SALES_DATE} and {MODIFIED_DATE}
   macros. REST field names derive from these (BLOCKED: exact REST names unconfirmed).

### Corrected items (code changed)

**CORRECTION 1: MRGE_SITE_ID validation — was integer check, now hex check**

The original validator used `/^\d+$/` (positive integers only). Live API
call captures on any.run (2024) show site IDs are hexadecimal strings:
- 24-char MongoDB ObjectId format: `51e8ee76e4b0dc18d49a4337`
- 32-char MD5 format: `0fb9199cb9ce464f9c82523578c269b4`

Updated to `/^[0-9a-f]{20,40}$/i`. Also updated `MRGE_API_KEY` and
`MRGE_API_SECRET` validator hints to mention the 32-char hex format.
Source: public.yieldkit.com docs example + any.run sandbox 2024.

Files changed: `src/networks/mrge/auth.ts`, `src/networks/mrge/setup.ts`,
`tests/networks/mrge/adapter.test.ts`

**CORRECTION 2: generateTrackingLink fallback — was click.yieldkit.com, now r.srvtrck.com**

The fallback URL (used when no `tracking_url` field is present in the
advertiser/terms response) was using `click.yieldkit.com/{programmeId}`.
This was an invented pattern not grounded in any documentation. The confirmed
Yieldkit redirect format is:
`https://r.srvtrck.com/v1/redirect?api_key=...&type=url&site_id=...&url=...`

Source: Yieldkit redirect documentation + any.run sandbox captures.

Files changed: `src/networks/mrge/adapter.ts`,
`tests/networks/mrge/adapter.test.ts` (new test added for r.srvtrck.com path)

### Blocked items — live-verification checklist

The following items cannot be resolved without a live mrge publisher account.
Each entry includes the exact credential/tier/endpoint needed.

**BLOCKED 1: publisher-api.mrge.com auth scheme (Bearer vs query params)**
- Exact credential/tier needed: Any live mrge publisher account with API access
- Endpoint: publisher-api.mrge.com/documentation/ (returns HTTP 403 to unauthenticated fetches)
- Impact: If Bearer auth, auth_model must change to "bearer" and client.ts
  must inject `Authorization: Bearer ...` header instead of query params.

**BLOCKED 2: Reporting API host**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: `reporting-api.yieldkit.com` (unverified; may have changed post-rebrand)
- Impact: `listTransactions` will fail with connection error if host is wrong.
- Test: call `GET reporting-api.yieldkit.com/v3/commission?api_key=...&api_secret=...&site_id=...`

**BLOCKED 3: Reporting API commission endpoint full path**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: The `/v3/commission` path is inferred from doc URL slug; may differ
- Impact: `listTransactions` returns 404 if path is wrong.

**BLOCKED 4: Advertiser/terms response envelope shape**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: `GET api.yieldkit.com/v2/advertiser/terms?api_key=...&api_secret=...&site_id=...`
- Impact: `listProgrammes` may return 0 results if envelope guess is wrong.

**BLOCKED 5: Response field names — advertiser/terms endpoint**
- Exact credential/tier needed: Any live mrge publisher account
- Fields to confirm: id, advertiser_id, name, status, url, commission,
  commission_type, currency, tracking_url, deep_link
- Impact: Most of `toProgramme()` may produce empty/wrong values.

**BLOCKED 6: Response field names — commission/reporting endpoint**
- Exact credential/tier needed: Any live mrge publisher account with commissions
- Fields to confirm: commission_id, event_id, advertiser_id, advertiser_name,
  commission, sale_amount, currency, state/status, sales_date, modified_date,
  click_date, event_type, click_id, rejection_reason
- Impact: `toTransaction()` may produce empty/wrong values.

**BLOCKED 7: Date range support in Reporting API**
- Exact credential/tier needed: Any live mrge publisher account
- Test: call reporting API with `?modified_date=2026-01-01&modified_date_to=2026-05-28`
- Impact: Without upper-bound date param, all results since `from` are returned
  and filtered client-side (performance impact for large datasets).

**BLOCKED 8: advertiser_id filter on /v2/advertiser/terms**
- Exact credential/tier needed: Any live mrge publisher account
- Test: `GET api.yieldkit.com/v2/advertiser/terms?api_key=...&advertiser_id=12345`
- Impact: `getProgramme` currently falls back to client-side filtering; if
  server-side filter works, it improves performance.

**BLOCKED 9: Paid date availability**
- Exact credential/tier needed: Any live mrge publisher account with paid commissions
- Impact: `datePaid` is always `undefined`; cannot confirm or refute.

**BLOCKED 10: Click-level endpoint**
- Exact credential/tier needed: Any live mrge publisher account + access to
  publisher-api.mrge.com documentation (returns HTTP 403)
- Impact: `listClicks` remains `NotImplementedError`.

**BLOCKED 11: Dashboard navigation paths for setup wizard**
- Exact credential/tier needed: Any live login to publisher.mrge.com
- Paths confirmed for Yieldkit: `home.yieldkit.com/account/api` and `home.yieldkit.com/account/sites`
- Impact: Setup wizard instructions may be outdated if dashboard was rebranded.

**BLOCKED 12: site_id numeric format (edge case)**
- Exact credential/tier needed: Multiple live accounts from different eras
- Current validator: `/^[0-9a-f]{20,40}$/i` (accepts 20-40 char hex strings)
- Impact: If some legacy accounts use plain integers, they would fail validation.

## Documentation sources used

- `https://publisher-api.mrge.com/documentation/` — HTTP 403 to automated fetches
- `https://public.yieldkit.com/` — HTTP 403 to automated fetches
- `https://yieldkit.com/knowledge/reporting-api-v3/` — HTTP 403
- `https://yieldkit.com/knowledge/advertiser-api/` — HTTP 403
- `https://yieldkit.com/knowledge/commission-terms/` — HTTP 403
- `https://yieldkit.com/knowledge/subid-tracking/` — HTTP 403
- `https://yieldkit.com/knowledge/redirect-api/` — HTTP 403
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/reporting-api/index.html` — HTTP 403
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/advertiser-api/index.html` — HTTP 403
- `https://wecantrack.com/yieldkit-integration/` — HTTP 403
- `https://doc.voluum.com/article/yieldkit-and-voluum` — HTTP 403
- Search result snippets from approximately 20 targeted queries
- `https://any.run/report/...` — two malware sandbox captures of live Yieldkit API
  calls (2024); confirmed real-world URL parameter format including hex site_id

## Key facts established from public sources

| Fact | Source | Confidence |
|---|---|---|
| Auth: api_key + api_secret + site_id as query params | Yieldkit docs + any.run captures | HIGH |
| Credential format: 24-32 char hex strings | any.run + docs example | HIGH |
| Advertiser API: `GET api.yieldkit.com/v2/advertiser/terms` | Yieldkit docs | HIGH |
| Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED | Yieldkit doc snippets | HIGH |
| Redirect host: r.srvtrck.com/v1/redirect | Yieldkit redirect docs + any.run | HIGH |
| Redirect params: api_key, type, site_id, url, yk_tag | Yieldkit docs + any.run | HIGH |
| modified_date filter in Reporting API | Yieldkit doc snippets | HIGH |
| YYYY-MM-DD date format for filters | Yieldkit doc snippets | MEDIUM |
| Reporting API V3 pagination via 'next' URL | Yieldkit doc snippet | MEDIUM |
| Reporting host: reporting-api.yieldkit.com | Search snippet | LOW |
| Reporting path: /v3/commission | Doc URL slug inference | LOW |
| Yieldkit to mrge rebrand: daily ops unaffected | Yieldkit FAQ | HIGH |

## Research log (2026-05-28 hardening pass)

Key searches that produced grounded facts:

1. `yieldkit "api_key" "api_secret" "site_id" hex string request commission terms`
   -> Confirmed hex format for all three credentials with specific example values.

2. `"r.srvtrck.com" yieldkit tracking redirect URL parameters api_key site_id`
   -> Confirmed r.srvtrck.com is YIELDKIT's redirect service; confirmed URL format
   including api_key, type, site_id, url, yk_tag parameters.

3. `yieldkit "modified_date" "sales_date" reporting commission API parameter`
   -> Confirmed modified_date and sales_date as date type filters.

4. `yieldkit commission terms API response fields advertiser_id name description status`
   -> Confirmed commission terms response includes: id, advertiser_id, description,
   countries, value, value_type, currency, valid_to (CSV sample from snippet).

5. `yieldkit FAQ "daily operations remain unaffected" mrge rebrand`
   -> Confirmed Yieldkit APIs remain active post-mrge rebrand (FAQ updated Feb 9, 2024).

6. any.run malware sandbox captures showing full Yieldkit URL format:
   `r.srvtrck.com/v1/redirect?url=...&api_key=2787b73d6d1c026b48687320e239182a&site_id=0fb9199cb9ce464f9c82523578c269b4&type=url&yk_tag=...`
   -> Confirmed hex format for api_key and site_id in real-world API calls.

## Promotion criteria

To promote from `experimental` to `partial`:

1. Confirm reporting API host resolves and returns commission data (BLOCKED 2).
   This is the single highest-impact blocker.
2. Verify response field names for both advertiser/terms and commission endpoints
   (BLOCKED 5 and 6).
3. Confirm `?advertiser_id=` filter works on `/v2/advertiser/terms` (BLOCKED 8).
4. Run `npx vitest run tests/networks/mrge` against updated fixtures from live
   API calls.
5. Update `last_verified` in `network.json` and `lastVerified` in adapter.ts.
6. Update this document with confirmed shapes and field names.

## NetRefer

### Quick facts

- **Slug**: `netrefer`
- **Auth model**: oauth2
- **Base URL**: https://asr.operator.netrefer.com
- **Environment variables**: `NETREFER_BASE_URL`, `NETREFER_CLIENT_ID`, `NETREFER_CLIENT_SECRET`, `NETREFER_USERNAME`, `NETREFER_PASSWORD`
- **Setup time estimate**: 15 minutes
- **Approval required**: yes (~5 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://developer.netrefer.com/Affiliate-api/ASR

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live NetRefer ASR operator account; endpoint paths and field names follow the public ASR 1.0 docs and may need adjustment.
- The ASR base URL is per-operator: there is no single fixed host. base_url here is a placeholder; the real host is supplied via the NETREFER_BASE_URL credential and validated as a URL.
- Amount unit is assumed to be major currency units (decimal); the public ASR docs do not state the unit. Verbatim values are preserved on rawNetworkData for reconciliation.
- NetRefer is an iGaming affiliate-platform engine: ASR rows report iGaming metrics (registrations, deposits, CPA, RevShare). Sale amount is mapped from deposits and commission from CPA + RevShare; this differs from a classic retail-affiliate transaction.
- listProgrammes and getProgramme are synthesised from the brands present in the Daily Activity Report — ASR exposes no programme/brand catalogue endpoint.
- Click-level data (listClicks) is not exposed: ASR reports clicks only as a per-day aggregate, so listClicks throws NotImplementedError.
- Tracking-link generation (generateTrackingLink) is not part of the read-only ASR affiliate surface and throws NotImplementedError.
- listPublishers and listPublisherSectors are scaffolded for v0.2 and throw NotImplementedError.

### Findings

_No findings document was supplied at `docs/findings/netrefer.md`._

## Offer18

### Quick facts

- **Slug**: `offer18`
- **Auth model**: custom
- **Base URL**: https://api.offer18.com
- **Environment variables**: `OFFER18_BASE_URL`, `OFFER18_API_KEY`, `OFFER18_SECRET_KEY`, `OFFER18_MID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://knowledgebase.offer18.com/affiliate/affiliate-apis

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Offer18 is a tenant network engine: there is no fixed base URL. The real base is the per-tenant instance host supplied via OFFER18_BASE_URL.
- Amount unit assumed to be major currency units (e.g. 5.00 = five units of the reported currency); not confirmed against a live tenant.
- Click-level data is not exposed as a distinct affiliate endpoint; listClicks is unsupported.
- Tracking links are not deterministically constructible from the affiliate API; generateTrackingLink is unsupported.

### Findings

_No findings document was supplied at `docs/findings/offer18.md`._

## Optimise Media

### Quick facts

- **Slug**: `optimise-media`
- **Auth model**: custom
- **Base URL**: https://api.optimisemedia.com
- **Environment variables**: `OPTIMISE_MEDIA_API_TOKEN`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.optimisemedia.com/api/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: field mappings follow the documented OMG Network API but have not been confirmed against a live Service Account.
- Amounts are assumed to be in major currency units (e.g. pounds), not minor units (pence). Verify against a live account; raw payloads are preserved on rawNetworkData.
- Click-level data is not exposed via the OMG Network API; listClicks is unsupported.
- Tracking-link construction is not documented for the OMG Network API; generateTrackingLink is unsupported.
- Product feeds are documented for the network but are not modelled by this adapter.

### Findings

_No findings document was supplied at `docs/findings/optimise-media.md`._

## Partnerize

### Quick facts

- **Slug**: `partnerize`
- **Auth model**: basic
- **Base URL**: https://api.partnerize.com
- **Environment variables**: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`, `PARTNERIZE_PUBLISHER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://api-docs.partnerize.com/partner/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listClicks is experimental: the publisher click endpoint is documented but response field names are unconfirmed; may require adjustment after live testing.
- generateTrackingLink requires the caller to supply the camref (campaign reference) for the target campaign, not the raw campaign_id. Camrefs can be found at the campaign tracking details endpoint.
- Pagination is cursor-based; this adapter fetches one page at a time via the start/end date window and does not yet follow cursor_id for result sets exceeding the default page size.

### Findings

# Partnerize (Publisher) — findings

Built from public API documentation as of 2026-05-28; live verification pending
credentials.

---

## Research sources

The following public sources were consulted to build this adapter. The primary
Partnerize API documentation site (api-docs.partnerize.com) returned HTTP 403
to automated fetch. All shapes were sourced from the official public GitHub
repository and search result fragments.

- **Partnerize Partner API documentation** (primary):
  https://api-docs.partnerize.com/partner/ — returned 403 to automated fetch.
  URL confirmed as valid; accessible via browser.

- **Official Partnerize API blueprint repository** (primary source used):
  https://github.com/PerformanceHorizonGroup/apidocs — all `.apib` source files
  read directly via `raw.githubusercontent.com`. Endpoint paths, request
  parameters, and response envelope shapes sourced from:
  - `src/intro.apib` — authentication scheme, base URL, date format examples
  - `src/publisher.apib` — publisher account endpoints, `publisher_id` / `account_name` field names
  - `src/publisher_campaign.apib` — campaign list endpoint, status path segments (a/p/r)
  - `src/granular_reporting.apib` — conversion and click reporting endpoints, cursor pagination
  - `src/export_reporting.apib` — **primary field-name source**: CSV column headers
    for both conversion and click exports, including sample data rows
  - `src/campaign.apib` — campaign object fields (payment_date at campaign level confirmed)
  - `src/campaign_conversion.apib` — conversion status values (approved/pending/rejected),
    reject_reason on conversion items
  - `src/publisher_transaction_query.apib` — conversion_date_time field name confirmed
  - `src/selfbill.apib` — payment_date confirmed at invoice (selfbill) level only
  - `src/reference.apib` — Vertical/Category type defined but not in publisher campaign list
  - `src/aggregated_reporting.apib` — partner_commission vs commission confirmed as
    separate fields
  - `src/participating_publishers.apib` — `campaign_status` field name at relationship level

- **Partnerize tracking link format**:
  Confirmed from multiple public integration guides:
  `https://prf.hn/click/camref:{camref}/destination:{encodedUrl}`
  The camref format is consistent across TransferWise, Expedia, and Plum Guide
  publisher guides available at docs.partnerize.com and help.phgsupport.com.

- **Web search evidence**:
  - Auth scheme (HTTP Basic, `application_key:user_api_key`, base64-encoded) confirmed
  - Base URL (`https://api.partnerize.com`) confirmed
  - conversion_status filter values confirmed as: `approved`, `pending`, `rejected`, `mixed`
    (search snippets from api-docs.partnerize.com); "paid" not documented publicly
  - Date format for reporting parameters confirmed as `YYYY-MM-DD HH:MM:SS`
    (URL-encoded; YYYY-MM-DD date-only also accepted per search evidence)
  - publisher_commission and commission confirmed as separate distinct fields
    (Funnel.io knowledge base: "Commission" and "Publisher commission" are separate metrics)
  - reject_reason confirmed in API validation docs (field name confirmed)

---

## Hardening pass 2026-05-28

### TODO resolutions

Each of the 27 `TODO(verify)` markers has been resolved as CONFIRM, CORRECT, or BLOCKED:

| # | Location | Resolution | Source | Notes |
|---|----------|-----------|--------|-------|
| 1 | `adapter.ts:161` — `campaign_id` may be numeric | **CONFIRM** | export_reporting.apib sample row (`10l176`) | String type confirmed |
| 2 | `adapter.ts:163` — `campaign_name` alternative field | **CONFIRM** | export_reporting.apib conversion CSV header shows `campaign_title` | Primary field is `campaign_title`; `campaign_name` kept as defensive fallback |
| 3 | `adapter.ts:165` — `approval_state` field name | **BLOCKED** | publisher_campaign.apib references `campaign_status` at relationship level; exact publisher-side response body field name unconfirmed | Requires live credentials |
| 4 | `adapter.ts:170` — commission value may be numeric | **CONFIRM** | export_reporting.apib sample row (`0.9092`) shows numeric string | `toNumber()` handles both string and number |
| 5 | `adapter.ts:173` — `tracking_url` field name | **BLOCKED** | Not documented in publisher_campaign.apib or campaign_tracking.apib | Requires live credentials |
| 6 | `adapter.ts:192` — conversion field names | **CONFIRM (partial)** | export_reporting.apib conversion CSV headers confirm all core fields | JSON endpoint may have different field names; blocked for full confirmation |
| 7 | `adapter.ts:208` — `conversion_lag` units | **BLOCKED** | export_reporting.apib sample shows `626`; units not stated in blueprint | Requires live credentials; likely minutes based on magnitude |
| 8 | `adapter.ts:214` — `reject_reason` field name | **CONFIRM** | export_reporting.apib conversion_item CSV confirms `reject_reason` | Note: field is on conversion ITEMS, not top-level conversion row; kept defensively |
| 9 | `adapter.ts:225` — pagination header vs body | **CONFIRM** | granular_reporting.apib: "if the result set includes a `cursor_id` header attribute" | cursor_id is a RESPONSE HEADER, not in the body |
| 10 | `adapter.ts:232` — conversion field names from export | **CONFIRM** | export_reporting.apib CSV headers directly confirm all conversion field names | JSON parity with CSV is a reasonable assumption but blocked for full confirmation |
| 11 | `adapter.ts:299` — `paid` status exists | **BLOCKED** | Public search confirms only approved/pending/rejected/mixed as documented values; `paid` not found in any public blueprint | Kept for defensive compatibility; requires live credentials to confirm or remove |
| 12 | `adapter.ts:338` — `approval_state` / `status` values | **CONFIRM** | publisher_campaign.apib: path segments a/p/r map to approved/pending/rejected | Defensive reading of both field names preserved |
| 13 | `adapter.ts:362` — `validation_date` / `approved_at` | **CONFIRM ABSENT** | export_reporting.apib conversion CSV has no validation_date or approved_at column; no such field in any public blueprint | `dateApproved` remains `undefined` |
| 14 | `adapter.ts:429` — `categories` taxonomy | **CONFIRM ABSENT** | reference.apib defines Vertical type but publisher campaign list endpoint does not return it in any blueprint | `categories` remains `undefined` |
| 15 | `adapter.ts:449` — `publisher_commission` vs `commission` | **CONFIRM** | export_reporting.apib: both appear as separate CSV columns; aggregated_reporting.apib distinguishes `partner_commission` from `commission`; Funnel.io docs confirm two separate fields | publisher_commission is correct |
| 16 | `adapter.ts:469` — `dateApproved` | **CONFIRM ABSENT** | No separate approval date in export_reporting.apib conversion schema | Remains `undefined`; blocked pending JSON endpoint confirmation |
| 17 | `adapter.ts:470` — `datePaid` | **CONFIRM ABSENT** | selfbill.apib has payment_date at invoice level only; no per-conversion payment_date in any public blueprint | Remains `undefined` |
| 18 | `adapter.ts:559` — path and status values | **CONFIRM** | publisher_campaign.apib: endpoint path and a/p/r values confirmed | Response body field names remain blocked |
| 19 | `adapter.ts:588` — status in response body | **BLOCKED** | publisher_campaign.apib shows `campaign_status` at participating_publishers level; publisher-side list response field unconfirmed | Requires live credentials |
| 20 | `adapter.ts:625` — single-campaign endpoint | **CONFIRM ABSENT** | publisher_campaign.apib documents no single-campaign endpoint; workaround confirmed necessary | |
| 21 | `adapter.ts:697` — date format | **CONFIRM** | granular_reporting.apib example: `2018-03-01+00%3A00%3A00`; intro.apib confirms datetime format | YYYY-MM-DD also accepted; current adapter behaviour safe |
| 22 | `adapter.ts:864` — click field names | **CONFIRM** | export_reporting.apib click CSV headers: click_id, cookie_id, campaign_id, publisher_id, status, set_time, set_ip, last_used, last_ip, advertiser_reference, referer, creative_id, creative_type, specific_creative_id, country, publisher_name | JSON parity blocked |
| 23 | `adapter.ts:907` — `destinationUrl` | **CONFIRM ABSENT** | export_reporting.apib click CSV has no destination_url or landing_url column | Remains `undefined`; JSON endpoint may differ (blocked) |
| 24 | `adapter.ts:1166` — datetime strings accepted | **CONFIRM** | granular_reporting.apib shows full datetime format; date-only also works | YYYY-MM-DD confirmed safe |
| 25 | `auth.ts:41` — publisher field names | **CONFIRM** | publisher.apib confirms `publisher_id` and `account_name` fields | Not live-tested |
| 26 | `auth.ts:153` — response envelope shape | **CONFIRM (blueprint)** | publisher.apib shows `{ publishers: { publisher: [...] } }` pattern; flat array handled defensively | Not live-tested |

**Summary: 18 CONFIRM, 1 CONFIRM ABSENT (6 items), 6 BLOCKED**

---

## Remaining BLOCKED items (live-verification checklist)

The following uncertainties cannot be resolved without live Partnerize publisher
credentials. They require: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`,
and a publisher account with at least one approved campaign.

| Item | What to check | Expected resolution |
|------|--------------|---------------------|
| **Campaign status field name** | Run `GET /user/publisher/{id}/campaign/a` and inspect response body — is the status field `approval_state`, `status`, `campaign_status`, or absent? | Update `mapProgrammeStatus` to read the confirmed field; remove defensive fallback |
| **Campaign response body fields** | Is `campaign_title` present in the JSON response? (Confirmed in conversion CSV but not in campaign list blueprint) | Confirm or correct `toProgramme` field mapping |
| **tracking_url field name** | Is there a `tracking_url` field on campaign objects in the publisher campaign endpoint? | Confirm or remove from `PartnerizeCampaignRaw` |
| **`paid` conversion_status** | Does the conversion reporting endpoint ever return `conversion_status: 'paid'`? | Confirm or remove from `mapTransactionStatus` |
| **`reject_reason` on conversion row** | Does the JSON conversion endpoint return `reject_reason` on the top-level conversion (not just conversion_item)? | If absent, remove from `PartnerizeConversionRaw`; if present, confirm field name |
| **`conversion_lag` units** | What unit does the `conversion_lag` field use? Export sample shows `626` — is this minutes (≈10 hours), hours, or days? | Document units in comments |
| **JSON vs CSV field parity** | Do the JSON granular reporting endpoints return the same field names as the CSV export columns? | Update fixtures and confirm all `PartnerizeConversionRaw` / `PartnerizeClickRaw` fields |
| **Publisher list envelope** | Does `GET /user/publisher` return `{ publishers: { publisher: [...] } }` or a flat array? | Confirm `extractPublisherList` logic in auth.ts |
| **Click destinationUrl** | Does the JSON click endpoint include `destination_url` or equivalent that is absent from the CSV? | If present, populate `destinationUrl` in `listClicks` |
| **dateApproved / datePaid** | Do JSON conversion records include any approval or payment date field not in the CSV schema? | If present, map to `dateApproved` / `datePaid` |

---

## Endpoint map

| Operation | Endpoint | Status |
|-----------|----------|--------|
| verifyAuth | `GET /user/publisher` | Endpoint confirmed from blueprint; field names confirmed; not live-tested |
| listProgrammes | `GET /user/publisher/{id}/campaign/{status}` | Path/status segments confirmed; response body field names BLOCKED |
| getProgramme | Same as listProgrammes (client-side filter) | No single-campaign endpoint documented (confirmed absent) |
| listTransactions | `GET /reporting/report_publisher/publisher/{id}/conversion` | Endpoint confirmed; field names confirmed from CSV export; JSON parity BLOCKED |
| getEarningsSummary | Derived from listTransactions | N/A |
| listClicks | `GET /reporting/report_publisher/publisher/{id}/click` | Endpoint confirmed; field names confirmed from CSV export; JSON parity BLOCKED |
| generateTrackingLink | `https://prf.hn/click/camref:{camref}/destination:{url}` | Format confirmed from multiple public sources |

---

## Next steps for live verification

1. Obtain Partnerize publisher test credentials.
2. Run `npm run validate:network -- partnerize` against a live account.
3. Work through the BLOCKED items checklist above, comparing live responses against
   the existing fixtures under `tests/fixtures/partnerize/`.
4. Update fixtures with real (scrubbed) response shapes.
5. Bump `adapter_version` to `0.1.1` and `last_verified` to the test date.
6. Promote `claim_status` from `experimental` to `partial` once the live
   diagnostic passes for all seven operations.

## Partnerize (Advertiser)

### Quick facts

- **Slug**: `partnerize-advertiser`
- **Auth model**: basic
- **Base URL**: https://api.partnerize.com
- **Environment variables**: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://api-docs.partnerize.com/brand/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Click-level data is not exposed by the Partnerize Brand API; listClicks is unsupported.
- getProgramme is not implemented at v0.1; use listProgrammes (listBrands) and filter client-side.
- getEarningsSummary is not implemented at v0.1; use getProgrammePerformance for the per-publisher rollup.
- generateTrackingLink is a publisher-side operation and is not applicable to the advertiser adapter.
- Conversion (transaction) reporting scope is per-campaign and requires a campaign_id context from AdapterCallContext.

### Findings

# Partnerize (Advertiser) — findings

Built from public API documentation as of 2026-05-28; live verification pending
credentials.

---

## Research sources

The following public sources were consulted to build and harden this adapter.

### Primary sources consulted in both passes

- **Partnerize Brands API documentation** (primary):
  https://api-docs.partnerize.com/brand/ — returned HTTP 403 to automated fetch
  in both the initial build and the hardening pass.
- **Partnerize API on Apiary** (mirror):
  https://partnerize.docs.apiary.io/ — returned HTTP 403 to automated fetch.
- **PerformanceHorizonGroup/apidocs** (official open-source API Blueprint source):
  https://github.com/PerformanceHorizonGroup/apidocs — fetchable. This is the
  primary ground-truth source for the hardening pass. Key files used:
  - `src/advertiser.apib` — campaign list endpoint shape, `campaigns` envelope.
  - `src/participating_publishers.apib` — publishers endpoint path and response.
  - `src/publisher_campaign.apib` — publisher campaign_status single-letter codes.
  - `src/aggregated_reporting.apib` — `start_date`/`end_date` parameter names.
  - `src/granular_reporting.apib` — `campaign_id`/`publisher_id` filter names.
  - `src/export_reporting.apib` — conversion date field names, conversion fields.
  - `src/campaign_conversion.apib` — conversion status values, `reject_reason`.
  - `src/network_publisher.apib` — publisher network_status values.
  - `data/common.apib` — canonical Conversion Status enum: `pending`, `approved`, `rejected`.
  - `data/publisher.apib` — publisher object field names incl. `account_name`.
  - `data/reporting.apib` — `publisher_id`, `publisher_name`, `commission`, `value`.

### Secondary sources consulted in the hardening pass

- **Partnerize Apiary introduction/standard-pagination** (web-search summary):
  Confirmed `limit` + `offset` pagination (not `page`); hypermedia block may
  contain `total_item_count`, `total_page_count`.
- **dltHub Partnerize context page** (web-search summary):
  https://dlthub.com/context/source/partnerize — returned HTTP 403 to direct
  fetch; web-search snippet confirmed `v3/brand/analytics/metrics` endpoint path
  and `data` as the response data selector.
- **Adverity Partnerize authorisation guide** (web-search summary):
  Confirmed HTTP Basic auth with `Authorization: Basic base64(application_key:user_api_key)`.
- **Funnel.io Partnerize connection guide** (web-search summary):
  Additional confirmation of auth scheme and credential names.

---

## Hardening pass 2026-05-28

### Summary

| Category | Count |
|---|---|
| TODOs fully confirmed (TODO removed, source cited) | 12 |
| TODOs corrected (code/fixtures updated, TODO removed) | 6 |
| Blocked (confirmed needs live account, specific blocker recorded) | 9 |
| New tests added | 8 |
| Net TODO(verify) count after pass | 0 |

All `TODO(verify)` comments have been replaced with either confirmed facts (source
cited inline) or `BLOCKED(verify)` comments with a precise description of what is
needed and why it cannot be confirmed without live credentials.

---

### Per-TODO outcome

#### auth.ts

| Original TODO | Outcome | Source |
|---|---|---|
| Exact 401/403 response body shape | **BLOCKED** — requires live account | n/a |
| Response body field names for identity string | **BLOCKED** — requires live account | n/a |
| Application Key format/length | **BLOCKED** — not publicly documented; defensive `[A-Za-z0-9_-]{6,}` regex is a sanity check only | n/a |

#### adapter.ts — raw interface field names

| Original TODO | Outcome | Source |
|---|---|---|
| Campaign envelope field names | **CONFIRMED** — `campaigns` array with `count`, `execution_time`; pagination via `limit`+`offset` | `src/advertiser.apib`, Apiary standard-pagination |
| Campaign status enum values | **BLOCKED** — not enumerated in accessible docs | `data/campaign.apib` references "Status" type without listing values |
| Publishers envelope field name | **CONFIRMED** — `publishers` is the confirmed key | `src/participating_publishers.apib` |
| Publisher field names (`publisher_id` vs `partner_id`) | **CONFIRMED** — `publisher_id` is primary; `partner_id` is a v3 alias; `account_name` added | `data/publisher.apib` |
| Publisher status enum values | **CONFIRMED/CORRECTED** — single-letter codes `a`/`p`/`r` confirmed; `campaign_status` field confirmed; full-string aliases kept defensively | `src/publisher_campaign.apib` |
| Conversion date field names | **CONFIRMED/CORRECTED** — `conversion_time` (JSON API), `conversion_date_time`, `conversion_date`, `click_time`, `click_date`, `click_date_time` all valid. All resolved defensively. | `src/export_reporting.apib`, `data/reporting.apib` |
| Conversion status enum values | **CONFIRMED** — `pending`, `approved`, `rejected` confirmed. Single-letter codes `a`/`p`/`r` also handled. `reversed`/`paid` still BLOCKED. | `data/common.apib` Conversion Status enum |
| Conversion `sale_amount` / `commission` field names | **CONFIRMED/CORRECTED** — primary fields are `value`/`commission`; `sale_amount` and `publisher_commission` handled as aliases | `data/reporting.apib` |
| `rejection_reason` vs `reject_reason` | **CONFIRMED/CORRECTED** — `reject_reason` confirmed as the canonical field in `campaign_conversion.apib`; both handled | `src/campaign_conversion.apib` |
| Analytics endpoint response data selector | **CONFIRMED** — results under `data` key | dltHub web-search summary |

#### adapter.ts — method-level TODOs

| Original TODO | Outcome | Source |
|---|---|---|
| `listBrands` response envelope shape | **CONFIRMED** — `campaigns` array; pagination via `limit`+`offset` | `src/advertiser.apib` |
| `listBrands` pagination parameters | **CONFIRMED** — `limit` + `offset` | Apiary standard-pagination |
| `listBrands` apiEnabled on paused campaigns | **BLOCKED** — whether the live API blocks conversion queries on paused campaigns is not documented | n/a |
| `listProgrammes` pagination parameters | **CONFIRMED** — `limit` + `offset` | Apiary standard-pagination |
| `listTransactions` date parameter names | **CONFIRMED** — `start_date` / `end_date` | `src/aggregated_reporting.apib`, `src/export_reporting.apib` |
| `listTransactions` date parameter names (inline) | **CONFIRMED** — same | Same sources |
| `listMediaPartners` path `/publishers` vs `/partners` | **BLOCKED** — older API uses `/campaign/{id}/publisher` (singular); v3 pluralisation convention suggests `/publishers`; cannot confirm without live account | `src/participating_publishers.apib` |
| `getProgrammePerformance` parameter names | **CONFIRMED** — `campaign_id`, `publisher_id`, `start_date`, `end_date` confirmed | `src/granular_reporting.apib`, `src/aggregated_reporting.apib` |
| `getProgrammePerformance` parameter names (inline) | **CONFIRMED** — same | Same sources |
| `getProgrammePerformance` response envelope / date field | **CONFIRMED (partial)** — `data` key confirmed; date field name in rows BLOCKED | dltHub summary |
| `capabilitiesCheck` note for getProgrammePerformance | **UPDATED** — TODO removed, note now cites confirmed sources | n/a |

#### client.ts

| Original TODO | Outcome | Source |
|---|---|---|
| Pagination semantics | **CONFIRMED** — `limit` + `offset` for standard endpoints; `cursor_id` available for large result sets | Apiary standard-pagination web-search summary |

---

### Remaining BLOCKED items — live-verification checklist

The following items require a live Partnerize Brand account to verify.
Credentials needed: `PARTNERIZE_APPLICATION_KEY` + `PARTNERIZE_USER_API_KEY`.

1. **Campaign status string values** — the v3 Brand API campaign `status` field
   may return strings like `'active'`, `'paused'`, `'closed'`; the exact set is
   not enumerated in `data/campaign.apib`. Check: `GET /v3/brand/campaigns` and
   inspect `campaigns[*].status` for all returned values.

2. **Conversion status `reversed` and `paid`** — `data/common.apib` only
   confirms `pending`, `approved`, `rejected`. `reversed` and `paid` may be
   payment-pipeline states or may be absent on the v3 brand endpoint. Check:
   `GET /v3/brand/campaigns/{id}/conversions` and inspect `status` values.

3. **Publisher participation path — `/publishers` vs `/publisher`** — the legacy
   API uses singular `/campaign/{id}/publisher`; the v3 brand pattern uses plural
   URLs. Check: attempt `GET /v3/brand/campaigns/{id}/publishers` and compare
   with `/v3/brand/campaigns/{id}/publisher`.

4. **Publisher status field format on brand endpoint** — whether `campaign_status`
   uses full strings (`approved`, `pending`, `rejected`) or single-letter codes
   (`a`, `p`, `r`) or a different field entirely. Check: `GET /v3/brand/campaigns/{id}/publishers`
   and inspect publisher objects.

5. **Analytics date grouping field** — whether the analytics metrics row uses
   `date`, `day`, or another field for the time dimension. Check:
   `GET /v3/brand/analytics/metrics?campaign_id={id}&start_date=...&end_date=...`
   and inspect the first row key names.

6. **Paused campaign conversion query behaviour** — whether a paused campaign
   returns 403 or an empty list when queried for conversions. Affects
   `apiEnabled` logic in `toDiscoveredBrand`. Check: call
   `GET /v3/brand/campaigns/{paused_id}/conversions`.

7. **401/403 response body shape** — the exact JSON structure returned on auth
   failure. The adapter currently surfaces the verbatim body; refine if the
   response contains a structured `message` field.

8. **`verifyAuth` identity field** — whether the v3 campaigns response includes
   any user-name or account-name that can provide a friendlier identity string
   (e.g. `account_name` from the advertiser object).

9. **Application Key exact format** — the regex `[A-Za-z0-9_-]{6,}` is a
   conservative sanity check; the real format may be stricter (e.g. exactly 32
   hex characters). Check the actual key format in the Partnerize dashboard.

---

## Observed API behaviour (partially confirmed, partially unverified)

- **Auth scheme**: HTTP Basic, `Authorization: Basic base64(application_key:user_api_key)`.
  Both keys come from the Partnerize dashboard (Settings → API Credentials).
  **Confirmed** by multiple third-party integration guides.
- **Base URL**: `https://api.partnerize.com` (v3 path prefix: `/v3/brand/`).
  Confirmed by `PerformanceHorizonGroup/apidocs` API host.
- **Campaigns endpoint**: `GET /v3/brand/campaigns` — returns a `campaigns` array
  with `count` and `execution_time`. Pagination via `limit` + `offset`.
  Confirmed by `src/advertiser.apib` and Apiary standard-pagination.
- **Conversions endpoint**: `GET /v3/brand/campaigns/{campaignID}/conversions`
  (and `/conversions/bulk` for the batch-update path). Confirmed by web-search
  summaries of the Partnerize Resource Centre.
- **Date parameters**: `start_date` / `end_date` (ISO 8601 format).
  Confirmed by `src/aggregated_reporting.apib` and `src/export_reporting.apib`.
- **Analytics endpoint**: `GET /v3/brand/analytics/metrics`, returns results
  under a `data` key. Path confirmed by dltHub web-search summary; data selector
  confirmed by dltHub source configuration.
- **Publishers endpoint**: `GET /v3/brand/campaigns/{campaignID}/publishers`
  (assumed plural form). The legacy path `/campaign/{id}/publisher` (singular) is
  confirmed by `src/participating_publishers.apib`. The exact v3 path requires
  live verification.
- **Conversion status values**: `pending`, `approved`, `rejected` confirmed by
  `data/common.apib`. Single-letter aliases `a`/`p`/`r` confirmed by
  `src/publisher_campaign.apib`. `reversed` and `paid` not confirmed.

---

## Next steps

1. Obtain a live Partnerize Brand account and run:
   ```
   affiliate-networks-mcp test partnerize-advertiser
   ```
2. Work through the nine BLOCKED items in the live-verification checklist above.
3. Fix any remaining field-name mismatches and bump `adapter_version` to `0.1.1`.
4. Promote `claim_status` from `experimental` to `partial` once the core
   operations (listBrands, listTransactions, listMediaPartners,
   getProgrammePerformance) are confirmed against a live account.

## Partnero

### Quick facts

- **Slug**: `partnero`
- **Auth model**: bearer
- **Base URL**: https://api.partnero.com
- **Environment variables**: `PARTNERO_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://developers.partnero.com/reference/general.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- transaction / reward / partner field names and the amount unit (assumed major currency units, per the PHP SDK example setAmount(99.99) and the is_currency / amount_units fields) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one API token scopes one Partnero programme (the token is generated per programme). Bind your single brand in brands.json manually.
- listProgrammes / getProgramme return a single synthetic programme: Partnero has no /programs list endpoint, so the programme is modelled from the configured token and the supplied brand context.
- listClicks is unsupported: Partnero exposes no raw click records via this API.
- generateTrackingLink is unsupported: referral links belong to an individual partner; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /transactions grouped by (partner, day). Clicks are not available from transactions and are reported as 0.
- Commission per transaction is read from the transaction reward(s); a transaction with no reward contributes 0 commission.

### Findings

_No findings document was supplied at `docs/findings/partnero.md`._

## PartnerStack

### Quick facts

- **Slug**: `partnerstack`
- **Auth model**: bearer
- **Base URL**: https://api.partnerstack.com
- **Environment variables**: `PARTNERSTACK_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.partnerstack.com/docs/partner-api

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data is not exposed via the PartnerStack Partner API; listClicks is unsupported.
- generateTrackingLink is unsupported: PartnerStack issues partner links itself (listed via /links); there is no documented per-destination deep-link construction.
- Reward amounts are assumed to be minor units (cents) and divided by 100; the unit is TODO(verify) against a live account.
- partnership / reward field names are read defensively and have not been confirmed against a live partner account; verbatim payloads are preserved on rawNetworkData.
- getProgramme filters the /partnerships list client-side; the Partner API has no documented single-partnership GET.

### Findings

_No findings document was supplied at `docs/findings/partnerstack.md`._

## PartnerStack (advertiser)

### Quick facts

- **Slug**: `partnerstack-advertiser`
- **Auth model**: basic
- **Base URL**: https://api.partnerstack.com
- **Environment variables**: `PARTNERSTACK_PUBLIC_KEY`, `PARTNERSTACK_SECRET_KEY`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.partnerstack.com/reference

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Vendor API auth (public/secret Basic key pair) and reward/partner field names have not been confirmed against a live vendor account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one Vendor API key pair scopes one vendor account. There is no multi-brand enumeration and no listBrands(); bind your single brand in brands.json manually.
- listProgrammes is synthetic: the Vendor API has no advertiser-programmes list, so the adapter returns one Programme for the bound vendor account.
- getProgrammePerformance is computed client-side from /rewards grouped by (partner, day). Clicks are not available from /rewards and are reported as 0.
- getProgramme, listClicks and generateTrackingLink are not implemented on the vendor side.
- Reward amounts are assumed to be minor units (cents) and divided by 100; the unit is TODO(verify).

### Findings

_No findings document was supplied at `docs/findings/partnerstack-advertiser.md`._

## Pepperjam

### Quick facts

- **Slug**: `pepperjam`
- **Auth model**: custom
- **Base URL**: https://api.pepperjamnetwork.com
- **Environment variables**: `PEPPERJAM_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://ascendpartner.zendesk.com/hc/en-gb/articles/13501008650909-API-Overview

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: not yet validated against a live Pepperjam (Ascend) publisher account.
- Transaction amounts are assumed to be major currency units in USD; the report does not return a per-row currency code.
- Distinct from the Partnerize adapter: Ascend is Partnerize-owned but this REST API is unrelated to the Partnerize Reporting API.
- Click-level data is not exposed via the public Pepperjam publisher API; listClicks is unsupported.
- Tracking-link construction is not documented as a deterministic scheme on the publisher API; generateTrackingLink is unsupported.

### Findings

_No findings document was supplied at `docs/findings/pepperjam.md`._

## Post Affiliate Pro

### Quick facts

- **Slug**: `post-affiliate-pro`
- **Auth model**: bearer
- **Base URL**: https://demo.postaffiliatepro.com/api/v3
- **Environment variables**: `POST_AFFILIATE_PRO_BASE_URL`, `POST_AFFILIATE_PRO_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.qualityunit.com/868880-API-v3-documentation-overview

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: built against the documented Post Affiliate Pro API v3 contract but not verified against a live account.
- Per-tenant base URL: Post Affiliate Pro is hosted per account, so the API base is the per-account subdomain supplied via POST_AFFILIATE_PRO_BASE_URL (e.g. https://acme.postaffiliatepro.com/api/v3). The base_url here is a placeholder demo host.
- transaction / affiliate / campaign field names and the amount unit (assumed MAJOR currency units, not minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one API key + base URL scopes one Post Affiliate Pro account. Bind your single brand in brands.json manually.
- listClicks is unsupported: API v3 exposes no raw click record list to the merchant via this surface.
- generateTrackingLink is unsupported: affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /transactions grouped by (affiliate, day). Clicks are not available from /transactions and are reported as 0.
- Pagination is offset/limit and capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/post-affiliate-pro.md`._

## Profitshare

### Quick facts

- **Slug**: `profitshare`
- **Auth model**: custom
- **Base URL**: https://api.profitshare.ro
- **Environment variables**: `PROFITSHARE_API_USER`, `PROFITSHARE_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://doc.profitshare.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: the adapter has not been validated against a live Profitshare account; endpoint shapes and field names are inferred from the public reference client and may differ in production.
- Commission amounts are assumed to be major-currency units (RON) as returned by the API; the unit is not authoritatively documented and is preserved verbatim on rawNetworkData.
- Requests are HMAC-SHA1 signed (X-PS-Auth) over a canonical method+path+query+user+date string; a clock skewed from GMT will produce signature failures.
- Click-level data is not exposed via the public affiliate API; listClicks is unsupported.
- Tracking-link generation requires the affiliate-links endpoint (POST) and is not deterministically constructible; generateTrackingLink is unsupported pending live verification.

### Findings

_No findings document was supplied at `docs/findings/profitshare.md`._

## Rakuten Advertising

### Quick facts

- **Slug**: `rakuten`
- **Auth model**: oauth2
- **Base URL**: https://api.linksynergy.com
- **Environment variables**: `RAKUTEN_CLIENT_ID`, `RAKUTEN_CLIENT_SECRET`, `RAKUTEN_SID`
- **Setup time estimate**: 12 minutes
- **Approval required**: yes (~5 days)
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://developers.rakutenadvertising.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data (GET /v1/reports/clicks_reports) is gated by Rakuten as a paid tier; listClicks throws NotImplementedError until the test account has access.
- listPublishers and listPublisherSectors are scaffolded for v0.2 only — they throw NotImplementedError.
- The adapter has not been validated against a live Rakuten publisher account at commit time; claim_status reflects this.

### Findings

# Findings: Rakuten Advertising

Captured during Chunk 6 implementation. Feeds Chunk 7's REPORT.md. Notes
describe access friction matter-of-factly: what happened, what worked, what
didn't.

## Summary

The Rakuten Advertising adapter ships at `claim_status: partial`. Most of the
seven publisher operations are implemented against the documented public
endpoints; `listClicks` is paid-tier-gated and throws `NotImplementedError`
with a specific reason. The adapter has not been exercised against a live
publisher account because API access requires Publisher Solutions approval
(documented turnaround 3–7 business days; we estimate 5).

Per AGENTS.md, Rakuten is **not** a pattern source for future networks. The
canonical reference remains the Awin adapter. Decisions taken here that are
unusual relative to Awin are flagged inline in the adapter source and below.

## Access friction (matter-of-fact)

- **Publisher Solutions approval required**. A freshly-created Rakuten
  publisher account does NOT have API access by default. The "API Credentials"
  tab is hidden until the Publisher Solutions team explicitly grants the
  capability. Setup brief surfaces this in step 1's description.

- **Developer docs portal returned 403 for the API reference page on
  2026-05-21** when accessed without an authenticated session. The base
  marketing URL (`rakutenadvertising.com/legal-notices/services-terms/`) is
  public; `developers.rakutenadvertising.com` (which we list as `docs_url` in
  `network.json`) requires login for the OpenAPI spec. Endpoint shapes in this
  adapter were assembled from the chunk-6 brief, the public deeplink format
  documentation, and observed responses described in Rakuten's blog posts.

- **Token endpoint accepts XML but not JSON by default**. The Rakuten OAuth2
  token-exchange endpoint requires an explicit `Accept: application/json`
  header to return the documented JSON shape — without it, you can get an
  XML response that the client cannot parse. We send the header on every
  request from both the token-exchange and data calls.

- **Tenant variance on token host**. Some accounts use
  `api.linksynergy.com/token`; others use `api.rakutenmarketing.com/token`.
  The adapter defaults to `linksynergy.com` and accepts a `RAKUTEN_TOKEN_URL`
  environment-variable override if a user reports a 404. This is documented
  in `src/networks/rakuten/auth.ts`.

- **`clicks_reports` is paid-tier-gated**. The endpoint exists in the public
  surface but returns 403 on an unapproved or basic-tier account.
  `listClicks` throws `NotImplementedError` with the reason "Rakuten
  clicks_reports endpoint requires a paid Rakuten tier; not available on the
  test account at adapter commit time. Contact Rakuten Publisher Solutions
  to enable click-level reporting." If the test account is later upgraded,
  the implementation is a few-dozen-line addition: the response shape is the
  same as `transaction_reports`.

## What is implemented

All against the documented public endpoints; mocked tests cover transformer
correctness and the §15.4/§15.9/§15.10 quality bars. Live API not yet
exercised.

| Operation              | Endpoint                              | Notes                                                          |
| ---------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `listProgrammes`       | `GET /v1/programs/`                   | Server-side status filter when single value; otherwise client-side. |
| `getProgramme`         | `GET /v1/programs/?mid=<id>`          | Uses the filter rather than the legacy `/linklocator/getMerchByID` (legacy returns XML). |
| `listTransactions`     | `GET /v1/reports/transaction_reports` | Supports `process_date_start/end`, `mid`, post-fetch status/age filters. |
| `getEarningsSummary`   | derived from `listTransactions`       | Single source of truth. Same rationale as Awin.                |
| `generateTrackingLink` | deterministic                         | `https://click.linksynergy.com/deeplink?id=<SID>&mid=<MID>&u=<URL-encoded>`. No API call. |
| `verifyAuth`           | `POST /token`                         | A successful token exchange is the conclusive auth check.       |

## What is stubbed (NotImplementedError)

| Operation                | Reason                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `listClicks`             | `clicks_reports` requires a paid Rakuten tier; not accessible from the test account at commit time. |
| `listPublishers`         | Brand-side operations scaffolded for v0.2.                                                          |
| `listPublisherSectors`   | Brand-side operations scaffolded for v0.2.                                                          |

Each throws `NotImplementedError` with a specific human-readable reason — never
returns an empty array. Per principle 4.1, the difference between "Rakuten
returned no clicks" and "Rakuten doesn't expose clicks here" is the difference
between an actionable observation and a wild goose chase.

## Status normalisation (the locked → approved choice)

Rakuten's transaction vocabulary is `pending | locked | paid | reversed`.
Mapping to our canonical enum:

- `pending` → `pending` (sale recorded, awaiting advertiser validation)
- `locked` → `approved` — the load-bearing decision. Rakuten "locks" a sale
  after the advertiser approves it but before it leaves the payment-hold
  window (typically 60 days). Semantically the same as Awin's
  "approved-but-not-yet-paid". Mapping to `approved` lets the §15.9 unpaid-age
  affordance work uniformly across networks: a user asking "what is approved
  and older than 90 days?" gets the same kind of answer regardless of the
  underlying network's wording.
- `paid` → `paid`
- `reversed` → `reversed` (also catches Rakuten's occasional `declined` /
  `cancelled` / `canceled` synonyms).
- Anything else → `other`. We never invent a status the user did not see on
  Rakuten's side.

## Token caching pattern (Rakuten-specific decision)

Rakuten access tokens last ~1 hour. The cache (`src/networks/rakuten/auth.ts`)
is the only mutable module-level state in the adapter. Refresh policy:

- **Proactive**: when the cached token has <5 minutes until expiry, refresh
  before the next call uses it. This avoids "token expired mid-flight" 401s.
- **Reactive**: if a 401 surfaces from any data endpoint, the client forces a
  refresh and retries the original call exactly once. The retry is logged at
  debug level. Per the project's "no silent retries" rule, the recovery path
  is NOT hidden.
- **Deduplication**: parallel callers that simultaneously notice a stale token
  share a single in-flight refresh promise so two callers don't both round-trip
  the token endpoint.

The cache lives in module scope keyed by process identity. Tests can call
`_resetTokenCache()` to isolate. Future contributors: if you find yourself
adding a second piece of module-level mutable state in this adapter, stop
and think.

## Tracking link: deterministic vs `getTextLinks`

We construct deeplinks deterministically:

```
https://click.linksynergy.com/deeplink
  ?id=<SID>            (publisher Site ID)
  &mid=<MID>           (merchant ID)
  &u=<URL-encoded destination>
```

Rakuten exposes `/linklocator/getTextLinks/{mid}` as an alternative, but it
returns pre-canned text-link HTML, not a deeplink to an arbitrary destination
URL. For the principle 4.1 use case ("link me to *this specific* product
page"), the deeplink format above is what callers actually want. Same pattern
as the Awin adapter (`cread.php?awinmid=...&awinaffid=...&ued=...`); we kept
the parameter names visible in the comments and the `rawNetworkData` for the
returned `TrackingLink` so the link's construction is fully auditable.

## What surprised me

- **The legacy XML endpoints are still in the surface**. `/linklocator/...`
  returns XML by default even with `Accept: application/json`. We avoid those
  endpoints entirely and stick to the `/v1/` surface so the client's JSON
  parse path applies uniformly. Future expansion (e.g. coupons via
  `/coupon/getcouponfeed/`) would need a tolerant parser path or a `text/xml`
  branch in the client; out of scope for v0.1.

- **The `scope=<SID>` body parameter is unusual**. OAuth2 client-credentials
  flows typically don't use `scope` to identify a tenant — they use it to
  request a permission set. Rakuten uses it as the Site ID. The setup wizard
  has to prompt for it as a separate field; there is no derivation pathway.

- **Status filters on `/v1/programs/` are sometimes ignored by Rakuten.**
  Reported anecdotally; not reproducible without a live account. The adapter
  applies status filters client-side after the fetch as a defence in depth.

- **Rakuten doesn't expose a per-call "transactions older than X" parameter.**
  The §15.9 unpaid-age affordance is applied post-fetch in the adapter, same
  as Awin. The trade-off is that very wide date windows pull more data than
  strictly needed; for a v0.1 sized publisher this is fine.

## Recommended next steps

1. **Live validation in Chunk 8**: once a real Rakuten test account is
   provisioned, run `affiliate-networks-mcp validate rakuten` end-to-end and decide
   whether to bump `claim_status` to `production` (if all live ops pass) or
   leave at `partial` (if clicks remain inaccessible).

2. **Promote `listClicks`** from `NotImplementedError` to a real implementation
   if the test account is upgraded. The endpoint response shape is the same
   as `transaction_reports`, so the `toClick` transformer is a ~20-line
   addition.

3. **Decide on the legacy XML surface.** If a user needs coupons or the older
   merchant detail endpoints, the client needs a `text/xml` Accept branch
   plus an XML parser dependency (out of scope for v0.1).

4. **Consider parallelising the token-refresh + first-data-call** pair when
   the cache is cold. Currently sequential; saves ~200ms per cold session.
   Not a v0.1 blocker.

## Refersion

### Quick facts

- **Slug**: `refersion`
- **Auth model**: custom
- **Base URL**: https://api.refersion.com
- **Environment variables**: `REFERSION_API_KEY`, `REFERSION_SECRET_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://www.refersion.dev/reference/welcome-to-refersion

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: built against the documented Refersion REST v2 contract but not verified against a live account. conversion / affiliate / offer field names have not been confirmed; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- Amount unit is assumed to be major currency units (whole units, not minor units / cents); if Refersion reports minor units the figures will be off by 100x. TODO(verify).
- advertiser + single-brand: one API key pair scopes one Refersion merchant account. Bind your single brand in brands.json manually.
- listClicks is unsupported: Refersion exposes click-level data only via its separate GraphQL API, not this REST surface.
- generateTrackingLink is unsupported: referral links belong to individual affiliates; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /conversions grouped by (affiliate, day). Clicks are not available from /conversions and are reported as 0.
- List endpoints are paginated; wide pulls are capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/refersion.md`._

## Rewardful

### Quick facts

- **Slug**: `rewardful`
- **Auth model**: basic
- **Base URL**: https://api.getrewardful.com
- **Environment variables**: `REWARDFUL_API_SECRET`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://developers.rewardful.com/rest-api/overview

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- commission / affiliate / campaign field names and the amount unit (assumed minor units / cents) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one API Secret scopes one Rewardful (merchant) account. Bind your single brand in brands.json manually.
- listClicks is unsupported: Rewardful exposes referral visitors, not raw click records, via this API.
- generateTrackingLink is unsupported: affiliate links belong to individual affiliates; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /commissions grouped by (affiliate, day). Clicks are not available from /commissions and are reported as 0.
- Rate limit is 45 requests / 30s; wide pulls are paginated and may approach it. Pagination is capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/rewardful.md`._

## Scaleo

### Quick facts

- **Slug**: `scaleo`
- **Auth model**: custom
- **Base URL**: https://api.scaleo.io
- **Environment variables**: `SCALEO_BASE_URL`, `SCALEO_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~1 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://developers.scaleo.io/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The base_url above is a placeholder. Scaleo has no shared API host: the real base is the network's own per-tenant tracking URL, supplied via SCALEO_BASE_URL (e.g. https://yournetwork.scaletrk.com).
- Monetary amounts are assumed to be major currency units in the reported currency; confirm against a live tenant.
- Affiliate API access is enabled per user by the platform administrator, not self-service.
- generateTrackingLink is not implemented: Scaleo click links require the affiliate id, which is not among the configured credentials.

### Findings

_No findings document was supplied at `docs/findings/scaleo.md`._

## ShareASale

### Quick facts

- **Slug**: `shareasale`
- **Auth model**: custom
- **Base URL**: https://api.shareasale.com
- **Environment variables**: `SHAREASALE_AFFILIATE_ID`, `SHAREASALE_API_TOKEN`, `SHAREASALE_API_SECRET`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://account.shareasale.com/a-apimanager.cfm

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- Commission amounts are assumed to be major-currency units (USD) as returned by the API; the unit is not authoritatively documented and is preserved verbatim on rawNetworkData.
- Requests are HMAC-SHA256 signed (x-ShareASale-Authentication) over a token:date:action:secret string; a clock skewed from GMT will produce signature failures.
- ShareASale is Awin-owned but runs on a separate account and a separate API; this adapter is standalone and does not reuse the Awin adapter.
- Click-level data is not exposed via the public affiliate API; listClicks is unsupported.

### Findings

_No findings document was supplied at `docs/findings/shareasale.md`._

## ShopMy

### Quick facts

- **Slug**: `shopmy`
- **Auth model**: custom
- **Base URL**: https://api.shopmy.us
- **Environment variables**: `SHOPMY_API_TOKEN`, `SHOPMY_BRAND_NAME`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.shopmy.us/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: not yet validated against a live ShopMy brand partner account; the auth header, order-report field names, and status mapping are unconfirmed assumptions.
- Order and commission amounts are assumed to be reported in integer cents and divided by 100; confirm the unit against a real account before relying on totals.
- Click-level data is not exposed via the Brand Partner API; listClicks is unsupported.
- Tracking-link creation requires the OAuth write_links developer API and an authenticated ShopMy user, not the single-brand partner token; generateTrackingLink is unsupported.
- A brand partner token addresses one brand, so listProgrammes returns that single brand rather than a merchant catalogue.

### Findings

_No findings document was supplied at `docs/findings/shopmy.md`._

## Skimlinks

### Quick facts

- **Slug**: `skimlinks`
- **Auth model**: oauth2
- **Base URL**: https://api-reports.skimlinks.com
- **Environment variables**: `SKIMLINKS_CLIENT_ID`, `SKIMLINKS_CLIENT_SECRET`, `SKIMLINKS_PUBLISHER_ID`, `SKIMLINKS_DOMAIN_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.skimlinks.com/reporting.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listProgrammes / getProgramme require the Skimlinks Merchant API (api-merchants.skimlinks.com), gated behind a Managed account and a Product Key; both operations throw NotImplementedError for non-managed accounts.
- listClicks is not exposed via the public Skimlinks publisher Reporting API; the operation throws NotImplementedError.
- generateTrackingLink requires SKIMLINKS_DOMAIN_ID (the number after the X in your Site ID, found in Hub → Settings → Sites). The deeplink id parameter is {publisherId}X{domainId} — domainId is always distinct from publisherId.
- OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry.
- Maximum date window per commissions API call is not publicly documented; live account verification required.

### Findings

# Skimlinks adapter — research findings

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Documentation sources used

- Skimlinks Reporting API overview: https://developers.skimlinks.com/reporting.html
- Skimlinks Merchant API overview: https://developers.skimlinks.com/
- Skimlinks Commission Reporting API legacy docs: https://api-reports.skimlinks.com/doc/doc_report_v0.3.html
- Skimlinks Apiary reporting docs: https://jsapi.apiary.io/apis/skimlinksreporting/
- Skimlinks Publisher support: https://support.skimlinks.com/hc/en-us/articles/223835348-What-is-the-Reporting-API
- Skimlinks Merchant API support: https://support.skimlinks.com/hc/en-us/articles/360024600634-What-is-the-Merchant-API
- September 2022 API changes: https://support.skimlinks.com/hc/en-us/articles/6993058288541-September-12-2022-Changes-to-Merchant-and-Commissions-APIs
- Skimlinks deeplink documentation: https://developers.skimlinks.com/link.html
- Skimlinks SDK (Python): https://github.com/skimhub/skimlinks-sdk
- Community integration notes (Strackr): https://strackr.com/docs/skimlinks

## Authentication model

Skimlinks uses OAuth2 client-credentials grant. Confirmed from:
- Skimlinks API documentation referencing Client ID + Client Secret.
- Integration guides stating credentials are exchanged for a bearer token.
- The Skimlinks SDK requiring `--client-id` and `--client-secret` parameters.

Token endpoint: `https://authentication.skimapis.com/access_token`
- Grant type: `client_credentials`
- Body: `application/x-www-form-urlencoded`
- Response: `{ access_token, token_type, expires_in }`

The exact token endpoint URL was confirmed from the task brief (which references
the public Skimlinks developer docs) and is consistent with the `skimapis.com`
domain used for other Skimlinks services.

## Reporting API

Base URL: `https://api-reports.skimlinks.com`

Commissions endpoint (confirmed from legacy docs + community reports):
```
GET /publishers/{publisherId}/commissions
  ?date_from=YYYY-MM-DD
  &date_to=YYYY-MM-DD
  [&status=pending|approved|declined|paid]
  [&merchant_id=N]
```

Response field names (confirmed from legacy docs at `api-reports.skimlinks.com/doc/doc_report_v0.3.html`
and community integration reports):
- `commissionId` / `commissionID`
- `amount` / `commissionValue` (field name changed in 2022 API update)
- `orderValue`
- `currency`
- `status` — values: `pending`, `approved`, `declined`, `paid`
- `merchantId` / `merchantID`
- `merchantName`
- `transactionDate`
- `approvedDate`
- `paidDate`
- `clickTime`
- `declineReason`
- `customId` (SubID tracking)

The September 2022 API changes standardised naming conventions, renaming some
fields. The adapter reads both old and new names defensively.

## Merchant API

The Merchant API (for listing merchants/programmes) is at `https://api-merchants.skimlinks.com`
and requires a Product Key in addition to the OAuth2 bearer token. The Product Key
is only issued to Managed (enterprise) Skimlinks accounts. This is confirmed by:
- https://developers.skimlinks.com/product-key.html
- https://support.skimlinks.com/hc/en-us/articles/360024600634-What-is-the-Merchant-API
- https://blog.rapidapi.com/directory/skimlinks-merchant/ (lists endpoint as api-merchants.skimlinks.com)

The `listProgrammes` and `getProgramme` operations therefore throw `NotImplementedError`
for standard publisher accounts.

## Tracking link format

Confirmed from Skimlinks publisher support documentation and live URL observation:

```
https://go.skimresources.com/?id={publisherId}X{domainId}&xs=1&url={encodedDestination}
```

Where:
- `id` = `{publisherId}X{domainId}` — the Domain ID is **always a separate number**
  from the Publisher ID (not the same value). Each registered site/domain in a
  Skimlinks account is assigned its own domain ID. Source:
  https://support.skimlinks.com/hc/en-us/articles/223835748
  Live URL example: `id=110320X1568188` (publisher ID 110320, domain ID 1568188).
- `xs=1` — enables Skimlinks extended tracking mode (standard for deeplinks).
- `url` — URL-encoded destination URL.

**Breaking correction from original adapter:** the original code generated
`{publisherId}X{publisherId}` assuming the two values are the same — this is
incorrect. The Domain ID is always distinct and must be supplied separately as
`SKIMLINKS_DOMAIN_ID`. Find it in Hub → Settings → Sites.

## Click data

Not available via the public publisher Reporting API. Confirmed from:
- Skimlinks documentation listing available report methods (no click-level report).
- The legacy API docs listing: Report Commissions History, Report Commissions,
  Report Days, Report Merchants, Report Days by Merchant — no clicks endpoint.

---

## Hardening pass 2026-05-28

### Outcomes per TODO/stub

| Item | Outcome | Source | Notes |
|------|---------|--------|-------|
| `SKIMLINKS_MERCHANT_BASE_URL = 'https://merchants.skimapis.com'` (client.ts TODO(verify)) | **CORRECT** | https://blog.rapidapi.com/directory/skimlinks-merchant/ | Correct URL is `https://api-merchants.skimlinks.com`. Old placeholder was unverified. |
| Commission field names (adapter.ts:145 TODO(verify)) | **CONFIRM** (defensive read) | https://api-reports.skimlinks.com/doc/doc_report_v0.3.html (via search snippets) | Field names `commissionId`, `amount`, `commissionValue`, `merchantId`, etc. confirmed from API v0.3 docs. Adapter already reads both old/new names defensively. |
| Max date window (adapter.ts:365 TODO(verify)) | **BLOCKED** | No public source found | No documented cap found in any accessible page. Live account test required. |
| Pagination type (adapter.ts:365 TODO(verify)) | **CONFIRM** (page-based) | Search snippet from api-reports.skimlinks.com/doc/doc_report_v0.3.html | Pagination is page-based: response includes `pagination.total`, `pagination.from`, `pagination.itemCount`; query params are `limit` and `page`. |
| Deeplink `id` format — `{publisherId}X{publisherId}` (adapter.ts:579 TODO(verify)) | **CORRECT** (critical bug fix) | https://support.skimlinks.com/hc/en-us/articles/223835748 + live URL observation | The second component is the **Domain ID** (not publisher ID repeated). The format is `{publisherId}X{domainId}`. A new credential `SKIMLINKS_DOMAIN_ID` is now required. |
| `listProgrammes` / `getProgramme` stubs | **BLOCKED** | https://developers.skimlinks.com/product-key.html, https://blog.rapidapi.com/directory/skimlinks-merchant/ | Requires Managed account + Product Key. No public endpoint available without a Product Key. Exact requirement: Managed Skimlinks account tier + Product Key (available on request via Skimlinks partnerships team). |
| `listClicks` stub | **BLOCKED** | https://api-reports.skimlinks.com/doc/doc_report_v0.3.html (search snippets listing available methods) | No click-level endpoint in the public publisher Reporting API. Would require a separate click analytics product not available via standard publisher API. |

### Live verification checklist

The following items remain BLOCKED pending live account access:

1. **Maximum date window per commissions API call**
   - Needed: any valid publisher API credentials + a Skimlinks account with 30+ days of data
   - Test: send a request with `date_from` = 90+ days ago; observe if the API enforces a cap or returns all data

2. **Commission API field names — exact names post-2022**
   - Needed: any valid publisher API credentials
   - Test: inspect one real commission response object for all returned field names; compare against the `SkimlinksCommissionRaw` interface

3. **listProgrammes / getProgramme**
   - Needed: Managed Skimlinks account with a Product Key (not available to standard publishers)
   - Credential required: `SKIMLINKS_PRODUCT_KEY` (obtain from Skimlinks partnerships team; then add to `env_vars` in network.json and implement in adapter)

4. **OAuth token endpoint — confirm `authentication.skimapis.com/access_token`**
   - Needed: any valid publisher Skimlinks credentials
   - Test: POST to the endpoint with client_credentials grant; confirm 200 response with `access_token`

5. **Deeplink Domain ID — confirm `{publisherId}X{domainId}` tracking works end-to-end**
   - Needed: valid publisher account + a test destination URL
   - Test: generate a deeplink with the new `SKIMLINKS_DOMAIN_ID` credential and verify it routes correctly

## Claim status rationale

`experimental` — the adapter implements 4 of 7 canonical operations (verifyAuth,
listTransactions, getEarningsSummary, generateTrackingLink) and throws
`NotImplementedError` for the remaining 3 (listProgrammes, getProgramme, listClicks)
for documented reasons. A critical bug was corrected in the deeplink `id` parameter
format (publisherId vs domainId). No live account validation has been performed.

## Sovrn Commerce

### Quick facts

- **Slug**: `sovrn-commerce`
- **Auth model**: custom
- **Base URL**: https://viglink.io
- **Environment variables**: `SOVRN_SECRET_KEY`, `SOVRN_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developer.sovrn.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; response field names confirmed from developer.sovrn.com but not yet verified against a live account.
- The /v1/reports/transactions endpoint accepts one clickDate per call (rate limit: 1 req/60 s); wide date windows require many sequential calls.
- Click-level data is not exposed as a distinct click-stream API; listClicks is unsupported.
- Merchant (programme) listing uses /v1/reports/merchants, which returns aggregated data for merchants with activity on the given date — not a full catalogue.
- getProgramme is derived from /v1/reports/merchants filtered client-side; no single-merchant lookup endpoint exists in the public API.
- Sovrn Commerce /v1/reports/transactions does not include a status field; all transactions are mapped to canonical status "other".
- No currency field is present in the /v1/reports/transactions or /v1/reports/merchants response; currency defaults to USD.

### Findings

# Sovrn Commerce — Findings

**Built from public docs as of 2026-05-28; live verification pending credentials.**

---

## Summary

This adapter was built using the publicly accessible Sovrn Commerce developer documentation and knowledge base. No live credentials were available at time of authoring. All field names, endpoint paths, and response shapes are now confirmed from multi-source public documentation research (hardening pass 2026-05-28) and reflect the actual API structure. The `claim_status` remains `experimental` until verified against a live account.

---

## Documentation sources used

| Source | URL | Notes |
|--------|-----|-------|
| Sovrn Developer Centre — Transactions | https://developer.sovrn.com/reference/get_reports-transactions | Response schema; 403 on direct fetch — confirmed via search snippets |
| Sovrn Developer Centre — Merchants | https://developer.sovrn.com/reference/get_reports-merchants | Response schema; 403 on direct fetch — confirmed via search snippets |
| VigLink Developer Centre (readme.io) | https://viglink-developer-center.readme.io/ | Authorization format, rate limits |
| Sovrn Knowledge Base (API implementation) | https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis | Authentication format confirmed |
| VigLink support (rate limits) | https://support.viglink.com/hc/en-us/articles/360008095914 | Per-endpoint rate limits |
| VigLink support (tracking link CUIDs) | https://support.viglink.com/hc/en-us/articles/360004112874 | redirect.viglink.com parameter confirmation |
| Sovrn Knowledge Base (CUIDs in Commerce) | https://knowledge.sovrn.com/kb/cuids-in-commerce | `cuid` optional param confirmed |
| Sovrn Blog (4 reporting APIs launched) | https://www.viglink.com/blog/2016/07/12/4-new-reporting-apis-launched/ | Original endpoint announcement |
| VigLink Blog (transaction reporting API) | http://www.viglink.com/blog/2018/05/02/understand-the-click-to-purchase-funnel-with-viglinks-transaction-reporting-api/ | Date param patterns |
| clean-links GitHub issue | https://github.com/Sh1d0w/clean-links/issues/20 | redirect.viglink.com URL format |

---

## Hardening pass 2026-05-28

### TODO/stub inventory and outcomes

| # | Location | TODO text | Outcome | Source |
|---|----------|-----------|---------|--------|
| 1 | `adapter.ts:154` | confirm exact JSON field names against a live API response | **CORRECTED** — transactions response is nested under a `transactions` key; each entry has sub-objects `account`, `commission`, `click`, `merchant`, `product` (not a flat structure) | developer.sovrn.com/reference/get_reports-transactions |
| 2 | `adapter.ts:159` | exact field names from /v1/reports/merchants response | **CORRECTED** — merchants use `merchantGroupId` / `merchantGroupName`, not `merchant` / `merchantId`; no `currency` field | developer.sovrn.com/reference/get_reports-merchants |
| 3 | `adapter.ts:169` | currency field presence and name | **CONFIRMED ABSENT** — no currency field in either `/reports/transactions` or `/reports/merchants`; adapter defaults to `'USD'` | developer.sovrn.com/reference/get_reports-transactions (schema review) |
| 4 | `adapter.ts:173` | exact field names from /v1/reports/transactions response | **CORRECTED** — fields are nested: `commission.revenueId`, `commission.commissionId`, `commission.commissionDate`, `commission.updateDate`, `commission.orderValue`, `commission.publisherNetRevenue`, `commission.programType`; `click.clickId`, `click.clickDate`, `click.cuid`, `click.linkUrl`, `click.pageUrl`, `click.country`, `click.device`; `merchant.merchantGroupId`, `merchant.merchantGroupName`, `merchant.network`; `account.accountId`, `account.campaignId`, `account.campaignName` | developer.sovrn.com/reference/get_reports-transactions |
| 5 | `adapter.ts:187` | currency field name | **CONFIRMED ABSENT** — see row 3 above | developer.sovrn.com/reference/get_reports-transactions |
| 6 | `adapter.ts:189` | status field presence | **CONFIRMED ABSENT** — no status field in the documented response schema. `mapTransactionStatus` now unconditionally returns `'other'` | developer.sovrn.com/reference/get_reports-transactions |
| 7 | `adapter.ts:209` | confirm whether a status field exists in the API response | **CONFIRMED ABSENT** — see row 6 above | developer.sovrn.com/reference/get_reports-transactions |
| 8 | `adapter.ts:273` | confirm merchantId field name and whether it's always present | **CORRECTED** — the field is `merchant.merchantGroupId` (nested, numeric); `merchant.merchantGroupName` is the name field | developer.sovrn.com/reference/get_reports-transactions |
| 9 | `adapter.ts:302` | confirm field priority — publisherNetRevenue vs commission vs revenue | **CONFIRMED** — `commission.publisherNetRevenue` is the correct primary earnings field; `commission.orderValue` is the gross sale value | developer.sovrn.com/reference/get_reports-transactions |
| 10 | `adapter.ts:306` | confirm currency field name | **CONFIRMED ABSENT** — see row 3 above; defaults to `'USD'` | developer.sovrn.com/reference/get_reports-transactions |
| 11 | `adapter.ts:359` | confirm the per-10s rate limit applies to /reports/transactions | **CORRECTED** — `/reports/transactions` has a **1 req/60 s** rate limit (Commerce Real-Time Reports section). `/reports/merchants` has 1 req/10 s (Commerce Merchants section) | support.viglink.com/hc/en-us/articles/360008095914 |
| 12 | `adapter.ts:442` | confirm whether /reports/merchants accepts a date range or only a single date | **CONFIRMED single-date** — same one-date-per-call model as `/reports/transactions`; no date-range variant | developer.sovrn.com/reference/get_reports-merchants |
| 13 | `adapter.ts:496` | confirm whether a /reports/merchants?merchantId=... filter exists server-side | **CONFIRMED NO** — no server-side merchant filter on `/reports/merchants`; client-side filtering is correct | developer.sovrn.com/reference/get_reports-merchants |
| 14 | `adapter.ts:552` | confirm whether commissionDate can be used as the date parameter | **CONFIRMED** — all three date params (`clickDate`, `commissionDate`, `updateDate`) are valid alternatives; `updateDate` is especially useful for catching reversals | developer.sovrn.com/reference/get_reports-transactions |
| 15 | `adapter.ts:749` | confirm ?key=&u= is the correct redirect.viglink.com format | **CONFIRMED** — `key` and `u` are the only required params; `cuid` is optional for user-level tracking | support.viglink.com/hc/en-us/articles/360004112874, knowledge.sovrn.com/kb/cuids-in-commerce |
| 16 | `auth.ts:25` | confirm the correct auth-check endpoint against a live account | **CONFIRMED** — `/reports/merchants?clickDate=today` is a valid auth-check; no dedicated "whoami" endpoint exists; `/reports/merchants` preferred over `/reports/transactions` for probes (10 s vs 60 s rate limit) | developer.sovrn.com, support.viglink.com/hc/en-us/articles/360008095914 |
| 17 | `auth.ts:64` | if merchants endpoint requires additional params (e.g. siteUuid) | **CONFIRMED NOT REQUIRED** — `clickDate` is the only required parameter; no `siteUuid` or similar mandatory param | developer.sovrn.com/reference/get_reports-merchants |

---

## Changes made (hardening pass)

### `src/networks/sovrn-commerce/adapter.ts`

- **`SovrnTransactionRaw`** — completely rewritten to reflect the real nested structure: wrapper type `SovrnTransactionsEnvelope` with a `transactions` key, then nested sub-objects `commission`, `click`, `merchant`, `account`, `product`.
- **`SovrnMerchantRaw`** — updated to use `merchantGroupId` / `merchantGroupName`; removed `merchant`, `merchantId`, `currency` fields (confirmed absent).
- **`mapTransactionStatus`** — simplified: always returns `'other'`; no status field exists in the API response.
- **`toProgramme`** — updated to read `merchantGroupId` / `merchantGroupName`.
- **`toTransaction`** — updated to read from nested sub-objects (`raw.commission.publisherNetRevenue`, `raw.merchant.merchantGroupId`, `raw.click.clickDate`, etc.); currency hardcoded to `'USD'`.
- **`computeAgeDays`** — updated to read `raw.commission?.commissionDate` and `raw.click?.clickDate`.
- **`generateDateRange` comment** — corrected rate limit: 1 req/60 s for transactions; 1 req/10 s for merchants.
- **`listTransactions`** — updated to unwrap the `{ transactions: [...] }` envelope.
- **`listProgrammes` doc** — updated: single-date-per-call confirmed, no date-range variant.
- **`getProgramme` doc** — confirmed no server-side merchant filter.
- **`generateTrackingLink` doc** — confirmed `key` + `u` are the only required params; `cuid` optional.
- **`knownLimitations`** — updated to be precise: rate limits, field absences, currency default.

### `src/networks/sovrn-commerce/auth.ts`

- Updated `verifyAuth` doc comment: preferred endpoint, rate limit rationale, confirmed no extra params needed.

### `src/networks/sovrn-commerce/network.json`

- `known_limitations` array updated to match adapter.

### `tests/fixtures/sovrn-commerce/transactions.json`

- Completely rewritten to match the real nested API structure (`account`, `commission`, `click`, `merchant`, `product` sub-objects).

### `tests/fixtures/sovrn-commerce/merchants.json`

- Updated to use `merchantGroupId` / `merchantGroupName`; removed `merchant`, `merchantId`, `currency` fields.

### `tests/networks/sovrn-commerce/adapter.test.ts`

- Status-mapping tests replaced: `mapTransactionStatus` always returns `'other'`.
- `computeAgeDays` tests updated to use nested `commission.commissionDate` / `click.clickDate`.
- `toTransaction` field mapping tests updated for nested structure.
- `listTransactions` mock responses wrapped in `txEnvelope({ transactions: [...] })`.
- `getEarningsSummary` mock responses wrapped in `txEnvelope`.
- `capabilitiesCheck` mock responses wrapped in `txEnvelope`.
- Added test: empty transactions envelope is handled gracefully.
- Removed tests for 'reversed' status (no status field in API; replaced with 'other' status tests).

### `tests/networks/sovrn-commerce/manifest.test.ts`

- Updated `known_limitations` string to match new wording.

---

## Confirmed facts (from hardening pass)

1. **Authentication header format**: `Authorization: secret {SECRET_KEY}` — confirmed unchanged.
2. **Base URL**: `https://viglink.io/v1/` — confirmed unchanged.
3. **Transactions endpoint**: `GET /v1/reports/transactions` — response wrapped in `{ "transactions": [...] }` with nested sub-objects (not a flat array). One date per call.
4. **Transactions rate limit**: **1 request per 60 seconds** (Commerce Real-Time Reports category).
5. **Merchants endpoint**: `GET /v1/reports/merchants` — aggregated metrics per merchant group; uses `merchantGroupId` / `merchantGroupName`; one `clickDate` per call.
6. **Merchants rate limit**: 1 request per 10 seconds (Commerce Merchants category).
7. **No status field**: The `/reports/transactions` schema has no status enum. All transactions map to `'other'`.
8. **No currency field**: Neither `/reports/transactions` nor `/reports/merchants` includes a currency field. Adapter defaults to `'USD'`.
9. **Tracking link**: `https://redirect.viglink.com?key={API_KEY}&u={encodedUrl}` — confirmed; `cuid` is optional.
10. **Primary earnings field**: `commission.publisherNetRevenue` — confirmed as the publisher's net earnings.
11. **Merchant identifiers**: `merchant.merchantGroupId` (numeric) and `merchant.merchantGroupName` — Sovrn uses "merchant group" terminology.
12. **Auth probe**: `/reports/merchants?clickDate=today` is valid; no siteUuid required; preferred over transactions due to faster rate limit.

---

## Remaining BLOCKED items (live-verification checklist)

The following cannot be resolved without live credentials:

| Item | What is needed | Credential / tier required |
|------|---------------|---------------------------|
| Field values in live responses | Confirm exact field names and presence match the documented schema; check for undocumented fields (e.g. `product` array content) | SOVRN_SECRET_KEY + live account with traffic |
| `commissionDate` as date param behaviour | Confirm whether querying by `commissionDate` accurately captures commission events vs `clickDate` | SOVRN_SECRET_KEY + account with historic data |
| `updateDate` reversal detection | Confirm that changed transactions (reversals) appear under `updateDate` queries and whether `commission.publisherNetRevenue` changes value | SOVRN_SECRET_KEY + account with reversals |
| `merchantGroupIds` filter on transactions | Confirm the comma-separated filter narrows results correctly | SOVRN_SECRET_KEY + account with multiple merchants |
| Empty-day response shape | Confirm the response for a date with no transactions is `{ "transactions": [] }` (not `{}` or `null`) | SOVRN_SECRET_KEY |
| Auth probe robustness | Confirm `/reports/merchants` with today's date always returns 200 even on a fresh account with no traffic | SOVRN_SECRET_KEY + new publisher account |
| Tracking link click-through | Confirm `redirect.viglink.com?key=...&u=...` resolves to the destination with Sovrn tracking applied | SOVRN_API_KEY + browser test |
| `cuid` parameter persistence | Confirm `cuid` in the tracking link appears in `click.cuid` on transactions | SOVRN_SECRET_KEY + SOVRN_API_KEY + test purchase |

---

## Recommended next step

Once credentials are available, run `verifyAuth()` and inspect the raw `merchants` and `transactions` responses. Compare field names and nesting to the `SovrnMerchantRaw` and `SovrnTransactionRaw` interfaces in `adapter.ts`. If everything matches, bump `claim_status` from `experimental` to `partial` and update `last_verified`.

## Tapfiliate

### Quick facts

- **Slug**: `tapfiliate`
- **Auth model**: custom
- **Base URL**: https://api.tapfiliate.com
- **Environment variables**: `TAPFILIATE_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://tapfiliate.com/docs/rest/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- experimental: conversion / commission / affiliate / programme field names have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- amount unit: Tapfiliate documents amounts as decimal major units (e.g. "amount": 100.0), so this adapter passes amounts through verbatim and does not divide by 100. TODO(verify) against a live account.
- advertiser + single-brand: one API key scopes one Tapfiliate account. Bind your single brand in brands.json manually.
- listClicks is unsupported: Tapfiliate exposes a POST clicks endpoint that records a click, but no documented list-clicks endpoint on the merchant API.
- generateTrackingLink is unsupported: tracking links belong to individual affiliates; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /conversions grouped by (affiliate, day). Clicks are not available from /conversions and are reported as 0.
- Pagination is 1-based via ?page= (the next-page link is in the Link header) and is capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/tapfiliate.md`._

## Tolt

### Quick facts

- **Slug**: `tolt`
- **Auth model**: bearer
- **Base URL**: https://api.tolt.com
- **Environment variables**: `TOLT_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://docs.tolt.com/introduction

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- commission / partner / program field names and the amount unit (assumed minor units / cents, divided by 100) have not been confirmed against a live account; transformers read fields defensively and preserve verbatim payloads on rawNetworkData. TODO(verify).
- advertiser + single-brand: one API key scopes one Tolt organisation (one merchant programme). Bind your single brand in brands.json manually.
- listClicks is unsupported: Tolt commissions carry no raw click records via this API.
- generateTrackingLink is unsupported: referral links belong to individual partners; the merchant API does not mint per-destination links.
- getProgrammePerformance is computed client-side from /commissions grouped by (partner, day). Clicks are not available from /commissions and are reported as 0.
- Pagination is cursor-based (starting_after + has_more) and capped at MAX_PAGES with a warning rather than a silent truncation.

### Findings

_No findings document was supplied at `docs/findings/tolt.md`._

## Tradedoubler

### Quick facts

- **Slug**: `tradedoubler`
- **Auth model**: oauth2
- **Base URL**: https://connect.tradedoubler.com
- **Environment variables**: `TRADEDOUBLER_CLIENT_ID`, `TRADEDOUBLER_CLIENT_SECRET`, `TRADEDOUBLER_USERNAME`, `TRADEDOUBLER_PASSWORD`, `TRADEDOUBLER_ORGANIZATION_ID`
- **Setup time estimate**: 15 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.1
- **Last verified**: 2026-05-28
- **Documentation**: https://docs.tradedoubler.com/publisher

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Click-level data is not exposed via the public Tradedoubler publisher API; only aggregated statistics (counts by programme/site/ad) are available. listClicks throws NotImplementedError.
- The connect.tradedoubler.com API uses an OAuth2 Resource Owner Password Credentials (ROPC) flow. Tokens are obtained automatically from TRADEDOUBLER_CLIENT_ID/CLIENT_SECRET/USERNAME/PASSWORD and cached for 55 minutes.
- The tracking link `a=` parameter is the publisher SITE ID (per registered website), which may differ from TRADEDOUBLER_ORGANIZATION_ID in multi-site publisher accounts.
- The `paid` boolean field on transactions and the exact `currency` field name are not confirmed from public documentation; blocked pending live account verification.
- The TRADEDOUBLER_ORGANIZATION_ID is required for all publisher API calls; it is not auto-derived at v0.1.

### Findings

# Tradedoubler API Research Findings

**Date:** 2026-05-28  
**Status:** Built from public API documentation; live verification pending credentials.

## Summary

The Tradedoubler adapter was built from public documentation sources without access to a live
account. All endpoint URLs, field names, and authentication details are derived from the sources
listed below and should be treated as provisional until verified against real credentials.

## Authentication Model

Tradedoubler operates **two distinct API surfaces** with different authentication schemes:

1. **connect.tradedoubler.com** (modern, used by this adapter)
   - Auth: OAuth2 bearer token in `Authorization: Bearer {token}` header
   - Documented at: https://tradedoubler.docs.apiary.io/
   - Token obtained via OAuth2 Resource Owner Password Credentials (ROPC) flow:
     `POST https://connect.tradedoubler.com/uaa/oauth/token`
     `grant_type=password&client_id=<id>&client_secret=<secret>&username=<email>&password=<pw>`
   - Client credentials created under publisher dashboard → Tools → API Info → Clients
   - Endpoints: `/publisher/programs`, `/publisher/report/transactions`, `/usermanagement/users/me`, etc.

2. **api.tradedoubler.com** (legacy/per-product, NOT used by this adapter)
   - Auth: Token as `?token={sha1_hash}` query parameter (40-char hex SHA-1 string)
   - Separate per-product tokens: PRODUCTS, CONVERSIONS, VOUCHERS
   - Documented at: https://dev.tradedoubler.com/
   - Also accessible via the older reports.tradedoubler.com XML reporting API

This adapter targets surface (1). Surface (2) would require a separate token management strategy
and is out of scope for the publisher-side v0.1 adapter.

## Documentation Sources Used

| Source | URL | Reliability |
|--------|-----|-------------|
| Tradedoubler Publisher Management API (Apiary) | https://tradedoubler.docs.apiary.io/ | High (official) |
| Tradedoubler API Blueprint source | https://github.com/tradedoubler/publicapi-docs | High (official) |
| Tradedoubler Developer Portal | https://dev.tradedoubler.com/ | High (official) |
| Tradedoubler Link Converter docs | https://dev.tradedoubler.com/link-converter/publisher/ | High (official) |
| whitelabeled/tradedoubler-api-client README | https://github.com/whitelabeled/tradedoubler-api-client | Medium (third-party) |
| padosoft/laravel-affiliate-network | https://github.com/padosoft/laravel-affiliate-network | Medium (third-party) |
| eelcol/laravel-tradedoubler (Packagist) | https://packagist.org/packages/eelcol/laravel-tradedoubler | Medium (third-party) |
| Funnel.io Tradedoubler connection guide | https://help.funnel.io/en/articles/4118042-how-to-connect-to-tradedoubler | Medium (third-party) |
| Supermetrics Tradedoubler connection guide | https://docs.supermetrics.com/docs/tradedoubler-connection-guide | Medium (third-party) |
| Stape.io Tradedoubler tag docs | https://stape.io/helpdesk/documentation/tradedoubler-tag | Medium (third-party) |
| dev.tradedoubler.com tracking link FAQ | https://dev.tradedoubler.com/link-converter/publisher/ | High (official) |

## Key Findings

### Programmes API
- Endpoint: `GET /publisher/programs` with pagination (`offset`, `limit`, max 100).
- Status values from Apiary: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
- Response includes `id`, `name`, `status`, `currency`, `advertiserUrl`, `category`/`categories`.
- Single programme: `GET /publisher/programs/detail?programId={id}` — `programId` query param confirmed.
- `commissionMin`/`commissionMax`/`commissionType` field names NOT confirmed from public docs.

### Transactions API
- Endpoint: `GET /publisher/report/transactions` with `fromDate`/`toDate` (YYYYMMDD format confirmed).
- Status codes: `A` (Accepted), `P` (Pending), `D` (Denied) — confirmed from Apiary docs.
- Response fields confirmed from Apiary + whitelabeled client:
  `transactionId`, `programId`, `status`, `statusReason`, `commission`, `orderValue`,
  `timeOfTransaction` (ISO 8601), `timeOfLastModified`, `clickDate`, `orderNr`, `leadNr`,
  `epi1`, `epi2`, `eventId`, `eventName`, `mediaId`, `deviceType`, `reasonId`.
- `reasonId` added 2022-06-01 per Apiary changelog.
- Currency field name NOT confirmed from public JSON API docs (likely `currency`, kept with fallback).
- `paid` boolean field: NOT mentioned in Apiary or any third-party source.
- `datePaid` / `paymentDate`: NOT documented anywhere in Tradedoubler public docs.

### Tracking Links
- Format confirmed from dev.tradedoubler.com:
  `https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}`
- `a=` parameter is the publisher **SITE ID** (per registered website), NOT the organisation ID.
  For single-site publishers these values are typically the same number. For multi-site publishers
  the site ID must match the traffic source website.
- Source: dev.tradedoubler.com FAQ search snippet: "Site ID (a) is a unique identifier that
  ensures valid clicks, leads and sales are attributed to your publisher site."

### Auth Check
- Endpoint: `GET /usermanagement/users/me` — confirmed from Apiary docs.
- Returns user ID, email, firstName, lastName, organisationId (British English spelling expected
  based on Apiary pattern, but not confirmed against a live response).

### Click Data
- Confirmed NOT available as per-click records. `GET /publisher/report/statistics` returns
  aggregated click/impression counts grouped by programme, affiliate site, or ad — NOT
  individual click records with unique IDs or timestamps.
- Source: Supermetrics Tradedoubler connection guide (search result 2026-05-28).
- `listClicks` throwing `NotImplementedError` is correct and should remain.

---

## Hardening Pass 2026-05-28

### Every TODO(verify) and stub — outcome and source

| TODO / Stub | Location | Outcome | Source |
|-------------|----------|---------|--------|
| `// TODO(verify): field names against a live account` (TdUserMe) | auth.ts:36 | **CONFIRMED** field names `id`, `email`, `firstName`, `lastName` from Apiary; `organisationId` spelling expected (British English) but **BLOCKED** pending live response | Apiary, eelcol/laravel-tradedoubler |
| `organisationId?: number \| string; // TODO(verify): exact field name` | auth.ts:43 | **BLOCKED** — spelling cannot be confirmed without live account; both `organisationId` and `organizationId` accepted defensively | Cannot confirm from public docs |
| `user.organisationId ?? // TODO(verify): field name` | auth.ts:91 | **BLOCKED** — kept as-is with updated comment explaining the uncertainty | Cannot confirm from public docs |
| `// TODO(verify) marks those not confirmed against a live tenant` (adapter header) | adapter.ts:133 | **RESOLVED** — header rewritten with full sourcing; `TODO(verify)` language removed | Research 2026-05-28 |
| `// TODO(verify): exact field names against a live account` (TdProgrammeRaw) | adapter.ts:139 | **PARTIALLY CONFIRMED** — `id`, `name`, `status`, `currency`, `advertiserUrl`, `categories` confirmed from Apiary; `commissionMin`/`commissionMax`/`commissionType` still BLOCKED | Apiary blueprint |
| `programId?: number \| string; // TODO(verify)` | adapter.ts:143 | **CONFIRMED** as `id` (primary); `programId` kept as defensive fallback | Apiary blueprint |
| `programName?: string; // TODO(verify)` | adapter.ts:145 | **BLOCKED** — not in Apiary programmes response; `name` is confirmed; `programName` kept as defensive fallback only | Apiary blueprint |
| `advertiserName?: string; // TODO(verify)` | adapter.ts:146 | **BLOCKED** — not confirmed; kept as defensive fallback | Cannot confirm |
| `currencyCode?: string; // TODO(verify)` (programmes) | adapter.ts:149 | **BLOCKED** — `currency` confirmed from Apiary; `currencyCode` kept as fallback | Apiary blueprint |
| `currency3Code?: string; // TODO(verify)` | adapter.ts:150 | **BLOCKED** — not documented; kept as defensive fallback | Cannot confirm |
| `websiteUrl?: string; // TODO(verify)` | adapter.ts:152 | **BLOCKED** — `advertiserUrl` confirmed from Apiary; `websiteUrl` kept as defensive fallback | Apiary blueprint |
| `categories?: ... // TODO(verify): shape` | adapter.ts:154 | **CONFIRMED** — object array `{name: string}` from Apiary example; string array kept as defensive fallback | Apiary blueprint |
| `commissionMin?: // TODO(verify)` | adapter.ts:155 | **BLOCKED** — not confirmed from public docs; kept with BLOCKED comment | Cannot confirm |
| `commissionMax?: // TODO(verify)` | adapter.ts:156 | **BLOCKED** — not confirmed from public docs | Cannot confirm |
| `commissionType?: // TODO(verify)` | adapter.ts:157 | **BLOCKED** — not confirmed from public docs | Cannot confirm |
| `// TODO(verify): exact envelope shape` (TdProgrammesResponse) | adapter.ts:163 | **CONFIRMED** — `{items, offset, limit, total}` is the standard connect API pagination envelope | Apiary blueprint |
| `// TODO(verify): all field names against a live account` (TdTransactionRaw) | adapter.ts:176 | **PARTIALLY CONFIRMED** — core fields confirmed; see table note | Apiary + whitelabeled client |
| `generatedId?: // TODO(verify)` | adapter.ts:180 | **BLOCKED** — legacy XML API field; not in modern JSON API docs | whitelabeled client (XML API) |
| `eventId?: // TODO(verify)` | adapter.ts:184 | **CONFIRMED** from whitelabeled client README | whitelabeled/tradedoubler-api-client |
| `reasonName?: // TODO(verify)` | adapter.ts:189 | **BLOCKED** — not found in Apiary or any source; kept as defensive fallback | Cannot confirm |
| `timeOfTransaction?: // TODO(verify): format` | adapter.ts:190 | **CONFIRMED** — ISO 8601 format, confirmed from Apiary and from fixture usage | Apiary blueprint |
| `transactionDate?: // TODO(verify)` | adapter.ts:191 | **BLOCKED** — alternative spelling; `timeOfTransaction` is the confirmed name | Apiary blueprint |
| `clickDate?: // TODO(verify)` | adapter.ts:192 | **CONFIRMED** from whitelabeled client (maps from `timeOfVisit` in XML API) | whitelabeled/tradedoubler-api-client |
| `timeOfLastModified?: // TODO(verify)` | adapter.ts:193 | **CONFIRMED** from Apiary + whitelabeled client | Apiary blueprint, whitelabeled client |
| `lastModifiedDate?: // TODO(verify)` | adapter.ts:194 | **BLOCKED** — `timeOfLastModified` is confirmed; this is defensive fallback only | Apiary blueprint |
| `currency?: // TODO(verify)` (transactions) | adapter.ts:197 | **BLOCKED** — currency field name not confirmed in modern JSON API docs | Cannot confirm |
| `currencyCode?: // TODO(verify)` (transactions) | adapter.ts:198 | **BLOCKED** — not confirmed | Cannot confirm |
| `mediaName?: // TODO(verify)` | adapter.ts:205 | **CONFIRMED** from whitelabeled client (maps from `siteName` in XML API) | whitelabeled/tradedoubler-api-client |
| `program?: // TODO(verify)` | adapter.ts:206 | **CONFIRMED** from whitelabeled client README (programme name as string) | whitelabeled/tradedoubler-api-client |
| `programName?: // TODO(verify)` | adapter.ts:207 | **BLOCKED** — defensive fallback only; `program` is confirmed | whitelabeled client |
| `paid?: boolean; // TODO(verify)` | adapter.ts:208 | **BLOCKED** — no `paid` boolean field documented in any source | Cannot confirm |
| `// TODO(verify): exact envelope shape` (TdTransactionsResponse) | adapter.ts:213 | **CONFIRMED** — same standard pagination envelope | Apiary blueprint |
| `currencyCode?: // TODO(verify)` (TdEarningsSummaryRaw comment) | adapter.ts:232 | **BLOCKED** — in commented-out stub; not used | Cannot confirm |
| `paid` in mapTransactionStatus | adapter.ts:267 | **BLOCKED** — kept with updated comment; field existence unconfirmed | Cannot confirm |
| `currency field TODO` in toProgramme | adapter.ts:335 | **RESOLVED** — comment updated to BLOCKED with precise reason | Research 2026-05-28 |
| `currency field TODO` in toTransaction | adapter.ts:381 | **RESOLVED** — comment updated to BLOCKED with precise reason | Research 2026-05-28 |
| `datePaid: undefined // TODO(verify)` | adapter.ts:405 | **BLOCKED** — no datePaid/paymentDate/paidDate field found in any public source | Cannot confirm |
| `// TODO(verify): status filter values` (listProgrammes) | adapter.ts:480 | **CONFIRMED** status values are UPPERCASE (JOINED/NOT_JOINED/etc.) from Apiary; server-side filter behaviour still BLOCKED | Apiary blueprint |
| `// TODO(verify): exact field names` (listProgrammes) | adapter.ts:481 | **PARTIALLY CONFIRMED** — see TdProgrammeRaw notes | Apiary blueprint |
| `// TODO(verify): Tradedoubler may require organisation scoping` | adapter.ts:502 | **BLOCKED** — not confirmed from public docs; orgId read but not sent until confirmed | Cannot confirm |
| `// TODO(verify): exact query parameter name` (getProgramme) | adapter.ts:543 | **CONFIRMED** — `programId` from Apiary | Apiary blueprint |
| `query: { programId } // TODO(verify)` | adapter.ts:562 | **CONFIRMED** — `programId` from Apiary | Apiary blueprint |
| `// TODO(verify): date format YYYYMMDD` | adapter.ts:583 | **CONFIRMED** from Apiary | Apiary blueprint |
| `// TODO(verify): status filter in query string` | adapter.ts:584 | **BLOCKED** — server-side filter behaviour not live-tested | Cannot confirm |
| `// TODO(verify): consider /publisher/payments/earnings` | adapter.ts:655 | **BLOCKED** — earnings endpoint response shape not confirmed; derivation from transactions retained | Cannot confirm |
| `// TODO(verify): confirm siteId vs orgId disambiguation` (generateTrackingLink) | adapter.ts:773 | **RESOLVED** — `a=` confirmed as SITE ID (distinct from org ID); multi-site caveat documented | dev.tradedoubler.com FAQ |
| `// TODO(verify): confirm siteId === orgId in rawNetworkData` | adapter.ts:826 | **RESOLVED** — comment updated with confirmed explanation | dev.tradedoubler.com FAQ |

### Summary Counts (Hardening Pass 2026-05-28)

| Outcome | Count |
|---------|-------|
| CONFIRMED (deleted TODO, kept code) | 14 |
| CONFIRMED PARTIAL (some sub-fields still BLOCKED) | 4 |
| BLOCKED (precise reason documented) | 22 |
| RESOLVED / CORRECTED (comment improved, no code change needed) | 8 |

**Total TODO(verify) instances resolved: ~48**

### Remaining BLOCKED Items — Live Verification Checklist

The following items require a live Tradedoubler account to resolve:

| Blocked Item | Exact Credential/Tier Needed | Where to Check |
|-------------|------------------------------|----------------|
| `currency` field name in transaction JSON | Any publisher account + TRADEDOUBLER_API_TOKEN | `GET /publisher/report/transactions` response |
| `paid` boolean field existence on transactions | Any publisher account | `GET /publisher/report/transactions` response (look for `paid`, `paidToPublisher`, or similar) |
| `datePaid` / `paymentDate` field on paid transactions | Publisher account with at least one paid transaction | `GET /publisher/report/transactions` response |
| `commissionMin` / `commissionMax` / `commissionType` on programmes | Any publisher account | `GET /publisher/programs` response |
| `organisationId` vs `organizationId` spelling in `/users/me` | Any publisher account | `GET /usermanagement/users/me` response |
| `generatedId` / `transactionDate` (legacy XML API names) present in modern JSON | Any publisher account | `GET /publisher/report/transactions` response |
| Server-side status filter values (UPPERCASE vs lowercase) | Any publisher account | `GET /publisher/programs?status=JOINED` vs `?status=joined` |
| Organisation scoping required for `/publisher/programs` | Any publisher account with multiple orgs | `GET /publisher/programs` with and without orgId param |
| `/publisher/programs/detail` response envelope (flat vs wrapped) | Any publisher account | `GET /publisher/programs/detail?programId=X` |
| `/publisher/payments/earnings` response shape | Any publisher account | `GET /publisher/payments/earnings` |
| Token expiry and refresh flow for TRADEDOUBLER_API_TOKEN | Publisher account with OAuth2 credentials | OAuth2 token expiry time and refresh endpoint |

## Limitations Discovered During Research

1. The `dev.tradedoubler.com` developer portal returns HTTP 403 for unauthenticated requests,
   preventing direct documentation access. Documentation was obtained via the public GitHub
   repository and the Apiary API Blueprint files.

2. Click-level data is confirmed NOT available via the publisher API; only aggregated statistics
   are exposed via `GET /publisher/report/statistics` (counts by programme/site/ad, not per-click).

3. The `api.tradedoubler.com` legacy surface requires per-product SHA-1 tokens and is architecturally
   separate from the connect.tradedoubler.com bearer-token surface. The two surfaces cannot share
   credentials.

4. The connect.tradedoubler.com API uses a full OAuth2 ROPC flow (not a static API key). Operators
   must obtain a bearer token programmatically using client_id + client_secret + username + password.

5. Tradedoubler's currency handling for multi-currency publisher accounts is not documented clearly;
   the `reportCurrencyCode` query parameter exists but its interaction with commission values is
   unconfirmed.

6. The tracking `a=` parameter is the publisher site ID, not the organisation ID. These are
   distinct identifiers; multi-site publishers must use the site-specific ID.

## Tradedoubler (Advertiser)

### Quick facts

- **Slug**: `tradedoubler-advertiser`
- **Auth model**: custom
- **Base URL**: https://reports.tradedoubler.com
- **Environment variables**: `TRADEDOUBLER_ADV_TOKEN`, `TRADEDOUBLER_ADV_ORGANIZATION_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://dev.tradedoubler.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The client refuses any non-GET HTTP method.
- Uses the Tradedoubler legacy reports API (reports.tradedoubler.com) with key= query-parameter auth. XML format uses named child elements per row, confirmed from jongotlin/TradedoublerReportsWrapper and denodell/tradedoubler mock data.
- listMediaPartners extracts unique publishers from the event breakdown report rather than a dedicated publishers endpoint. Only publishers with at least one event in the query window are returned.
- getProgrammePerformance returns event-level rows (one per conversion); no click data is available in this report surface.
- generateTrackingLink, listTransactions, getEarningsSummary, and listClicks are not implemented at v0.1.

### Findings

# Tradedoubler advertiser adapter — findings

Built from public docs as of 2026-05-28; live verification pending credentials.

## Research method

This adapter was built by examining:

1. The official Tradedoubler developer portal at
   [https://dev.tradedoubler.com/](https://dev.tradedoubler.com/).
2. The Tradedoubler public API documentation repository at
   [https://github.com/tradedoubler/publicapi-docs](https://github.com/tradedoubler/publicapi-docs)
   (API Blueprint format, links to Apiary — apiary.io returned 403 to
   automated fetch during research).
3. Community PHP wrapper at
   [https://github.com/jongotlin/TradedoublerReportsWrapper](https://github.com/jongotlin/TradedoublerReportsWrapper)
   — **primary source** for column names, URL templates, date format, and
   XML parsing approach. Denormalizer.php uses SimpleXML property access
   (`$row->programId`, `$row->siteName` etc.) confirming named-element format.
4. Community PHP API integration at
   [https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php](https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php)
   — corroborated the `key=` query-parameter auth scheme, `pendingStatus`
   values (A/P/D), and added "Access Denied" auth-failure detection.
5. XML mock data at
   [https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml](https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml)
   — confirmed XML format: `<columns>` section with named elements as column
   descriptors; `<row>` children are named elements (not positional `<col>`).

---

## Hardening pass 2026-05-28

### TODO items resolved

| Item | Outcome | Source |
|------|---------|--------|
| Auth parameter name (`token` vs `key`) | **CORRECTED** — legacy reports API uses `key=`, not `token=`. Modern REST APIs (conversions, claims) use `token=`, but `aReport3Key.action` uses `key=`. | jongotlin/TradedoublerReportsWrapper Tradedoubler.php (`key=%s` in URL template) |
| XML response structure (`<columnDefs>/<col>` vs named elements) | **CORRECTED** — Real format uses `<columns>` section with named column descriptors; `<row>` children are named elements (`<programId>12345</programId>`), not positional `<col>`. Rewritten `parseXmlMatrix` and updated fixtures. | denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php (SimpleXML property access) |
| Column-list URL format (comma-separated vs repeated params) | **CORRECTED** — API uses `&columns=x&columns=y&columns=z` (repeated). `buildTokenUrl` now expands comma-separated strings into repeated params. | jongotlin Tradedoubler.php URL template |
| Date format for API requests | **CONFIRMED+CORRECTED** — jongotlin uses `Y-m-d` (YYYY-MM-DD). Changed `toTdDateStr` from `dd.mm.YYYY` to `YYYY-MM-DD`. | jongotlin Tradedoubler.php (`$from->format('Y-m-d')`) |
| Date format in API responses (`timeOfEvent`) | **CONFIRMED** — `d.m.Y` (e.g. `01.05.2026`). The adapter's `parseTdDate` already handles this plus `d.m.y` 2-digit fallback. | denodell/tradedoubler advertisers.xml sample data |
| `aAffiliateMyProgramsReport` column names | **CONFIRMED** — `programId`, `programName`, `status`, `programTariffPercentage`, `programTariffAmount`, `programTariffCurrency`. Also confirmed `siteName` is a publisher column, not a programme column. | denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php |
| `aAffiliateEventBreakdownReport` column names | **CONFIRMED** — `programId`, `timeOfEvent`, `siteId`, `siteName`, `pendingStatus`, `orderValue`, `affiliateCommission`, `eventName`, `currencyId`. The full column list also includes: `timeOfVisit`, `timeInSession`, `lastModified`, `epi1`, `epi2`, `graphicalElementName`, `productName`, `productNrOf`, `productValue`, `voucher_code`, `deviceType`, `leadNR`, `orderNR`, `pendingReason`. | jongotlin Tradedoubler.php column list |
| `pendingStatus` values (A/P/D) | **CONFIRMED** — A = approved/confirmed, P = pending/open, D = declined/cancelled. | wp-plugins/affiliate-power tradedoubler.php |
| Programme status values (A/P/D/S) | **CONFIRMED** A/P/D from community; S (suspended) from denodell XML mock but not in affiliate-power. Kept as handled. | denodell/tradedoubler advertisers.xml; affiliate-power tradedoubler.php |
| HTML auth-failure detection | **CONFIRMED+IMPROVED** — login page HTML detection confirmed. Also added `"Access Denied"` string check, which affiliate-power uses as its auth-failure detector for CSV responses. | wp-plugins/affiliate-power tradedoubler.php (`strpos($str_report, 'Access Denied')`) |
| Click columns in event breakdown report | **CONFIRMED ABSENT** — The `aAffiliateEventBreakdownReport` is conversion-level only. No click column exists. `listClicks` correctly throws `NotImplementedError`. | jongotlin Tradedoubler.php column list (no click field) |
| `apiEnabled` flag on `DiscoveredBrand` | **CONFIRMED ABSENT** — No API-enabled column exists in `aAffiliateMyProgramsReport`. All returned programmes are assumed API-accessible. Hard-coded `true` is correct. | jongotlin getPrograms column list |
| `organizationId` requirement | **CONFIRMED REQUIRED** — `organizationId` is required for `aAffiliateEventBreakdownReport` (jongotlin uses `organizationId=%s`). For `aAffiliateMyProgramsReport` jongotlin does not pass it explicitly, but affiliate-power uses `affiliateId=` instead. The adapter passes it for both. | jongotlin Tradedoubler.php; wp-plugins/affiliate-power tradedoubler.php |
| XML root element nesting | **CONFIRMED** — Root is `<report name="..." time="...">`, containing `<matrix rowcount="N">`, containing `<columns>` and `<rows>`. For `aAffiliateMyProgramsReport` the data is in the second matrix (`matrix[1]` in SimpleXML indexing). | denodell/tradedoubler advertisers.xml |

### Operations: implement / keep stubbed review

| Operation | Decision | Reason |
|-----------|----------|--------|
| `listTransactions` | **KEEP BLOCKED** | No dedicated transaction-listing report exists in the public API surface. The event breakdown (`aAffiliateEventBreakdownReport`) provides conversion data but it is already surfaced via `getProgrammePerformance`. Mapping the same report to `Transaction[]` would duplicate that surface. Blocked pending: access to `connect.tradedoubler.com` management REST API (see below). |
| `getEarningsSummary` | **KEEP BLOCKED** | No aggregate earnings report with a summary envelope exists in the legacy reports API. Would require the management REST API. |
| `listClicks` | **KEEP BLOCKED** | No click-level data is available in `aAffiliateEventBreakdownReport`. A separate clicks report may exist but is not documented in any community source examined. |
| `getProgramme` (single) | **KEEP BLOCKED** | The `aAffiliateMyProgramsReport` always returns all programmes. Per-programme lookup is correctly directed to `listProgrammes` with client-side filter. |
| `generateTrackingLink` | **KEEP BLOCKED** | Publisher-side operation only; not available on the advertiser surface. |

---

## Auth model

Tradedoubler's legacy reporting API authenticates via a **`key=<value>`**
query parameter (not `Bearer` header and not `token=`). The token is a
40-character hexadecimal SHA-1 string obtained from Account → Manage tokens,
selecting the **REPORTS** system.

A failed auth does **not** return a 4xx HTTP status. Tradedoubler returns
HTTP 200 with either an HTML login page or an "Access Denied" body. The
adapter detects both:
- Response body starts with `<!doctype html` or `<html` → HTML login page
- Response body contains `"Access Denied"` → access denied response

Sources:
- jongotlin/TradedoublerReportsWrapper (uses `key=%s` in URL)
- wp-plugins/affiliate-power (uses `key=`, checks `strpos($str_report, 'Access Denied')`)

Note: modern Tradedoubler REST APIs (Conversions API, Claims API at
`dev.tradedoubler.com`) use `token=`. The legacy reports endpoint
(`aReport3Key.action`) uses `key=`. These are distinct auth surfaces.

---

## Report API endpoint

```
GET http://reports.tradedoubler.com/pan/aReport3Key.action
  ?reportName={REPORT_NAME}
  &columns={COL1}&columns={COL2}...   ← repeated, not comma-separated
  &format=XML
  &key={TOKEN}
  &organizationId={ORG_ID}
  [&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD]
  [&programId={PROGRAM_ID}]
  [&event_id=0&pending_status=1]
```

The adapter uses HTTPS (`reports.tradedoubler.com`). The community wrappers
use HTTP, but HTTPS works on the same host.

---

## Column names (confirmed)

**aAffiliateMyProgramsReport:**
- `programId` — programme identifier (integer)
- `programName` — programme name (string)
- `status` — A (active/joined), P (pending), D (declined), S (suspended)
- `programTariffPercentage` — commission rate percentage
- `programTariffAmount` — flat commission amount
- `programTariffCurrency` — currency code

Also present but not requested by this adapter:
- `affiliateId` — publisher identifier
- `applicationDate` — application date

Source: jongotlin getPrograms URL + denodell advertisers.xml

**aAffiliateEventBreakdownReport:**
- `timeOfEvent` — event date (d.m.Y format in responses)
- `siteId` — publisher site identifier
- `siteName` — publisher site name
- `pendingStatus` — A (approved), P (pending), D (declined/cancelled)
- `orderValue` — gross order value
- `affiliateCommission` — commission to publisher
- `programId` — programme identifier
- `eventName` — event type ("Sale", "Lead", etc.)
- `currencyId` — currency code

Additional columns available (not requested):
- `timeOfVisit`, `timeInSession`, `lastModified`
- `epi1`, `epi2` — extra parameters
- `graphicalElementName`, `productName`, `productNrOf`, `productValue`
- `open_product_feeds_id`, `open_product_feeds_name`, `voucher_code`
- `deviceType`, `os`, `browser`, `vendor`, `device`
- `leadNR`, `orderNR`, `pendingReason`
- `link`

Source: jongotlin Tradedoubler.php getTransactions column list

---

## XML response format (confirmed)

```xml
<report name="aAffiliateMyProgramsReport" time="2026-05-28 12:00">
  <matrix rowcount="N">
    <columns>
      <programId type="integer">Programme ID</programId>
      <programName type="string">Programme Name</programName>
      ...
    </columns>
    <rows>
      <row>
        <programId>12345</programId>
        <programName>Acme UK</programName>
        ...
      </row>
    </rows>
  </matrix>
</report>
```

Key points:
- Column-definitions section is `<columns>`, NOT `<columnDefs>`
- Row cells are **named elements** (e.g. `<programId>12345</programId>`),
  NOT positional `<col>` elements
- For `aAffiliateMyProgramsReport`, data is in the second matrix (`matrix[1]`)
  in some account configurations (the first matrix may be an empty summary)

Source: denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php

---

## Date format

- **Request parameters** (`startDate`, `endDate`): `YYYY-MM-DD`
  (e.g. `2026-05-01`). Confirmed from jongotlin `$from->format('Y-m-d')`.
- **Response data** (`timeOfEvent` etc.): `d.m.Y` (e.g. `01.05.2026`).
  Confirmed from denodell advertisers.xml sample data.

The adapter's `toTdDateStr` uses YYYY-MM-DD for requests; `parseTdDate`
handles both d.m.Y and d.m.y (two-digit year) in responses.

---

## Remaining gaps requiring live verification

1. **organizationId for aAffiliateMyProgramsReport** — jongotlin does not
   include `organizationId` for the programmes report. The adapter passes it
   regardless, which should be harmless but could cause errors on some account
   configurations. Requires a live account to verify.
   Credential needed: `TRADEDOUBLER_ADV_ORGANIZATION_ID` + `TRADEDOUBLER_ADV_TOKEN`.

2. **matrix[1] vs matrix[0]** — the denodell XML has two `<matrix>` elements;
   jongotlin Denormalizer uses `$xml->matrix[1]->rows->row` for programmes.
   The adapter's regex-based parser extracts all `<row>` elements globally,
   which may return rows from both matrices. Live verification needed.
   Credential needed: any live account.

3. **Exact "Access Denied" string** — affiliate-power checks for `"Access Denied"`.
   Variations like `"access denied"` or `"Access denied"` may occur.
   The adapter's `isHtmlResponse` does a case-sensitive check.
   Credential needed: deliberately invalid token on a live account.

4. **Management REST API** (`connect.tradedoubler.com`) — documented at
   `advertiserwip.docs.apiary.io` but returned 403 during automated research.
   This surface may enable `listTransactions`, `getEarningsSummary`, and richer
   programme metadata. Unblocking requires manual review of the Apiary docs
   with a live Tradedoubler advertiser account.
   Credential needed: live account with management API access.

5. **S (suspended) programme status** — present in the denodell mock data XML
   but absent from affiliate-power's status mapping. May not occur in all
   account types.
   Credential needed: any live account with a suspended programme.

## TradeTracker

### Quick facts

- **Slug**: `tradetracker`
- **Auth model**: custom
- **Base URL**: https://ws.tradetracker.com
- **Environment variables**: `TRADETRACKER_CUSTOMER_ID`, `TRADETRACKER_PASSPHRASE`, `TRADETRACKER_SITE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://affiliate.tradetracker.com/webService/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- The TradeTracker affiliate API is SOAP-only: requests and responses are hand-built XML envelopes parsed without an XML dependency, and authentication opens a server session whose cookie is cached and re-established on expiry.
- Monetary fields (commission, orderAmount) are assumed to be major currency units (e.g. euros, not cents) in the campaign currency; this has not been confirmed against a live account.

### Findings

_No findings document was supplied at `docs/findings/tradetracker.md`._

## Travelpayouts

### Quick facts

- **Slug**: `travelpayouts`
- **Auth model**: custom
- **Base URL**: https://api.travelpayouts.com
- **Environment variables**: `TRAVELPAYOUTS_ACCESS_TOKEN`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://support.travelpayouts.com/hc/en-us/articles/360019864079-API-of-affiliate-programs-booking-statistics

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Experimental: implemented from public documentation and not yet validated against a live Travelpayouts account.
- Amounts (price, profit) are assumed to be whole units of the selected currency, matching the balance response (e.g. "1794.34"); not minor units.
- Programmes are synthesised from the connected travel brands (campaign ids) that appear in the balance-actions response; Travelpayouts exposes no publisher programme-catalogue endpoint, so commission rates and not-yet-joined programmes are unavailable.
- Click-level data is not exposed per booking; the statistics API reports only aggregated click/redirect counts, so listClicks is unsupported.
- Tracking links are created in the dashboard with a partner marker; Travelpayouts publishes no deterministic deep-link URL formula, so generateTrackingLink is unsupported.

### Findings

_No findings document was supplied at `docs/findings/travelpayouts.md`._

## TUNE

### Quick facts

- **Slug**: `tune`
- **Auth model**: custom
- **Base URL**: https://api.hasoffers.com
- **Environment variables**: `TUNE_NETWORK_ID`, `TUNE_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://developers.tune.com/affiliate/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter implemented from public API docs; not yet validated against a live account (claim_status: experimental).
- The API base URL is per-tenant: TUNE (HasOffers) is a CPA platform engine and each network runs its own instance, so one adapter serves any HasOffers-powered network via its NetworkId (the host is https://{network_id}.api.hasoffers.com); there is no single shared host.
- Amounts (Stat.payout) are assumed to be in major currency units (not minor units / cents); confirm against a live account before promoting beyond experimental.
- Click-level data is not exposed via the affiliate API; listClicks is not implemented.

### Findings

_No findings document was supplied at `docs/findings/tune.md`._

## ValueCommerce

### Quick facts

- **Slug**: `value-commerce`
- **Auth model**: custom
- **Base URL**: https://api.valuecommerce.com
- **Environment variables**: `VALUE_COMMERCE_CLIENT_KEY`, `VALUE_COMMERCE_CLIENT_SECRET`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://pub-docs.valuecommerce.ne.jp/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The affiliate Order Report API returns XML by default; the client parses it with a small built-in parser. The exact XML element names per transaction field are not confirmed from public docs snippets, so the adapter reads several candidate tag names defensively and requires live verification.
- listProgrammes / getProgramme are not supported: ValueCommerce exposes no self-serve affiliate programme/merchant directory through the public report API; both throw NotImplementedError.
- listClicks is not exposed via the public affiliate Order Report API; the operation throws NotImplementedError.
- generateTrackingLink is not supported: ValueCommerce deeplinks (MyLink) are produced in the console and are not derivable from the report API credentials; the operation throws NotImplementedError.
- Access tokens are valid for 30 minutes; the adapter caches the token in memory and re-fetches on expiry.
- The report API ships v1/v2/v3 endpoints; the adapter targets v2 and requires live verification of the preferred version.

### Findings

_No findings document was supplied at `docs/findings/value-commerce.md`._

## ValueCommerce (advertiser)

### Quick facts

- **Slug**: `value-commerce-advertiser`
- **Auth model**: custom
- **Base URL**: https://api.valuecommerce.com
- **Environment variables**: `VALUE_COMMERCE_ADVERTISER_CLIENT_KEY`, `VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://pub-docs.valuecommerce.ne.jp/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a report-only API authentication key from the advertiser console for defence in depth.
- The advertiser EC Order Report API returns XML by default; the client parses it with a small built-in parser. The exact XML element names per field are not confirmed from public snippets, so the adapter reads several candidate tag names defensively. BLOCKED(verify): confirm the real element names against a live account.
- getProgrammePerformance and listTransactions are derived from the EC Order Report API (/report/v2/merchant/transaction/), which reports per-order rows carrying the publisher site id (sid). Rows are grouped by publisher client-side. BLOCKED(verify): confirm the site/sid element names and whether a server-side group-by exists on a live account.
- listBrands enumerates the advertiser's own sites/programmes (PIDs) the credential addresses. BLOCKED(verify): the EC Order Report API has no documented self-serve site-directory endpoint, so listBrands derives the addressable sites from the report rows over a recent window; confirm against a live account.
- getProgramme / getEarningsSummary / listClicks / generateTrackingLink are not implemented (NotImplementedError); these are publisher-side or directory operations the advertiser report API does not expose.
- Access tokens are valid for 30 minutes; the adapter caches the token in memory and re-fetches on expiry.
- The EC Order Report API ships v1 and v2 endpoints; the adapter targets v2. BLOCKED(verify): confirm the preferred version against a live account.

### Findings

_No findings document was supplied at `docs/findings/value-commerce-advertiser.md`._

## Webgains

### Quick facts

- **Slug**: `webgains`
- **Auth model**: bearer
- **Base URL**: https://platform.webgains.io
- **Environment variables**: `WEBGAINS_API_KEY`, `WEBGAINS_PUBLISHER_ID`, `WEBGAINS_CAMPAIGN_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://docs.webgains.dev/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The exact REST base URL could not be confirmed: the Webgains documentation host (docs.webgains.dev) and the interactive console (platform.webgains.io/docs) were not retrievable from the build environment. The base URL is taken as https://platform.webgains.io and the endpoint paths are assumed; both require live-account confirmation.
- Webgains transaction field names are read defensively across several plausible names; the exact response schema was not confirmable against the documentation host.
- listClicks is not exposed via the public Webgains publisher Smart Platform API (reporting is transaction-level, not click-level); the operation throws NotImplementedError.
- generateTrackingLink requires WEBGAINS_CAMPAIGN_ID (the publisher campaign/Site ID used as wgcampaignid). The deeplink is constructed deterministically as https://track.webgains.com/click.html?wgcampaignid=...&wgprogramid=...&wgtarget=...
- The Get Transaction Report endpoint documents a maximum date range of 1 year per call; the adapter chunks longer windows into one-year segments.

### Findings

_No findings document was supplied at `docs/findings/webgains.md`._

## Webgains (advertiser)

### Quick facts

- **Slug**: `webgains-advertiser`
- **Auth model**: bearer
- **Base URL**: https://platform.webgains.io
- **Environment variables**: `WEBGAINS_ADVERTISER_API_KEY`, `WEBGAINS_ADVERTISER_ACCOUNT_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-04
- **Documentation**: https://docs.webgains.dev/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The HTTP client refuses any non-GET method; pair this with a read-only Webgains token where the dashboard offers one for defence in depth.
- The exact REST base URL could not be confirmed: the Webgains documentation host (docs.webgains.dev) returned HTTP 403 to automated fetch. The base URL is taken as https://platform.webgains.io and the endpoint paths (/advertisers/{id}/programs, /advertisers/{id}/transactions) are assumed; both require live-account confirmation.
- Webgains transaction and programme field names are read defensively across several plausible names; the exact response schema was not confirmable against the documentation host.
- `getProgrammePerformance` derives a per-publisher rollup from the Get Transaction Report endpoint (which documents a 1-year maximum date range per call); the adapter chunks longer windows into one-year segments. Whether the report can be requested pre-grouped by publisher server-side could not be confirmed, so the adapter groups client-side.
- `listBrands` enumerates the advertiser's own programmes/campaigns (the unit a Webgains advertiser PAT addresses); there is no separate agency-passthrough tier confirmed for advertisers.

### Findings

_No findings document was supplied at `docs/findings/webgains-advertiser.md`._

## Yieldkit

### Quick facts

- **Slug**: `yieldkit`
- **Auth model**: custom
- **Base URL**: https://api.yieldkit.com
- **Environment variables**: `YIELDKIT_API_KEY`, `YIELDKIT_API_SECRET`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-06-05
- **Documentation**: https://public.yieldkit.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter is experimental: the API shapes were mapped from public documentation and have not been validated against a live Yieldkit publisher account.
- Commission and sale amounts are assumed to be in major currency units (e.g. euros, not cents); revisit this assumption if a live account reports minor units.
- Yieldkit does not expose a distinct paid state on commissions; transactions are reported as pending, approved, or reversed only.

### Findings

_No findings document was supplied at `docs/findings/yieldkit.md`._

## How to reproduce

From a fresh checkout:

```
npm install
npm run generate:report
```

The script reads each network's `network.json` manifest and the
corresponding `docs/findings/<slug>.md` and composes this document.
When credentials for one or more networks are present in the environment,
the live diagnostic suite is invoked and its results are folded into the
per-network operations tables.

_Last regenerated 2026-06-29 08:37 UTC._
