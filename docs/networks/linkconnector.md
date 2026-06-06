# Setting up affiliate-mcp with LinkConnector (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your LinkConnector publisher account. You will end up with one value
written to `~/.affiliate-mcp/.env`: `LINKCONNECTOR_API_KEY`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the LinkConnector dashboard is shown in italics; label
wording can change between dashboard refreshes, so the location is described
alongside.

LinkConnector is a US affiliate network with roughly 700 advertisers. This
adapter is marked `experimental`: it has not yet been validated against a live
LinkConnector account, and some response field names are inferred from the
public API documentation. See the known limitations below.

## Prerequisites

- An active LinkConnector affiliate account. If you can sign in at
  [https://www.linkconnector.com/](https://www.linkconnector.com/) and see your
  affiliate dashboard, you have what you need.
- API access does not require a separate approval step: as long as your account
  is active, you can generate an API key on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Steps

1. Sign in to the LinkConnector affiliate dashboard at
   [https://www.linkconnector.com/](https://www.linkconnector.com/).

2. Open the *Tools* menu and click *API*.

3. On the API page, click *Create API Key*. LinkConnector generates and shows
   the key value; copy it to a secure location.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **LinkConnector** when prompted. Paste the API key when the wizard asks for
   `LINKCONNECTOR_API_KEY`.

## What success looks like

The wizard validates the key against the LinkConnector Transaction report
endpoint and writes the value to `~/.affiliate-mcp/.env` with file permissions
`0600`. From that point on, `affiliate-networks-mcp test linkconnector` should
report `ok` for the supported operations.

## How the API is used

LinkConnector exposes a single API endpoint
(`https://www.linkconnector.com/api/`) that dispatches on a `Function` query
parameter. The API key is passed as the `Key` parameter and `Format=JSON`
forces JSON output. The adapter uses three functions:

- `getFeedPromotion` — the merchant promotions feed. Backs `listProgrammes` and
  `getProgramme`: it is the closest per-merchant view with tracking URLs the
  publisher API exposes.
- `getReportTransaction` — the Transaction report. Backs `listTransactions` and
  `getEarningsSummary`: it returns the current status of commissionable events
  with commission, sale amount, status, invalidation reason, and the original
  and funded dates.
- `getReportTransactionDelta` — incremental transaction changes. Documented in
  the adapter but not used at v0.1; the full Transaction report is the
  canonical totals source.

Reference documentation:
[https://www.linkconnector.com/help_api.htm](https://www.linkconnector.com/help_api.htm).

### Environment variable

- `LINKCONNECTOR_API_KEY` — the API key from *Tools* → *API* → *Create API Key*.

## Supported operations

- `verifyAuth` — confirms the key with a minimal Transaction report call.
- `listProgrammes` / `getProgramme` — merchants from the promotions feed,
  de-duplicated per merchant.
- `listTransactions` — the Transaction report over a date window, with
  client-side status, programme, and age filters.
- `getEarningsSummary` — derived from `listTransactions`.

## Known limitations

- This adapter is `experimental`: it has not been validated against a live
  account, and the JSON field names are inferred from the public documentation
  and read defensively. When LinkConnector returns a shape the adapter does not
  recognise, the verbatim payload is preserved on `rawNetworkData`.
- Amounts are assumed to be in major currency units (US dollars). LinkConnector
  is a US network; the unit has not been confirmed against a live account.
- Click-level data is not exposed via the public publisher API, so `listClicks`
  is unsupported (it reports the limitation rather than returning an empty
  list).
- LinkConnector issues tracking URLs per merchant through the promotions feed
  rather than a deterministic deep-link scheme, so `generateTrackingLink` is
  unsupported. To obtain a tracked link, read the affiliate URL from
  `listProgrammes`.

## Common failures

### Failure: the wizard reports an authentication error when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
revoked. Re-open *Tools* → *API* in LinkConnector, confirm the key is still
listed, and generate a new one if it is not. Paste it into the wizard without
leading or trailing spaces.

### Failure: `listProgrammes` returns nothing

The promotions feed only returns merchants your account is approved for and
that currently have active promotions. If you have no active merchant
promotions, the feed is empty; this is a true empty result, not an error.

## Verifying

```
affiliate-networks-mcp test linkconnector
```

The CLI runs the live diagnostic. The diagnostic engine's pass is the
verification contract.
