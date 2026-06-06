# Setting up affiliate-mcp with ClickBank (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs to talk to your
ClickBank account as an affiliate. You will end up with three values written to
`~/.affiliate-mcp/.env`: `CLICKBANK_DEV_KEY`, `CLICKBANK_CLERK_KEY`, and
`CLICKBANK_NICKNAME`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the ClickBank dashboard is shown; label wording can
change between dashboard refreshes, so the layout is described alongside.

This adapter is **experimental**: it was built from ClickBank's public API
documentation and has not yet been verified against a live account. Treat its
figures as indicative until you have confirmed them against your ClickBank
reports.

## Prerequisites

- A ClickBank account you can sign in to at
  [https://accounts.clickbank.com/](https://accounts.clickbank.com/).
- The ability to reach the API Management screen under your account settings.
  API access is not gated behind a separate approval step: as long as your
  account is active you can create the keys on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## How ClickBank maps onto affiliate-mcp

ClickBank is a single marketplace rather than a collection of separately joined
merchant programmes. There is no per-merchant join, pending, or declined state
exposed to the publisher API. To fit the cross-network "programme" shape, this
adapter synthesises one programme per vendor it sees in your own order history
(each promoted vendor becomes a programme with status "joined"). You can
reproduce that list at any time by listing your transactions for the same
period.

## Credentials needed

ClickBank authenticates with two keys sent together in one header, joined as
`DEV-KEY:CLERK-KEY`. Both are created on the same screen.

### `CLICKBANK_DEV_KEY` — developer API key

Your account-wide developer key.

1. Sign in to ClickBank.
2. Open Settings, then "My Account", then "API Management".
3. Under the developer keys section, create a new developer key and copy the
   value.

### `CLICKBANK_CLERK_KEY` — clerk (API user) key

Your per-user key. ClickBank issues API keys against a user (a "clerk"); the
developer key plus the clerk key together authorise a request.

1. Still under Settings, then "API Management", find the clerk keys section.
2. Add a user (or pick an existing one) and grant it API permissions.
3. Copy that user's clerk key.

### `CLICKBANK_NICKNAME` — account nickname

Your ClickBank account login handle (for example `myacct`). It is the affiliate
identifier embedded in every HopLink and is shown in your dashboard header after
sign-in. The adapter uses it to build tracking links and to label your identity
in diagnostics.

## Setup steps

1. Create the developer key and the clerk key as described above. Keep them to
   hand.
2. Note your account nickname.
3. In your terminal, run `npx affiliate-networks-mcp setup` and select
   **ClickBank** when prompted.
4. Paste the developer key when asked for `CLICKBANK_DEV_KEY`. The wizard may
   report that it will confirm this key once the clerk key is also entered:
   ClickBank can only verify the pair together.
5. Paste the clerk key when asked for `CLICKBANK_CLERK_KEY`. The wizard now
   checks the pair against the `quickstats/count` endpoint.
6. Enter your account nickname when asked for `CLICKBANK_NICKNAME`.

## What success looks like

The wizard confirms that the key pair validated against ClickBank's
`quickstats/count` endpoint and writes the three values to
`~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test clickbank` should report `ok` for all ClickBank
operations except `listClicks` (ClickBank does not expose click-level data via
the publisher API).

## Common failures

### Failure: the wizard reports `401` when validating the keys

Either key may be wrong, or only one has been entered so far. ClickBank needs
both the developer key and the clerk key, and verifies them together. Re-open
Settings, then "API Management", and confirm both values. Paste each without
leading or trailing whitespace. If a key is missing from the screen, regenerate
it.

### Failure: the clerk user lacks API permission

A clerk key only works if its user has API access enabled. In "API Management",
confirm the user you copied the key from has the API permission granted, then
re-run the wizard.

### Failure: no programmes are returned

The adapter synthesises programmes from your recent order history (the last 90
days by default). If you have had no attributed transactions in that window
there are no vendors to list. This is expected for a new or inactive account; it
is not an error. List transactions for a wider window to confirm.

## Known limitations

These mirror `known_limitations` in `src/networks/clickbank/network.json`:

- The adapter was built from public API documentation and has not yet been
  verified against a live ClickBank account.
- Amount unit assumption: order amounts (`totalAccountAmount`) are treated as
  major currency units (whole dollars or pounds, not cents). Confirm the figures
  against your ClickBank reports before relying on them.
- ClickBank is a single marketplace with no per-merchant join lifecycle exposed
  to the publisher API. Programmes are synthesised from your own order history,
  one per promoted vendor.
- Click-level data (HopLink hits) is not exposed via the publisher API, so
  `listClicks` is unsupported and reports that it is not implemented rather than
  returning an empty result.

## Verifying

```
affiliate-networks-mcp test clickbank
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- clickbank`. The diagnostic engine's pass is the
verification contract.
