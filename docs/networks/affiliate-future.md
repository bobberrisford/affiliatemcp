# Setting up affiliate-mcp with Affiliate Future (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Affiliate Future publisher account. You will end up with two
values written to `~/.affiliate-mcp/.env`: `AFFILIATE_FUTURE_API_KEY` and
`AFFILIATE_FUTURE_PASSWORD`.

Affiliate Future is a UK affiliate network. Its publisher API is served from
`https://api.affiliatefuture.com/PublisherService.svc/` and authenticates each
call with an API key and an API password carried as query parameters. There is
no token exchange.

No prior API experience is assumed. Where a step refers to a page or menu, the
wording from the Affiliate Future dashboard is shown; the layout can change
between dashboard refreshes, so the location is described alongside.

## Prerequisites

- An Affiliate Future publisher account. If you can sign in at
  [https://affiliates.affiliatefuture.com/](https://affiliates.affiliatefuture.com/)
  and see your publisher dashboard, you have what you need.
- API access does not require a separate approval step; the API key and
  password are shown on the Reporting APIs page once your account is active.

## Credentials needed

- `AFFILIATE_FUTURE_API_KEY` — the API key shown on the Reporting APIs page in
  the account dashboard.
- `AFFILIATE_FUTURE_PASSWORD` — the API password shown alongside the key on the
  same Reporting APIs page.

There is one optional value used only when building tracking links:

- `AFFILIATE_FUTURE_AFFILIATE_ID` — your numeric affiliate (publisher) ID,
  shown in the account dashboard. It is not part of the core credential set and
  is read only by `generateTrackingLink`. Set it by hand in
  `~/.affiliate-mcp/.env` if you intend to build links.

## Setup steps

1. Sign in to the Affiliate Future publisher dashboard at
   [https://affiliates.affiliatefuture.com/](https://affiliates.affiliatefuture.com/).

2. Open the Account menu and select the Reporting APIs page. This page lists
   the publisher reporting APIs together with the API key and API password for
   your account.

3. Copy the API key. Paste it into the wizard when it asks for
   `AFFILIATE_FUTURE_API_KEY`.

4. Copy the API password from the same page. Paste it into the wizard when it
   asks for `AFFILIATE_FUTURE_PASSWORD`. The wizard validates the key and
   password together against the Merchant List endpoint once both are entered.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Affiliate Future** when prompted.

## What success looks like

The wizard confirms that the key and password validated against the Merchant
List endpoint and writes the two values to `~/.affiliate-mcp/.env`. From that
point on, `affiliate-networks-mcp test affiliate-future` should report `ok` for
every operation except `listClicks` (Affiliate Future does not expose
click-level data via the publisher API).

## Common failures

### Failure: the wizard reports an authentication error when validating

The API key or password was mistyped, or copied with surrounding whitespace.
Re-open the Reporting APIs page in the dashboard and copy both values again,
without leading or trailing spaces. The key and password must both match the
values shown for your account.

### Failure: a transaction query over a wide window is slow

Affiliate Future limits transaction pulls to one day per call. The adapter
chunks the requested window into one-day slices and issues a separate call per
day, so a wide window makes many sequential calls and takes proportionally
longer. Narrow the window if you only need recent data.

### Failure: `generateTrackingLink` reports a missing affiliate ID

Tracking-link construction needs your numeric affiliate ID, which is not part
of the core credential set. Add `AFFILIATE_FUTURE_AFFILIATE_ID` to
`~/.affiliate-mcp/.env` with the affiliate ID shown in your dashboard.

## Known limitations

These mirror `known_limitations` in `network.json`:

- This adapter is experimental. It has not been validated against a live
  Affiliate Future publisher account, and the JSON response shapes are inferred
  from public documentation.
- The unit of `SaleValue` and `SaleCommission` is not stated in the public
  documentation. The adapter treats these as major currency units (for example
  pounds, not pence). The verbatim values are preserved on `rawNetworkData` so
  you can reconcile.
- Transaction pulls are limited to one day per call. `listTransactions` chunks
  the requested window into one-day slices and loops.
- The publisher API uses dated WCF (`.svc`) endpoints under
  `PublisherService.svc`. The adapter requests the JSON variant via the
  `Accept` header.
- Click-level data is not exposed via the publisher API, so `listClicks` is
  unsupported.

## Verifying

```
affiliate-networks-mcp test affiliate-future
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- affiliate-future`. The diagnostic engine's pass is
the verification contract.
