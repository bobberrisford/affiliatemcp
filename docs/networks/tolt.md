# Setting up affiliate-mcp with Tolt (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Atolt%22)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Tolt account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `TOLT_API_KEY`.

Tolt is an affiliate and referral platform for SaaS startups. This adapter
integrates with the merchant (advertiser) side: it reads your own programmes,
the partners promoting them, and the commissions owed. There is no publisher
side. One API key scopes one Tolt organisation, so the adapter is
advertiser-side and single-brand.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording is taken from the Tolt dashboard; label wording can change
between dashboard refreshes, so the layout is described alongside.

## Prerequisites

- A Tolt account you can sign in to, with at least one programme configured.
- API access on a Tolt account does not require a separate approval step. As
  long as your account is active, you can read the API key from the dashboard.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

## Credentials needed

### `TOLT_API_KEY`

The API key is a Bearer token sent on every request. It grants full access to
your Tolt data, so keep it secret. Find it in Tolt under *Settings* →
*Integrations*.

## Setup steps

1. Sign in to your Tolt account.

2. Open *Settings*.

3. Open the *Integrations* tab.

4. Copy the *API key* shown there.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Tolt** when prompted. Paste the API key when the wizard asks for
   `TOLT_API_KEY`.

Because Tolt is advertiser-side and single-brand, you also bind your single
brand in `brands.json` manually, mapping a logical brand slug to this network.
The advertiser tools take a `brand` argument that the dispatcher resolves
through that binding.

## What success looks like

The wizard validates the key against the `/v1/partners` endpoint (the cheapest
authenticated call that returns 200 even with no partners) and writes the value
to `~/.affiliate-mcp/.env` with file permissions `0600`. From that point on,
`affiliate-networks-mcp test tolt` should report `ok` for the supported
operations.

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated. Re-open *Settings → Integrations* in Tolt and confirm the key is
still listed; if it is not, generate a new one. Paste it into the wizard
without any leading or trailing spaces.

### Failure: an advertiser tool reports a missing brand context

Advertiser-side tools require a `brand` argument that the dispatcher resolves
to a network brand id via `brands.json`. Bind your single brand there first,
then call the tool with that brand slug.

### Failure: amounts look off by a factor of one hundred

This adapter assumes Tolt returns monetary amounts in minor units (cents) and
divides by 100. This has not been confirmed against a live account. If your
figures look wrong, inspect `rawNetworkData` on a transaction to see the
verbatim upstream amount and raise an issue.

## Known limitations

These mirror `known_limitations` in `src/networks/tolt/network.json`.

- This adapter was implemented from the public API documentation and has not
  yet been validated against a live account. Its `claim_status` is
  `experimental`.
- The exact field names on the commission, partner, and programme objects, and
  the amount unit (assumed to be minor units / cents, divided by 100), have not
  been confirmed against a live account. Transformers read fields defensively
  and preserve the verbatim payload on `rawNetworkData`.
- Advertiser and single-brand: one API key scopes one Tolt organisation. Bind
  your single brand in `brands.json` manually.
- `listClicks` is unsupported: Tolt commissions carry no raw click records via
  this API.
- `generateTrackingLink` is unsupported: referral links belong to individual
  partners; the merchant API does not mint per-destination links.
- `getProgrammePerformance` is computed on the client from `/commissions`
  grouped by partner and day. Clicks are not available from `/commissions` and
  are reported as `0`.
- Pagination is cursor-based (`starting_after` plus a `has_more` flag) and is
  capped at a maximum page count, with a warning logged rather than a silent
  truncation.

## Verifying

```
affiliate-networks-mcp test tolt
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- tolt`. The diagnostic engine's pass is the
verification contract.

## Reference

- API documentation: <https://docs.tolt.com/introduction>
- Rate limits: <https://docs.tolt.com/rate-limit>
