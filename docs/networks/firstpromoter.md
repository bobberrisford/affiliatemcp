# Setting up affiliate-mcp with FirstPromoter (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Afirstpromoter%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your FirstPromoter account. You will end up with two values written to
`~/.affiliate-mcp/.env`: `FIRSTPROMOTER_API_KEY` and `FIRSTPROMOTER_ACCOUNT_ID`.

FirstPromoter is a referral and affiliate platform run by the merchant (the
brand). This adapter is the advertiser side: it reads your own programme — the
campaigns, the promoters running them, the referrals they bring, and the
commissions owed. There is no publisher side.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the FirstPromoter dashboard is shown alongside; label
wording can change between dashboard refreshes, so the layout is described too.

## Prerequisites

- A FirstPromoter account you can sign in to as an admin. If you can open your
  FirstPromoter dashboard and see Settings, you have what you need.
- API access on a FirstPromoter account does not require a separate approval
  step. As long as your account is active, you can generate an API key on
  demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `FIRSTPROMOTER_API_KEY` — the v2 API key. Sent as the HTTP Bearer token
  (`Authorization: Bearer <key>`) on every request.
- `FIRSTPROMOTER_ACCOUNT_ID` — your numeric account id. Sent in the
  `ACCOUNT-ID` request header. It identifies which FirstPromoter account the
  key belongs to; v2 requires both values together.

Both values come from the same dashboard screen.

## Setup steps

1. Sign in to your FirstPromoter dashboard as an admin.

2. Open *Settings*.

3. In Settings, open *Integrations*, then *Manage API Keys*.

4. Copy the *API key* shown on this screen. This is `FIRSTPROMOTER_API_KEY`.
   Treat it as a secret — it grants full access to your account data.

5. On the same *Manage API Keys* screen, note the numeric *account id* shown
   next to the key. This is `FIRSTPROMOTER_ACCOUNT_ID`.

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **FirstPromoter** when prompted. Paste the API key when the wizard asks for
   `FIRSTPROMOTER_API_KEY`, then enter the account id when it asks for
   `FIRSTPROMOTER_ACCOUNT_ID`.

## What success looks like

The wizard validates the pair against the `/api/v2/company/promoters` endpoint
and writes the two values to `~/.affiliate-mcp/.env` with file permissions
`0600`. From that point on, `affiliate-networks-mcp test firstpromoter` should
report `ok` for the supported operations. `listClicks` and
`generateTrackingLink` are reported as unsupported by design (see Known
limitations).

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating

The API key was copied with surrounding whitespace, was truncated, has been
regenerated, or the account id does not match the key. Re-open *Settings ›
Integrations › Manage API Keys*, confirm the key is still listed, and paste it
without leading or trailing spaces. Confirm the account id is the numeric value
shown on the same screen.

### Failure: the API key validates but the account id is rejected

The v2 API requires the `ACCOUNT-ID` header on every request, and it must be
the numeric account id from the *Manage API Keys* screen — not your e-mail, not
a campaign id, and not a promoter id. Re-check the value on the dashboard.

### Failure: `listClicks` or `generateTrackingLink` report unsupported

This is expected, not a misconfiguration. FirstPromoter's v2 admin API exposes
aggregate click counts in reports rather than raw click records, and referral
links belong to individual promoters rather than being minted per-destination
by the merchant API. See Known limitations.

## Known limitations

- This adapter was implemented from the public API documentation and has not
  yet been validated against a live account; its claim status is
  `experimental`. Field names on the commission, promoter, campaign, and
  referral objects, and the amount unit, are read defensively and the verbatim
  upstream payload is preserved on `rawNetworkData`.
- Monetary amounts are assumed to be integer minor units (cents) and converted
  to major units on the way out. This assumption follows FirstPromoter's
  documented tracking convention but is not yet confirmed against a live
  account.
- `listClicks` is unsupported: the v2 admin API exposes aggregate click counts
  in reports, not raw click records.
- `generateTrackingLink` is unsupported: referral links belong to individual
  promoters; the merchant API does not mint per-destination links.
- `getProgrammePerformance` is computed locally from `/commissions` grouped by
  promoter and day. Clicks are not available from that endpoint and are
  reported as `0`.
- This is an advertiser, single-brand adapter: one API key and account id pair
  scopes one FirstPromoter account. Bind your single brand in `brands.json`
  manually.
- Wide pulls follow the `Link` header (`rel="next"`) page by page, capped with a
  warning rather than a silent truncation. FirstPromoter rate-limits the API
  and returns HTTP 429, which the resilience layer retries.

## Verifying

```
affiliate-networks-mcp test firstpromoter
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- firstpromoter`. The diagnostic engine's pass is the
verification contract.
