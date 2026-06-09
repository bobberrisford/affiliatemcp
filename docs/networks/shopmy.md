# Setting up affiliate-mcp with ShopMy (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Ashopmy%22)

This guide covers the credentials affiliate-mcp needs to talk to a ShopMy brand
partner account through ShopMy's Brand Partner API. You will end up with one
required value written to `~/.affiliate-mcp/.env`: `SHOPMY_API_TOKEN`, plus an
optional display label `SHOPMY_BRAND_NAME`.

This adapter is **experimental**. It has not been validated against a live
ShopMy brand partner account, and several details (the request header for the
token, the order-report field names, and the amount unit) are documented
assumptions. See "Known limitations" below before relying on the figures.

No prior API experience is assumed.

## Prerequisites

- A ShopMy brand partner account with Brand Partner API access. ShopMy issues
  one API token per brand; the token addresses that single brand.
- If you do not see an API or integrations section in your brand settings,
  ask your ShopMy partner manager to enable brand partner API access.

## Credentials needed

- `SHOPMY_API_TOKEN` — the brand partner token from the ShopMy brand dashboard.
  Required.
- `SHOPMY_BRAND_NAME` — an optional display label for your brand. It is only
  used to make the identity line readable in diagnostics and is never sent to
  ShopMy. Leave it unset to skip it.

## Setup steps

1. Sign in to your ShopMy brand account.
2. Open the brand settings and find the API or integrations section.
3. Generate (or copy) your brand partner token.
4. Run `npx affiliate-networks-mcp setup` and select **ShopMy** when prompted.
   Paste the token when the wizard asks for `SHOPMY_API_TOKEN`.
5. Optionally enter a brand label when asked for `SHOPMY_BRAND_NAME`, or leave
   it blank.

The wizard validates the token by making a one-record request to the order
report endpoint (`GET /v1/Partners/OrderReport`). A valid token returns a
result (which may be empty if the brand has no orders yet); an invalid token
returns `401`.

## Common failures

1. **`401 Unauthorized` when validating the token.** The token was copied with
   surrounding whitespace, has been revoked, or is scoped to a different brand.
   Re-open the API section in the ShopMy brand dashboard, confirm the token is
   still listed, and paste it without leading or trailing spaces.

2. **No API section in the brand dashboard.** Brand partner API access may not
   be enabled for your account. Contact your ShopMy partner manager to request
   it; this is an account setting on ShopMy's side, not something the wizard
   can change.

3. **Rate limit reached.** ShopMy enforces a daily limit of 200 requests on the
   order report endpoint. Wide date ranges are split into 31-day slices and
   paged, so a very large reporting window across many orders can consume
   several requests. If you hit the limit, narrow the date window or wait until
   the daily allowance resets.

## Known limitations

- **Experimental.** Not yet validated against a live ShopMy brand partner
  account; the auth header, order-report field names, and status mapping are
  unconfirmed assumptions.
- **Amount unit.** Order and commission amounts are assumed to be reported in
  integer cents and are divided by 100. Confirm the unit against a real account
  before relying on totals.
- **No click data.** Click-level data is not exposed via the Brand Partner API,
  so `listClicks` is unsupported.
- **No tracking-link creation.** Creating a ShopMy link requires the OAuth
  `write_links` developer API and an authenticated ShopMy user, which is a
  different credential model from the single-brand partner token used here.
  `generateTrackingLink` is therefore unsupported.
- **Single brand.** A brand partner token addresses one brand, so
  `listProgrammes` returns that single brand rather than a catalogue of
  merchants.

ShopMy moves an order through `pending` (return window open) to `locked`
(return window closed, eligible for payout) to `paid` (included in a weekly
payout). The adapter normalises these to `pending`, `approved`, and `paid`
respectively, and maps cancelled or returned orders to `reversed`.

## Verifying

```
affiliate-networks-mcp test shopmy
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- shopmy`. The diagnostic engine's pass is the
verification contract. Expect `listClicks` and `generateTrackingLink` to report
as unsupported, with the reasons above.
