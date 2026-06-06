# Setting up affiliate-mcp with Webgains (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Awebgains%22)

This guide walks you through the credentials affiliate-mcp needs to read your
Webgains publisher account through the Smart Platform API. You will end up with
three values written to `~/.affiliate-mcp/.env`: `WEBGAINS_API_KEY`,
`WEBGAINS_PUBLISHER_ID`, and `WEBGAINS_CAMPAIGN_ID`.

No prior API experience is assumed. Webgains uses a Personal Access Token, which
you generate yourself in the Smart Publisher Platform and paste into the wizard;
there is no separate token-exchange step.

**Note:** This adapter was built from public Webgains documentation and has not
yet been verified against a live account. The exact REST base URL and some
response field names could not be confirmed because the Webgains documentation
host was not reachable during development. Treat the adapter as `experimental`
until a live-account check is completed.

## Prerequisites

- An active Webgains publisher account on the Smart Publisher Platform. Sign in
  at [https://platform.webgains.io/](https://platform.webgains.io/).
- The ability to generate a Personal Access Token in your account settings. This
  is self-serve for publishers and does not require Webgains approval.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|------------------|
| `WEBGAINS_API_KEY` | Personal Access Token (bearer secret) | Smart Publisher Platform → your account / developer settings → Personal Access Tokens → Generate |
| `WEBGAINS_PUBLISHER_ID` | Your numeric publisher account ID | Smart Publisher Platform → account settings (also visible in the platform URL) |
| `WEBGAINS_CAMPAIGN_ID` | Your campaign (Site) ID, used only for tracking links | Smart Publisher Platform → site/campaign settings, or read the `wgcampaignid` value from any existing tracking link |

## Setup steps

1. Sign in to the Webgains Smart Publisher Platform at
   [https://platform.webgains.io/](https://platform.webgains.io/).

2. Open your account or developer settings and find the **Personal Access
   Tokens** area. Generate a new token and copy it. Keep the page open.

3. Note your numeric **Publisher ID**. It appears in your account settings and
   in the platform URL.

4. Note your **Campaign (Site) ID**. You can read it from your site settings, or
   from the `wgcampaignid` parameter of any tracking link you have already
   created (`https://track.webgains.com/click.html?wgcampaignid=...`).

5. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Webgains** when prompted. The wizard will ask for:

   - **WEBGAINS_API_KEY** — paste the Personal Access Token from step 2. Once
     the Publisher ID is set, the wizard validates the token live against the
     Get Publisher endpoint.
   - **WEBGAINS_PUBLISHER_ID** — the numeric ID from step 3.
   - **WEBGAINS_CAMPAIGN_ID** — the campaign/Site ID from step 4.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
WEBGAINS_API_KEY=your-personal-access-token-here
WEBGAINS_PUBLISHER_ID=123456
WEBGAINS_CAMPAIGN_ID=789012
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `auth_error: HTTP 401` on Get Publisher | Wrong, expired, or revoked token | Generate a fresh Personal Access Token and re-paste it. Watch for trailing spaces when pasting. |
| `config_error: Missing required credential WEBGAINS_PUBLISHER_ID` | Publisher ID not set | Add `WEBGAINS_PUBLISHER_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| `config_error: Missing required credential WEBGAINS_CAMPAIGN_ID` | Campaign ID not set | Add `WEBGAINS_CAMPAIGN_ID=<campaign id>` to `~/.affiliate-mcp/.env`. Read it from an existing tracking link's `wgcampaignid`. |
| `not_implemented: Webgains does not expose click-level data` | `listClicks` called | Webgains publisher reporting is transaction-level; click data is not available through this API. |
| `network_api_error: non-JSON body` | The host returned an HTML error or the base URL is wrong | Confirm the base URL against your live account; the adapter's base URL is unverified. See Known limitations. |
| Transactions array is empty | Date range has no data, or Publisher ID is wrong | Try a wider date window. Confirm `WEBGAINS_PUBLISHER_ID` matches your account. |

## Known limitations

- **Not verified against a live account**: the adapter was built from public
  documentation. The `claim_status` is `experimental` until a live-account test
  is completed.
- **Unverified base URL and paths**: the Webgains documentation host was not
  reachable during development, so the REST base URL is taken as
  `https://platform.webgains.io` and the endpoint paths
  (`/publishers/{id}`, `/publishers/{id}/programs`,
  `/publishers/{id}/transactions`) are assumed. Confirm these against a live
  account.
- **Field-name drift**: transaction and programme field names are read
  defensively across several plausible names because the exact response schema
  could not be confirmed. The verbatim upstream payload is preserved in
  `rawNetworkData`.
- **listClicks**: Webgains does not expose click-level data via the public
  publisher Smart Platform API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: constructs deeplinks deterministically as
  `https://track.webgains.com/click.html?wgcampaignid=...&wgprogramid=...&wgtarget=...`.
  Both `wgcampaignid` (your `WEBGAINS_CAMPAIGN_ID`) and `wgprogramid` (the
  programme ID) are mandatory for tracking.
- **One-year report window**: the Get Transaction Report endpoint documents a
  maximum date range of one year per call. The adapter chunks longer windows
  into one-year segments automatically.
- **Multi-currency**: Webgains reports per programme in the programme's own
  currency. `getEarningsSummary` reports a `totalEarnings` figure that sums
  across currencies for mixed-currency accounts; inspect each
  `byProgramme[].currency` to disambiguate.

## Verifying

```
affiliate-networks-mcp test webgains
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- webgains`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your publisher identity.
- `listProgrammes` → your joined programmes (may be empty on a new account).
- `listTransactions` → may return 0 records if your date window is empty.
- `listClicks` → `supported: false` with the known-limitation note.
- `generateTrackingLink` → `supported: true` (no live probe; deterministic).
