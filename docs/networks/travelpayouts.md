# Setting up affiliate-mcp with Travelpayouts (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Atravelpayouts%22)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Travelpayouts account. You will end up with one value written
to `~/.affiliate-mcp/.env`: `TRAVELPAYOUTS_ACCESS_TOKEN`.

Travelpayouts is a global travel affiliate network. As a partner you promote
several connected travel brands (such as Aviasales and Hotellook) and are paid
a commission per confirmed booking. One personal API token addresses your whole
account, so there is no separate per-brand login or account id to configure.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the Travelpayouts dashboard is shown in italics; label
wording can change between dashboard refreshes, so the layout is described
alongside.

This adapter is **experimental**: it was implemented from the public
Travelpayouts documentation and has not yet been validated against a live
account. Treat the figures it returns as unconfirmed until you have checked them
against your dashboard.

## Prerequisites

- A Travelpayouts partner account. If you can sign in at
  [https://www.travelpayouts.com/](https://www.travelpayouts.com/) and see your
  dashboard, you have what you need.
- API access does not require a separate approval step. As long as your account
  is active, you can generate an API token on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `TRAVELPAYOUTS_ACCESS_TOKEN` — your personal API token from the *Profile* page.
  It is sent on every request in the `X-Access-Token` header.

## Setup steps

1. Sign in to Travelpayouts at
   [https://www.travelpayouts.com/](https://www.travelpayouts.com/).

2. Open your *Profile* from the user menu in the top-right corner of the
   dashboard.

3. Find the *API token* section on the Profile page. Copy the token value. If no
   token is shown, generate one from the same section.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Travelpayouts** when prompted. Paste the token when the wizard asks for
   `TRAVELPAYOUTS_ACCESS_TOKEN`.

## What success looks like

The wizard validates the token against the `finance/v2/get_user_balance`
endpoint, reports the currencies your balance is held in, and writes the value
to `~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test travelpayouts` should report `ok` for
`verifyAuth`, `listProgrammes`, `listTransactions`, and `getEarningsSummary`,
and report `listClicks` and `generateTrackingLink` as unsupported (see Known
limitations).

## Common failures

### Failure: the wizard reports `401` when validating the token

The token was copied with surrounding whitespace, was truncated, or has been
regenerated. Re-open the *Profile* page, confirm the token shown there matches,
and paste it into the wizard without leading or trailing spaces.

### Failure: `listProgrammes` returns nothing

Programmes are synthesised from the connected travel brands that appear in your
balance-actions history (see Known limitations). If your account has no bookings
yet, there are no campaigns to synthesise from and the list is empty. This is
expected for a new account, not an error.

### Failure: the commission figures look off by orders of magnitude

The adapter assumes booking values and commissions are reported in whole units
of the selected currency (matching the balance response, e.g. `1794.34`). If a
future Travelpayouts change moves to minor units, the figures would be inflated.
Compare one booking against your dashboard and raise an issue if they disagree.

## Known limitations

These mirror `known_limitations` in `network.json`.

- **Experimental.** Implemented from public documentation and not yet validated
  against a live Travelpayouts account.
- **Amount unit assumption.** Booking value (`price`) and commission (`profit`)
  are assumed to be whole units of the selected currency, matching the balance
  response (for example `1794.34`), not minor units.
- **Synthesised programmes.** Travelpayouts exposes no publisher
  programme-catalogue endpoint. Programmes are synthesised from the connected
  travel brands (campaign ids) that appear in the balance-actions response, so
  commission rates and not-yet-joined programmes are unavailable, and every
  synthesised programme is reported with status `joined`.
- **No click-level data.** The statistics API reports only aggregated
  click/redirect counts, not per-click rows, so `listClicks` is unsupported.
- **No deterministic tracking links.** Tracking links are created in the
  dashboard with a partner marker; Travelpayouts publishes no deterministic
  deep-link URL formula, so `generateTrackingLink` is unsupported.

## Verifying

```
affiliate-networks-mcp test travelpayouts
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- travelpayouts`. The diagnostic engine's pass is the
verification contract.

## Reference

- Booking statistics API:
  [support.travelpayouts.com/hc/en-us/articles/360019864079](https://support.travelpayouts.com/hc/en-us/articles/360019864079-API-of-affiliate-programs-booking-statistics)
- Balance and payment API:
  [support.travelpayouts.com/hc/en-us/articles/5169505760402](https://support.travelpayouts.com/hc/en-us/articles/5169505760402-API-of-affiliates-balance-and-payment)
- Travel data API reference (Slate):
  [travelpayouts.github.io/slate](https://travelpayouts.github.io/slate/)
