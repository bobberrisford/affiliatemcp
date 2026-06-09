# Setting up affiliate-mcp with Skimlinks (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Askimlinks%22)

This guide walks you through the credentials affiliate-mcp needs to read
your Skimlinks publisher account. You will end up with four values written
to `~/.affiliate-mcp/.env`: `SKIMLINKS_CLIENT_ID`, `SKIMLINKS_CLIENT_SECRET`,
`SKIMLINKS_PUBLISHER_ID`, and `SKIMLINKS_DOMAIN_ID`.

No prior API experience is assumed. Skimlinks uses OAuth2 client-credentials
authentication — the wizard handles the token exchange automatically once you
provide the Client ID and Secret.

## Prerequisites

- An active Skimlinks publisher account. Sign in at
  [https://hub.skimlinks.com/](https://hub.skimlinks.com/).
- API access does not require a separate approval step for standard publisher
  accounts. As long as your account is active, the API credentials are already
  provisioned.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** The Skimlinks Merchant API (used for `listProgrammes` and
`getProgramme`) requires a *Managed account* with a Product Key, which is not
available to standard publishers. If you only have a standard account, you can
still use `listTransactions`, `getEarningsSummary`, `verifyAuth`, and
`generateTrackingLink`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `SKIMLINKS_CLIENT_ID` | OAuth2 Client ID | Skimlinks Hub → Toolbox → API → API Authentication Credentials |
| `SKIMLINKS_CLIENT_SECRET` | OAuth2 Client Secret | Same page as Client ID |
| `SKIMLINKS_PUBLISHER_ID` | Your numeric publisher ID | Same page, or visible in your hub dashboard URL |
| `SKIMLINKS_DOMAIN_ID` | Your site's domain ID — the number **after the X** in your Site ID | Skimlinks Hub → Settings → Sites (e.g. if Site ID is `123456X789012`, Domain ID is `789012`) |

## Setup steps

1. Sign in to the Skimlinks publisher hub at
   [https://hub.skimlinks.com/](https://hub.skimlinks.com/). Use the same
   credentials you use to view your performance reports.

2. Click **Toolbox** in the top navigation bar.

3. From the Toolbox dropdown, select **API**.

4. Open the **API Authentication Credentials** tab. You should see three
   values:
   - **Client ID** — a short alphanumeric string.
   - **Client Secret** — a longer alphanumeric string.
   - **Publisher ID** — a numeric value (also visible in your dashboard URL,
     e.g. `https://hub.skimlinks.com/publisher/123456/dashboard`).

5. Copy the **Client ID** value and keep the page open for the next steps.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Skimlinks** when prompted. The wizard will ask for:

   - **SKIMLINKS_CLIENT_ID** — paste the value from step 5.
   - **SKIMLINKS_CLIENT_SECRET** — copy from the API Authentication Credentials
     page and paste here. The wizard validates both credentials live against the
     Skimlinks OAuth2 token endpoint immediately after you enter the secret.
   - **SKIMLINKS_PUBLISHER_ID** — the numeric ID from step 4.
   - **SKIMLINKS_DOMAIN_ID** — the number after the X in your Site ID. Find it
     at Skimlinks Hub → Settings → Sites. Your Site ID shows as e.g.
     `123456X789012`; the Domain ID is `789012`.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
SKIMLINKS_CLIENT_ID=your-client-id-here
SKIMLINKS_CLIENT_SECRET=your-client-secret-here
SKIMLINKS_PUBLISHER_ID=123456
SKIMLINKS_DOMAIN_ID=789012
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on token exchange | Wrong Client ID or Secret | Re-copy both from the API Authentication Credentials page. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential SKIMLINKS_PUBLISHER_ID` | Publisher ID not set | Add `SKIMLINKS_PUBLISHER_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| `config_error: Missing required credential SKIMLINKS_DOMAIN_ID` | Domain ID not set | Add `SKIMLINKS_DOMAIN_ID=<domain id>` to `~/.affiliate-mcp/.env`. Find it at Hub → Settings → Sites — it is the number after the X in your Site ID. |
| `not_implemented: Skimlinks Merchant API requires a Managed account` | `listProgrammes` called on a standard account | This requires a Managed Skimlinks account with a Product Key. Standard accounts cannot access this endpoint. |
| `network_api_error: non-JSON body` | Skimlinks returned an HTML error page | Check https://status.skimlinks.com for outages; wait a few minutes and retry. |
| `commissions` array is empty | Date range has no data or Publisher ID is wrong | Try a wider date window. Confirm SKIMLINKS_PUBLISHER_ID matches your account (check the hub URL). |

## Known limitations

- **listProgrammes / getProgramme**: Not available to standard publisher
  accounts. Skimlinks' Merchant API is gated behind a Managed account and
  a Product Key. Both operations throw `NotImplementedError` for standard
  publishers.
- **listClicks**: Skimlinks does not expose click-level data via the public
  publisher Reporting API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: Constructs deeplinks using the format
  `https://go.skimresources.com/?id={publisherId}X{domainId}&xs=1&url={encoded}`.
  The Domain ID (`SKIMLINKS_DOMAIN_ID`) is always a separate number from the
  Publisher ID — find it at Hub → Settings → Sites (the number after the X in
  your Site ID).
- **Token lifetime**: OAuth2 access tokens are short-lived (typically 1 hour).
  The adapter refreshes the token automatically, but cached tokens are lost on
  process restart.
- **Not verified against a live account**: This adapter was built from public
  Skimlinks API documentation. Some field names and endpoint shapes have not
  been confirmed against a live API response. The `claim_status` is `experimental`
  until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test skimlinks
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- skimlinks`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your publisher identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes`, `getProgramme`, `listClicks` → `supported: false` with
  the known-limitation note.
- `generateTrackingLink` → `supported: true` (no live probe; deterministic).
