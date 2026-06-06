# Setting up affiliate-mcp with Addrevenue (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Addrevenue publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `ADDREVENUE_API_TOKEN` and
`ADDREVENUE_CHANNEL_ID`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording shown is the wording from the Addrevenue dashboard; layout
can change between refreshes, so the location is described alongside.

Addrevenue is a Nordic network, with Sweden (SE) as its primary market. The
adapter is currently **experimental**: the API response shapes it reads are
inferred from the public developer reference and have not yet been validated
against a live account. See "Known limitations" below.

## Prerequisites

- An Addrevenue publisher account. If you can sign in at
  [https://addrevenue.io/](https://addrevenue.io/) and see your publisher
  dashboard, you have what you need.
- API access does not require a separate approval step. As long as your
  publisher account is active, you can generate an API token on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `ADDREVENUE_API_TOKEN` — the lifetime OAuth2 token from the *Tools → API
  Tokens* screen.
- `ADDREVENUE_CHANNEL_ID` — your numeric channel ID. It is the `c` value in
  your tracking links and scopes reporting queries to your channel.

## Setup steps

1. Sign in to the Addrevenue publisher dashboard at
   [https://addrevenue.io/](https://addrevenue.io/).

2. Open *Tools* in the left-hand menu, then *API Tokens*.

3. If no token is listed, click *Generate new token*. Addrevenue shows the
   token value on screen; copy it immediately to a secure location. The token
   is long-lived (no auto-expiry) but can be revoked from the same screen.

4. Note your numeric *channel ID*. It is shown in the dashboard and also appears
   as the `c` parameter in any tracking link you have created
   (`https://addrevenue.io/t?c=<channelId>&a=<advertiserId>`).

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Addrevenue** when prompted. Paste the API token when the wizard asks for
   `ADDREVENUE_API_TOKEN`, then enter your channel ID when it asks for
   `ADDREVENUE_CHANNEL_ID`.

## What success looks like

The wizard validates the token against the `/advertisers` endpoint and writes
the two values to `~/.affiliate-mcp/.env` with file permissions `0600`. From
that point on, `affiliate-networks-mcp test addrevenue` should report `ok` for
the Addrevenue operations.

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the token

The token was copied with surrounding whitespace, was truncated, or has been
revoked. Re-open *Tools → API Tokens* in Addrevenue and confirm the token is
still listed; if it is not, generate a new one. Paste it into the wizard
without any leading or trailing spaces.

### Failure: transactions or clicks come back empty

`listTransactions` and `listClicks` are scoped to your channel via
`ADDREVENUE_CHANNEL_ID`. If the channel ID is wrong, the API authenticates but
returns no rows for your account. Confirm the channel ID matches the `c` value
in your tracking links and re-run `npx affiliate-networks-mcp setup` to correct
it.

### Failure: an advertiser ID is not found by `get_programme`

`get_programme` selects from the advertisers available to your channel. If an
advertiser is not in that listing (for example, you have not joined it, or it
is not active in your market), the operation reports a `network_api_error`
rather than returning a stub. Use `list_programmes` to see the IDs available to
your channel.

## Known limitations

These mirror `known_limitations` in `src/networks/addrevenue/network.json`:

- **Experimental adapter.** The Addrevenue API response shapes the adapter
  reads (field names, pagination, amount unit) are inferred from the public
  developer reference and have not been validated against a live account. The
  adapter reads fields defensively and preserves the full upstream payload on
  `rawNetworkData`, so you can always inspect what Addrevenue actually returned.
- **Amount unit assumption.** Monetary amounts are assumed to be in the major
  currency unit (for example SEK, not öre) with a per-row currency field. This
  has not been confirmed against a live account; cross-check totals against the
  Addrevenue dashboard before relying on them.

## Verifying

```
affiliate-networks-mcp test addrevenue
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- addrevenue`. The diagnostic engine's pass is the
verification contract.
