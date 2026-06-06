# Setting up affiliate-mcp with TUNE (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your TUNE (HasOffers) affiliate account. You will end up with two
values written to `~/.affiliate-mcp/.env`: `TUNE_NETWORK_ID` and `TUNE_API_KEY`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the dashboard is shown in italics; label wording varies
between networks because each one runs its own TUNE instance, so the layout is
described alongside.

## Prerequisites

- An active affiliate (publisher) account on a network that runs on TUNE
  (formerly HasOffers). If you can sign in to your network's affiliate panel and
  see your offers and conversion reports, you have what you need.
- TUNE is a CPA platform engine: each network runs its own instance under its
  own subdomain. There is no single shared sign-in or single shared API host.
  Your network gives you a NetworkId and an affiliate API key; both are specific
  to that network.
- Some networks restrict API access to approved affiliates. If you cannot find
  an API key in your dashboard, contact your affiliate manager and ask for API
  access to be enabled.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `TUNE_NETWORK_ID` — your network identifier. The API host is built from it as
  `https://{network_id}.api.hasoffers.com`. It is the leftmost part of that host
  (for example `atollsnet`).
- `TUNE_API_KEY` — your affiliate API key, found in the API section of the
  affiliate dashboard.

## Steps

1. Sign in to your network's TUNE/HasOffers affiliate dashboard. Use the same
   credentials you use to read your conversion reports.

2. Open the API section of the dashboard. It is commonly labelled *API* or
   *API access* under your account, profile, or tools menu. (Wording differs
   between networks; if you cannot find it, search the dashboard help or ask
   your affiliate manager.)

3. On the API page, note your *NetworkId* and copy your *API key*. The
   NetworkId is usually shown alongside the key, and it is also the first part
   of the API endpoint URL the page shows you
   (`https://{network_id}.api.hasoffers.com`). Enter only the bare identifier,
   for example `atollsnet`, not the full URL.

4. If the page offers a *Generate* option and you do not yet have a key, use it
   to create one, then copy the value.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **TUNE** when prompted. Enter the NetworkId first (the wizard validates its
   format), then paste the API key. The wizard validates the key by listing one
   offer from your network.

## What success looks like

The wizard confirms that the API key validated against your network's host by
calling `Affiliate_Offer::findAll`, and writes the two values to
`~/.affiliate-mcp/.env`. From that point on, `affiliate-networks-mcp test tune`
should report `ok` for all TUNE operations except `listClicks` (TUNE does not
expose raw click-level data via the affiliate API; only aggregated click stats
are available).

## Verifying

```
affiliate-networks-mcp test tune
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- tune`. The diagnostic engine's pass is the
verification contract.

## Common failures

### Failure: the wizard cannot reach the API host

The host is built from your NetworkId as
`https://{network_id}.api.hasoffers.com`. If you entered the full endpoint URL,
a path, or a value with a dot in it, the wizard rejects it. Re-run setup and
enter only the bare identifier (for example `atollsnet`). Confirm the identifier
against the API endpoint URL shown on your dashboard's API page.

### Failure: the wizard reports an authentication error when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
revoked, or the NetworkId does not match the key. Re-open the API section of
your dashboard, confirm the key is current, and paste it without leading or
trailing spaces. Confirm the NetworkId matches the network the key belongs to;
a key for one network does not authenticate against another network's host.

### Failure: there is no API key on the dashboard

Some networks gate API access behind manual approval. If the API section does
not show a key and offers no *Generate* option, contact your affiliate manager
and ask for API access to be enabled on your account.

## Known limitations

These mirror `known_limitations` in `src/networks/tune/network.json`:

- The adapter was implemented from public API documentation and has not yet
  been validated against a live account, so its claim status is *experimental*.
- The API base URL is per-tenant. TUNE is a CPA platform engine and each network
  runs its own instance, so one adapter serves any HasOffers-powered network via
  its NetworkId (the host is `https://{network_id}.api.hasoffers.com`); there is
  no single shared host.
- Conversion amounts (`Stat.payout`) are assumed to be in major currency units
  (not minor units or cents). Confirm this against a live account before relying
  on the figures for reconciliation.
- Click-level data is not exposed via the affiliate API; `listClicks` is not
  implemented.
