# Setting up affiliate-mcp with FlexOffers (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aflexoffers%22)

This guide walks you through the credentials affiliate-mcp needs to read your
FlexOffers publisher account. You will end up with one required value and one
optional value written to `~/.affiliate-mcp/.env`: `FLEXOFFERS_API_KEY` and,
optionally, `FLEXOFFERS_ACCOUNT_ID`.

No prior API experience is assumed. FlexOffers uses a single account API Key —
the key is sent in a request header on every call. There is no OAuth token
exchange to manage.

## Prerequisites

- An active FlexOffers publisher account. Sign in at
  [https://publishers.flexoffers.com/](https://publishers.flexoffers.com/).
- API access is self-serve for standard publisher accounts: as long as your
  account is active, the API Key is already provisioned. No separate approval
  step is required.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** FlexOffers is a US aggregator, so most sales clear in USD. The adapter
reads the currency from each sales row rather than assuming it, so non-USD rows
are reported in their own currency.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `FLEXOFFERS_API_KEY` | Your account API Key (required) | FlexOffers account → Tools → Web Services → API Keys (the "API Key" column) |
| `FLEXOFFERS_ACCOUNT_ID` | Your numeric Account ID (optional) | Same page, shown alongside the Domain ID and API Key. Used to label the account and to build tracking links. |

## Setup steps

1. Sign in to the FlexOffers publisher dashboard at
   [https://publishers.flexoffers.com/](https://publishers.flexoffers.com/).

2. Click **Tools** in the top navigation bar.

3. From the Tools menu, select **Web Services**.

4. Open the **API Keys** tab. You should see a row with your **Domain ID**,
   **Domain Name**, **Domain URL**, and **API Key**.

5. Copy the value in the **API Key** column. Note the numeric **Account ID** on
   the same page if you want to set the optional credential.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **FlexOffers** when prompted. The wizard will ask for:

   - **FLEXOFFERS_API_KEY** — paste the value from step 5. The wizard validates
     the key live against the FlexOffers API immediately after you enter it.
   - **FLEXOFFERS_ACCOUNT_ID** — the numeric Account ID (optional). Leave blank
     if you are unsure; it is not required for reading transactions or earnings.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
FLEXOFFERS_API_KEY=your-api-key-here
FLEXOFFERS_ACCOUNT_ID=123456
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on the data call | Wrong or revoked API Key | Re-copy the API Key from Tools → Web Services → API Keys. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential FLEXOFFERS_API_KEY` | API Key not set | Add `FLEXOFFERS_API_KEY=<your key>` to `~/.affiliate-mcp/.env`, or re-run setup. |
| `config_error: generateTrackingLink needs FLEXOFFERS_ACCOUNT_ID` | Account ID not set | Add `FLEXOFFERS_ACCOUNT_ID=<your account id>` to `~/.affiliate-mcp/.env`. Find it at Tools → Web Services → API Keys. |
| `not_implemented: FlexOffers programme/advertiser listing is not implemented` | `listProgrammes` / `getProgramme` called | These are not implemented in this adapter; see Known limitations. |
| `not_implemented: FlexOffers does not expose click-level data` | `listClicks` called | FlexOffers does not expose individual click records via the public API. |
| `network_api_error: non-JSON body` | FlexOffers returned an HTML error page | Wait a few minutes and retry; check whether the FlexOffers dashboard is reachable. |
| Sales array is empty | Date range has no data | Try a wider date window. The default window is the last 30 days. |

## Known limitations

- **listProgrammes / getProgramme**: Not implemented. FlexOffers exposes
  advertiser/programme data, but the public documentation does not pin down the
  publisher-side joined-programme endpoint shape or its status semantics well
  enough to map reliably. Both operations throw `NotImplementedError` until the
  endpoint is verified against a live account.
- **listClicks**: FlexOffers does not expose click-level data via the public Web
  Service API; only aggregated click counts appear inside sales reports. The
  operation throws `NotImplementedError`.
- **generateTrackingLink**: Constructs a FlexLinks redirect URL of the form
  `https://track.flexlinkspro.com/a.ashx?foid={accountId}.{advertiserId}&foc=1&fot=9999&fos=1&url={encoded}`.
  It requires `FLEXOFFERS_ACCOUNT_ID` and the advertiser id (passed as the
  programme id). The exact redirect parameter names are taken from public link
  examples and have not been confirmed against a live account.
- **Authentication detail**: The API key header name (`apiKey`) and the
  `/allsales` pagination parameter are taken from public integration write-ups,
  not a confirmed live response.
- **Not verified against a live account**: This adapter was built from public
  FlexOffers API documentation. Some field names and endpoint shapes have not
  been confirmed against a live API response. The `claim_status` is
  `experimental` until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test flexoffers
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- flexoffers`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your account identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes`, `getProgramme`, `listClicks` → `supported: false` with the
  known-limitation note.
- `generateTrackingLink` → `supported: true` (no live probe; deterministic).
