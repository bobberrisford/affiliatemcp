# Setting up affiliate-mcp with Levanta (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Alevanta%22)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Levanta creator account. You will end up with one value written
to `~/.affiliate-mcp/.env`: `LEVANTA_API_KEY`.

Levanta is an Amazon-focused creator platform: creators run direct affiliate
partnerships with Amazon sellers and place tracking links by product (ASIN).
The adapter uses Levanta's Creator API.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the Levanta dashboard is shown in italics; label
wording can change between dashboard refreshes, so the layout is described
alongside.

## Prerequisites

- A Levanta creator account with at least one active brand partnership. If you
  can sign in and see your partnerships, you have what you need.
- Admin access on the account. The API screen is only visible to users with
  Admin access; without it you cannot view or generate the token.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

API access does not require a separate approval step: as long as your account
is active and you have Admin access, you can generate a token on demand.

## Credentials needed

- `LEVANTA_API_KEY` — the Creator API bearer token from the Levanta dashboard's
  *Settings* → *API* screen.

## Setup steps

1. Sign in to your Levanta account.

2. Open the navigation menu and click *Settings*.

3. Select the *API* tab. You need Admin access to see this tab; if it is not
   present, ask an account administrator to generate the token for you or grant
   you Admin access.

4. Copy the API token shown on screen. The token is long-lived and can be
   revoked from the same screen.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Levanta** when prompted. Paste the token when the wizard asks for
   `LEVANTA_API_KEY`.

## What success looks like

The wizard validates the token against the Creator API `/partners` endpoint,
prints a confirmation line summarising how many active brand partnerships the
token can see, and writes the value to `~/.affiliate-mcp/.env` with file
permissions `0600`. From that point on, `affiliate-networks-mcp test levanta`
should report `ok` for the supported operations.

## Common failures

### Failure: the *API* tab is missing from Settings

The API screen is gated behind Admin access. If you do not see the *API* tab
under *Settings*, you are signed in with a non-admin role. Ask an account
administrator to generate the token and share it with you, or to grant your
user Admin access.

### Failure: the wizard reports `401 Unauthorized` when validating the token

The token was copied with surrounding whitespace, was truncated, or has been
revoked. Re-open the *API* tab in Levanta and confirm the token is still listed;
if it is not, generate a new one. Paste it into the wizard without any leading
or trailing spaces.

### Failure: `test levanta` reports `listClicks` and `generateTrackingLink` as unsupported

This is expected, not a fault. See "Known limitations" below.

## Known limitations

These mirror `known_limitations` in `src/networks/levanta/network.json`.

- **Experimental adapter.** This adapter was built from Levanta's public API
  documentation and has not yet been verified against a live account. Treat the
  figures as best-effort until the adapter is promoted past `experimental`.
- **Amount unit assumed.** The public documentation does not state the unit or
  currency of the `sales` and `commissions` fields on the `/reports` endpoint.
  The adapter assumes major currency units (for example dollars, not cents) and
  defaults the currency to USD. The verbatim reporting row is preserved on each
  transaction's `rawNetworkData` so you can confirm against your dashboard.
- **Programmes are brand partnerships.** Levanta has no programme-join lifecycle
  in the Awin sense. The adapter models each active partnership from `/partners`
  as a joined programme; statuses other than "joined" are not reported.
- **No click-level data.** The `/reports` endpoint returns aggregate click
  counts per link, source, and day, not individual click events with a
  timestamp and referrer. `listClicks` is therefore unsupported; the aggregate
  click counts are available on each transaction's `rawNetworkData`.
- **No deterministic tracking links.** Levanta tracking links are created
  server-side via the `/links` endpoint by ASIN and source pair, and the link
  identifier and short URL are assigned by Levanta. They are not constructible
  from a destination URL, so `generateTrackingLink` is unsupported.

## Verifying

```
affiliate-networks-mcp test levanta
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- levanta`. The diagnostic engine's pass is the
verification contract.
