# Setting up affiliate-mcp with Involve Asia (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Involve Asia publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `INVOLVE_ASIA_API_KEY` and
`INVOLVE_ASIA_API_SECRET`.

Involve Asia is an affiliate network focused on the APAC and South-East Asia
region. No prior API experience is assumed. Where a step refers to a button or
menu label, the exact wording from the Involve Asia dashboard is shown in
italics; label wording can change between dashboard refreshes, so the layout is
described alongside.

## Status

This adapter is **experimental**. It has not yet been validated against a live
Involve Asia publisher account: the endpoint shapes and field names are modelled
on the public API documentation and may differ in production. Treat its output
with that caveat in mind, and check the raw payload (`rawNetworkData`) against
your dashboard before relying on a figure.

## Prerequisites

- An active Involve Asia publisher account. If you can sign in at
  [https://app.involve.asia/](https://app.involve.asia/) and see your
  dashboard, you have what you need.
- API access does not require a separate approval step. As long as your
  publisher account is active, the key and secret are available on the API
  screen on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `INVOLVE_ASIA_API_KEY` — your API key, shown on the dashboard's API screen.
- `INVOLVE_ASIA_API_SECRET` — the paired API secret, shown on the same screen.

The key and secret are not sent on every request. The adapter exchanges them
once for a short-lived bearer token (it expires roughly every 2 hours) via the
network's authenticate endpoint, caches that token, and refreshes it for you
when it nears expiry or a request is rejected as expired. You never handle the
token yourself.

## Setup steps

1. Sign in to the Involve Asia dashboard at
   [https://app.involve.asia/](https://app.involve.asia/). Use the same
   credentials you use to read your performance reports.

2. Open the *Tools* menu and click *API*. This screen lists the credentials
   your account uses for programmatic access.

3. Copy the *API Key* value. This is your `INVOLVE_ASIA_API_KEY`.

4. Copy the *API Secret* value from the same screen. This is your
   `INVOLVE_ASIA_API_SECRET`. Keep both somewhere secure before leaving the
   page.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Involve Asia** when prompted. Paste the API key when the wizard asks for
   `INVOLVE_ASIA_API_KEY`, then paste the secret when it asks for
   `INVOLVE_ASIA_API_SECRET`. The wizard verifies the two together by
   requesting a token once the secret is entered.

## What success looks like

The wizard prints a confirmation line that a token was issued from the
authenticate endpoint and writes the two values to `~/.affiliate-mcp/.env` with
file permissions `0600`. From that point on,
`affiliate-networks-mcp test involve-asia` should report `ok` for the supported
operations. `listClicks` is reported as unsupported: Involve Asia does not
expose click-level data via the public publisher API.

## Known limitations

These mirror `known_limitations` in
`src/networks/involve-asia/network.json`:

- **Experimental.** The adapter has not been validated against a live Involve
  Asia publisher account; endpoint shapes and field names are modelled on the
  public API documentation and may differ in production.
- **Amount-unit assumption.** `sale_amount` and `payout` are read as major
  currency units (for example `"12.34"` becomes `12.34`) in the conversion's
  own currency, not minor units. Verify against your own conversions; the raw
  payload is preserved on `rawNetworkData` so you can reconcile.
- **Short-lived token.** Authentication uses an API key plus secret exchanged
  for a bearer token that expires roughly every 2 hours. The adapter caches and
  refreshes the token (proactively, and on a rejected request) so callers do
  not handle the exchange.
- **No click data.** Click-level data is not exposed via the public publisher
  API, so `listClicks` is unsupported.

## Common failures

### Failure: the *API* item is missing from the *Tools* menu

This usually means you are signed in to an account type that does not have
publisher API access, or the account is not yet active. Confirm you are using a
publisher account and that it can see the performance reports; if the *API* item
is still absent, contact Involve Asia support to confirm API access is enabled.

### Failure: the wizard reports an authentication error when validating

The key or secret was copied with surrounding whitespace, was truncated, or has
been rotated. Re-open *Tools* then *API* in the dashboard and confirm both
values; copy them without any leading or trailing spaces. Neither value contains
spaces, so a space in the pasted value is almost always a copy/paste artefact.

### Failure: a tracking link is rejected with a quota message

Involve Asia limits the number of affiliate links a standard account can
generate each month. If `generateTrackingLink` returns a quota error, the
verbatim message from the network is preserved in the error envelope; wait for
the monthly reset or contact the network about a higher limit.

## Verifying

```
affiliate-networks-mcp test involve-asia
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- involve-asia`. An empty-but-successful result counts
as a passing check when the account has no data for the probed period.
