# Setting up affiliate-mcp with eHUB (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aehub%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your eHUB publisher account. eHUB is a CZ/CEE affiliate network. You
will end up with two values written to `~/.affiliate-mcp/.env`: `EHUB_API_KEY`
and `EHUB_PUBLISHER_ID`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the layout is described alongside, because dashboard wording can change
and parts of the eHUB interface are localised (Czech / English).

This adapter is **experimental**: it was implemented from eHUB's public API
documentation and has not yet been validated against a live account. See the
known limitations below and `REPORT.md` for the current status.

## Prerequisites

- An approved eHUB publisher account. If you can sign in at
  [https://ehub.cz/](https://ehub.cz/) and see your publisher statistics
  (Transactions, Clicks, Reports), you have what you need.
- eHUB API access does not require a separate approval step beyond having an
  active publisher account; you generate the API key yourself.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `EHUB_API_KEY` — your eHUB API key. eHUB API v3 authenticates by passing this
  value as the `apiKey` parameter on every request. Generate or copy it from
  the API section of your eHUB profile / account settings.
- `EHUB_PUBLISHER_ID` — your eHUB publisher ID, the `a_aid` value. It is shown
  in your profile and is embedded in your tracking links (for example
  `a_aid=412289c2` in a `click.php` link). It is required only to build
  tracking links; the other operations work without it.

## Setup steps

1. Sign in to eHUB at [https://ehub.cz/](https://ehub.cz/) with the same
   credentials you use to read your performance reports.

2. Open your profile / account settings and find the API section. Generate an
   API key if you do not already have one, then copy its value.

3. Note your publisher ID (the `a_aid` value). It appears in your profile and
   in any tracking link you have already generated, after `a_aid=`.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **eHUB** when prompted. Paste the API key when the wizard asks for
   `EHUB_API_KEY`, then enter your publisher ID for `EHUB_PUBLISHER_ID`.

## What success looks like

The wizard validates the API key against the eHUB campaigns endpoint and writes
the two values to `~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test ehub` should report `ok` for the supported
operations.

### Environment variables

- `EHUB_API_KEY` — the eHUB API key, sent as the `apiKey` query parameter.
- `EHUB_PUBLISHER_ID` — your `a_aid` publisher ID, used to build tracking links.

## Common failures

### Failure: the wizard reports an authentication error when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
revoked. Re-open the API section of your eHUB profile and confirm the key is
still listed; if it is not, generate a new one. Paste it into the wizard
without any leading or trailing spaces.

### Failure: tracking-link generation reports a missing publisher ID

`generateTrackingLink` requires `EHUB_PUBLISHER_ID` (your `a_aid`). If you
skipped that prompt, re-run `npx affiliate-networks-mcp setup ehub` and enter
the value, or set it manually in `~/.affiliate-mcp/.env`.

### Failure: transaction amounts look 100x too large or too small

This adapter assumes eHUB returns monetary amounts in major currency units
(for example 199.00 CZK). If your account shows amounts off by a factor of 100,
that assumption is wrong for your tenant; please file a finding so the adapter
can be corrected.

## Known limitations

These mirror `known_limitations` in `src/networks/ehub/network.json`:

- The adapter was implemented from eHUB's public API documentation and has not
  yet been validated against a live account (`claim_status: experimental`).
- Monetary amounts (`totalCost`, `commission`) are assumed to be major currency
  units (for example CZK), not minor units. Revisit if live data is off by 100x.
- `generateTrackingLink` treats the supplied `programmeId` as the eHUB creative
  / banner id (`a_bid`) and requires `EHUB_PUBLISHER_ID` (`a_aid`). eHUB
  tracking links are keyed on a creative id rather than the campaign id itself.

Unlike some networks in this repository, eHUB **does** expose click-level data,
so `listClicks` is implemented rather than stubbed.

## Verifying

```
affiliate-networks-mcp test ehub
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- ehub`. Because this adapter is experimental, treat
a passing diagnostic as confirmation the request/response shapes match the
documentation, not as a production guarantee.

## API reference

- eHUB API v3 on Apiary: [https://ehub.docs.apiary.io/](https://ehub.docs.apiary.io/)
- Alternative Apiary host: [https://ehubv3.docs.apiary.io/](https://ehubv3.docs.apiary.io/)
- Base URL: `https://api.ehub.cz/v3`
