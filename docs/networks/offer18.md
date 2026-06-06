# Setting up affiliate-mcp with Offer18 (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aoffer18%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Offer18 affiliate account. You will end up with four values written
to `~/.affiliate-mcp/.env`: `OFFER18_BASE_URL`, `OFFER18_API_KEY`,
`OFFER18_SECRET_KEY`, and `OFFER18_MID`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the Offer18 dashboard is shown in italics; label
wording can differ between Offer18-powered networks, so the layout is described
alongside.

## A note on Offer18 being a tenant engine

Offer18 is a tenant network engine: one parameterised API powers many different
affiliate networks, each running on its own instance host. There is therefore
**no single, fixed base URL**. The base URL is itself a credential. If your
network runs on the main Offer18 platform the host is `https://api.offer18.com`;
if your network operator runs a white-label instance, the host is the API host
they gave you. This adapter is `experimental`: it was built from the public
Offer18 API documentation and has not yet been verified against a live account.

## Prerequisites

- An active Offer18 affiliate account on an Offer18-powered network. If you can
  sign in to your network's affiliate dashboard, you have what you need.
- API access does not require a separate approval step on a standard Offer18
  instance: the API key, Secret key, and MID are available from your account
  settings as soon as the account is active.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Steps

1. Sign in to your Offer18 affiliate dashboard (the host your network operator
   gave you).

2. Open *Account* and then *Security*. This page holds your API credentials.

3. Note the *API key* shown in the API credentials panel. affiliate-mcp sends
   this as the `key` parameter on every affiliate API call.

4. Click *view* next to the *Secret key* to reveal it, then copy it.
   affiliate-mcp sends this as the `aid` (affiliate id) parameter.

5. Note your numeric *MID* (your network/advertiser account id), shown
   alongside the API credentials. affiliate-mcp sends this as the `mid`
   parameter.

6. Decide your base URL. If your network runs on the main Offer18 platform, use
   `https://api.offer18.com`. If your operator gave you a white-label API host,
   use that. This becomes `OFFER18_BASE_URL`.

7. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Offer18** when prompted. Enter the base URL, API key, Secret key, and MID
   when the wizard asks for them.

## What success looks like

The wizard validates the credentials by calling `GET {base}/api/af/offers` and
writes the four values to `~/.affiliate-mcp/.env` with file permissions `0600`.
From that point on, `affiliate-networks-mcp test offer18` should report `ok` for
`listProgrammes`, `getProgramme`, `listTransactions`, `getEarningsSummary`, and
`verifyAuth`.

## Supported operations

| Operation | Status | Notes |
| --- | --- | --- |
| `verifyAuth` | Supported | Calls `GET /api/af/offers` as a cheap authenticated probe. |
| `listProgrammes` | Supported | Offers from `GET /api/af/offers`. |
| `getProgramme` | Supported | Filters the offers endpoint by `offer_id`. |
| `listTransactions` | Supported | Conversion rows from `GET /api/af/report`. Wide date windows are chunked into 31-day slices. |
| `getEarningsSummary` | Supported | Derived client-side from `listTransactions` so the totals are reproducible. |
| `listClicks` | Not supported | Offer18 does not expose click-level data via a distinct affiliate endpoint. |
| `generateTrackingLink` | Not supported | The per-tenant click domain is not returned by the affiliate API, so a link cannot be constructed. |

## Known limitations

- Adapter built from public API documentation; not yet verified against a live
  account.
- Per-tenant base URL: there is no fixed host. `OFFER18_BASE_URL` must point at
  your Offer18 instance API host.
- Amount unit assumed to be major currency units (for example `5.00` is five
  units of the reported currency); not confirmed against a live tenant.
- Click-level data is not exposed as a distinct affiliate endpoint, so
  `listClicks` is unsupported.
- Tracking links are not deterministically constructible from the affiliate
  API, so `generateTrackingLink` is unsupported.

## Environment variables

- `OFFER18_BASE_URL` — your Offer18 instance API host, for example
  `https://api.offer18.com`, or your operator's white-label API host.
- `OFFER18_API_KEY` — the affiliate API key from *Account » Security*
  (sent as `key`).
- `OFFER18_SECRET_KEY` — the Secret key from *Account » Security*, revealed by
  clicking *view* (sent as `aid`).
- `OFFER18_MID` — your numeric network/advertiser account id (sent as `mid`).

## Common failures

### Failure: the wizard reports an authentication error when validating

The API key, Secret key, or MID was copied with surrounding whitespace, was
truncated, or belongs to a different account. Re-open *Account » Security* and
confirm each value. Also confirm `OFFER18_BASE_URL` points at the correct host:
on a white-label instance the main `api.offer18.com` host will not recognise
your credentials.

### Failure: `OFFER18_BASE_URL is not a valid URL`

Enter the absolute API host as a URL, including the scheme, for example
`https://api.offer18.com`. Do not enter a bare hostname or a dashboard URL.

### Failure: amounts look off by a factor

The adapter assumes amounts are in major currency units. If your tenant reports
amounts in a different unit, the totals will be scaled accordingly. Inspect the
verbatim payload under `rawNetworkData` on any transaction to confirm what the
API returned, and raise an issue so the assumption can be corrected for your
instance.

## Verifying

```
affiliate-networks-mcp test offer18
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- offer18`.
