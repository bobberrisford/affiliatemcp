# Setting up affiliate-mcp with Yieldkit (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Ayieldkit%22)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Yieldkit publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `YIELDKIT_API_KEY` and
`YIELDKIT_API_SECRET`.

Yieldkit is a link-monetisation network (it owns Digidip). Rather than joining
individual programmes, publishers access a catalogue of advertiser offers and
mint tracking links against destination URLs. The adapter maps that catalogue
onto the standard programme and transaction shapes so it behaves like the other
networks.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording shown is taken from the Yieldkit dashboard; label wording
can change between dashboard refreshes, so the layout is described alongside.

## Prerequisites

- A Yieldkit publisher account. If you can sign in at
  [https://www.yieldkit.com/](https://www.yieldkit.com/) and see your
  dashboard, you have what you need.
- API access does not require a separate approval step: as long as your
  publisher account is active, the API key and secret are available from the
  Account screen on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `YIELDKIT_API_KEY` — the API key shown under Account → API access.
- `YIELDKIT_API_SECRET` — the API secret shown on the same screen.

Both are required. Yieldkit passes them as query parameters (`api_key` and
`api_secret`) on every API request; they are not a bearer token.

## Setup steps

1. Sign in to the Yieldkit dashboard at
   [https://www.yieldkit.com/](https://www.yieldkit.com/).

2. Open *Account* in the left-hand menu.

3. Click *API access*. This screen shows both your API key and your API
   secret.

4. Copy the *API key* and the *API secret* values to a secure location.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Yieldkit** when prompted. Paste the API key when the wizard asks for
   `YIELDKIT_API_KEY`, then the API secret when it asks for
   `YIELDKIT_API_SECRET`. The key is accepted on its own and verified together
   with the secret in the following step.

## What success looks like

The wizard verifies the key and secret against the Advertiser API, then writes
both values to `~/.affiliate-mcp/.env` with file permissions `0600`. From that
point on, `affiliate-networks-mcp test yieldkit` should report `ok` for the
implemented operations.

## Common failures

### Failure: the wizard reports an authentication error when validating the secret

The key or secret was copied with surrounding whitespace, was truncated, or has
been regenerated. Re-open *Account → API access*, confirm the values still
match, and paste them into the wizard without leading or trailing spaces.
Because Yieldkit verifies both credentials together, an error on the secret
step can also mean the key entered earlier was wrong.

### Failure: `listProgrammes` returns far more rows than expected

Yieldkit exposes a large advertiser catalogue rather than a list of programmes
you have personally joined. Use the `search`, `categories`, or `limit` filters
to narrow the result set.

### Failure: a tracking link does not resolve to the expected advertiser

Yieldkit monetises by destination URL: the redirect service resolves the
destination to the best-performing advertiser at click time rather than binding
the link to a fixed advertiser id. Pass the full destination URL you want to
monetise; the `programmeId` argument is echoed back but does not constrain the
link.

## Known limitations

Mirrors `known_limitations` in `network.json`:

- The adapter is experimental. The API shapes were mapped from public
  documentation and have not been validated against a live Yieldkit publisher
  account.
- Commission and sale amounts are assumed to be in major currency units (for
  example euros, not cents). Revisit this assumption if a live account reports
  minor units. The verbatim payload is preserved on `rawNetworkData` so figures
  can always be reconciled.
- Yieldkit does not expose a distinct paid state on commissions; transactions
  are reported as pending, approved, or reversed only.

## Verifying

```
affiliate-networks-mcp test yieldkit
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- yieldkit`. The diagnostic engine's pass is the
verification contract.
