# Setting up affiliate-mcp with Admitad (estimated 15 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aadmitad%22)

This guide walks you through the credentials affiliate-mcp needs to read your
Admitad publisher account. You will end up with three values written to
`~/.affiliate-mcp/.env`: `ADMITAD_CLIENT_ID`, `ADMITAD_CLIENT_SECRET`, and
`ADMITAD_WEBSITE_ID`.

No prior API experience is assumed. Admitad uses OAuth2 client-credentials
authentication: you register your own API application, and the wizard handles
the token exchange automatically once you provide the Client ID and Secret.

## Prerequisites

- An active Admitad publisher account with at least one connected ad space
  (website).
- The ability to register an API application in your account. This is
  self-serve and does not require Admitad approval.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `ADMITAD_CLIENT_ID` | OAuth2 Client ID (your API application's app id) | Admitad account → API applications → register an application → **Show credentials** |
| `ADMITAD_CLIENT_SECRET` | OAuth2 Client Secret (secret key) | Same **Show credentials** panel |
| `ADMITAD_WEBSITE_ID` | Numeric id of the ad space (website) used for deeplinks | Admitad account → your ad spaces (websites) list |

When you register the API application, grant it these scopes:

- `statistics` — reading conversion and daily reports (`listTransactions`,
  `getEarningsSummary`).
- `advcampaigns` — listing affiliate programmes (`listProgrammes`,
  `getProgramme`).
- `deeplink_generator` — generating tracking links (`generateTrackingLink`).
- `private_data` — reading your account identity (`verifyAuth`).

The adapter requests all four scopes together in a single token exchange. If a
scope is not enabled on the application, the operations that need it will fail
with the exact error Admitad returns.

## Setup steps

1. Log in to your Admitad account.

2. Open the API applications section (your account's advertising / API
   settings) and register a new API application. This is self-serve.

3. Grant the application the scopes listed above: `statistics`, `advcampaigns`,
   `deeplink_generator`, `private_data`.

4. Click **Show credentials** on the application. You will see:
   - **Client ID** (app id) — a hexadecimal string.
   - **Client Secret** (secret key) — a longer string.

5. Find the numeric id of the ad space (website) you want to use for tracking
   links, in your ad spaces list.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Admitad** when prompted. The wizard will ask for:

   - **ADMITAD_CLIENT_ID** — paste the Client ID from step 4.
   - **ADMITAD_CLIENT_SECRET** — paste the Client Secret. The wizard validates
     both credentials live against the Admitad OAuth2 token endpoint
     immediately after you enter the secret.
   - **ADMITAD_WEBSITE_ID** — the numeric ad space id from step 5.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
ADMITAD_CLIENT_ID=your-client-id-here
ADMITAD_CLIENT_SECRET=your-client-secret-here
ADMITAD_WEBSITE_ID=123456
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on token exchange | Wrong Client ID or Secret | Re-copy both from the **Show credentials** panel. Watch for trailing spaces or line breaks when pasting. |
| `auth_error` mentioning scope | Application missing a required scope | Edit the API application and enable `statistics`, `advcampaigns`, `deeplink_generator`, and `private_data`, then retry. |
| `config_error: Missing required credential ADMITAD_WEBSITE_ID` | Website id not set | Add `ADMITAD_WEBSITE_ID=<your ad space id>` to `~/.affiliate-mcp/.env`. |
| `network_api_error` on `generateTrackingLink` | The ad space is not connected to that campaign | A deeplink can only be created for a campaign your ad space is connected to. Connect the programme first, or use a campaign you are already connected to. |
| `not_implemented: Admitad does not expose click-level data` | `listClicks` called | Admitad's publisher API offers only aggregated statistics; there is no per-click feed. |
| `results` array is empty | Date window has no actions | Try a wider date window. Conversions can take time to appear. |

## Known limitations

- **listClicks**: Admitad does not expose click-level data to publishers via
  the public API. The publisher reports surface only aggregated statistics
  (`statistics/actions` for conversions, `statistics/dates` for daily
  rollups). The operation throws `NotImplementedError`.
- **listProgrammes / getProgramme**: Mapped from `/advcampaigns/`. Admitad's
  connection status is per-ad-space; the adapter reports the campaign-level
  status it can read and preserves the verbatim payload in `rawNetworkData`.
- **generateTrackingLink**: Calls the Admitad deeplink generator
  (`GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp=...`). It requires
  the `deeplink_generator` scope, a connected ad space, and
  `ADMITAD_WEBSITE_ID`. Unlike some networks, the link is minted server-side and
  is not a deterministic local construction; a link can only be generated for a
  campaign your ad space is connected to.
- **Status normalisation**: Admitad action statuses map to canonical states as
  follows: `pending` to pending; `approved` and `approved_but_stalled` to
  approved; `declined` to reversed; the separate `payment_status` flag (1 means
  paid out to the publisher) maps to paid. Unknown statuses map to `other` and
  the raw value is preserved.
- **Token lifetime**: OAuth2 access tokens are short-lived. The adapter
  refreshes the token automatically, but cached tokens are lost on process
  restart.
- **Not verified against a live account**: This adapter was built from public
  Admitad API documentation. Some field names and endpoint shapes have not been
  confirmed against a live API response. The `claim_status` is `experimental`
  until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test admitad
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- admitad`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your account identity.
- `listProgrammes` → your visible affiliate programmes (may be 0 if you have
  not connected any).
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → derived from `listTransactions`.
- `listClicks` → `supported: false` with the known-limitation note.
- `getProgramme`, `generateTrackingLink` → `supported: true` (not probed live;
  they need a specific campaign id).
