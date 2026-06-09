# Setting up affiliate-mcp with AccessTrade (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aaccesstrade%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your AccessTrade publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `ACCESSTRADE_ACCESS_KEY` and
`ACCESSTRADE_SITE_ID`.

AccessTrade (operated by Interspace) is a CPA affiliate network covering Japan
and South-East Asia. No prior API experience is assumed.

## Prerequisites

- An approved AccessTrade publisher account for your country. If you can sign in
  to the publisher dashboard and see your sites and campaigns, you have what you
  need.
- At least one registered website (site). Campaign and product-feed endpoints
  are scoped to a single site.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `ACCESSTRADE_ACCESS_KEY` — your publisher API access key, copied from your
  profile page in the dashboard. It is sent on every request as the
  `Authorization: Token <access_key>` header.
- `ACCESSTRADE_SITE_ID` — the ID of one of your registered sites (websites).

## Setup steps

1. Sign in to the AccessTrade publisher dashboard for your country.

2. Open the **Websites** (sites) section and note the ID of the site you want to
   report on. This becomes `ACCESSTRADE_SITE_ID`.

3. Open your **profile page** (your account or profile settings) and copy the
   **API access key** shown there. This becomes `ACCESSTRADE_ACCESS_KEY`. The
   key is long-lived but can be regenerated from the same page, which revokes
   the previous key.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **AccessTrade** when prompted. Enter the site ID first, then paste the access
   key. The wizard validates the key against a site-scoped endpoint, so the site
   ID must be entered first.

## What success looks like

The wizard validates the access key by listing one affiliated campaign for your
site, then writes the two values to `~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test accesstrade` should report `ok` for
`listProgrammes`, `getProgramme`, `listTransactions`, `getEarningsSummary`, and
`verifyAuth`. `listClicks` and `generateTrackingLink` are reported as
unsupported (see Known limitations).

## Common failures

### Failure: the wizard reports `401` when validating the access key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated (which revokes the previous key). Re-open your profile page,
confirm the current key, and paste it without leading or trailing spaces.

### Failure: validating the access key fails before any network call

You entered the access key before the site ID. The key is validated against a
site-scoped endpoint, so enter `ACCESSTRADE_SITE_ID` first, then the key.

### Failure: wrong country / base URL

AccessTrade serves different API hosts by country. The adapter defaults to the
Indonesia / Malaysia / Singapore host (`https://gurkha.accesstrade.global`).
Publishers in Thailand or other regions must set `ACCESSTRADE_BASE_URL` to their
country's host (for example `https://gurkha.accesstrade.in.th` for Thailand)
before running setup. Symptoms of the wrong host are `404` responses or auth
failures despite a correct key.

## Known limitations

- This adapter was built from public API documentation and has not yet been
  verified against a live account; it ships as experimental.
- The reward/amount unit is assumed to be a major-unit decimal in the account
  currency. The documentation does not state the unit, so confirm against a live
  account.
- The conversion report is rate-limited to one request per five minutes and
  capped at a 7-day window. Wider ranges are chunked into 7-day slices
  automatically, which can take a while given the rate limit.
- Click-level data is not exposed via the publisher API, so `listClicks` is
  unsupported.
- Tracking links are produced in the AccessTrade dashboard, not via a documented
  deterministic scheme, so `generateTrackingLink` is unsupported.
- The API base URL differs by country; non-default countries must set
  `ACCESSTRADE_BASE_URL`.

## Verifying

```
affiliate-networks-mcp test accesstrade
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- accesstrade`. The diagnostic engine's pass is the
verification contract.

## References

- Report APIs: https://support.accesstrade.global/api/report-apis.html
- Campaign APIs: https://support.accesstrade.global/api/campaign-apis.html
- Product feed API: https://support.accesstrade.global/api/product-feed-api.html
- Authentication: https://support.accesstrade.global/api/how-do-i-authenticate-publisher-api-requests.html
- Publisher API (developer portal): https://developers.accesstrade.vn/
