# Setting up affiliate-mcp with Afilio (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
Afilio affiliate account. You will end up with two values written to
`~/.affiliate-mcp/.env`: `AFILIO_AFFILIATE_TOKEN` and `AFILIO_AFF_ID`.

No prior API experience is assumed. Afilio's affiliate APIs use a simple
token-and-id scheme: both values are sent as query parameters on every request,
so there is no OAuth flow and no token to refresh.

Afilio is a Brazilian network and reports amounts in Brazilian reais (BRL).

## Prerequisites

- An active Afilio affiliate account. Sign in at
  [https://v2.afilio.com.br/](https://v2.afilio.com.br/).
- The Affiliate API token is self-issued from your account; there is no separate
  approval step. As long as your account is active you can read the token from
  the dashboard.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** This adapter was built from Afilio's public API documentation. The
documentation PDFs are served behind a bot filter, so the exact XML field names
and the Campaign Description endpoint could not be confirmed verbatim. The
adapter reads fields defensively and preserves every original value under
`rawNetworkData`. The `claim_status` is `experimental` until the adapter is
confirmed against a live account.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `AFILIO_AFFILIATE_TOKEN` | Your Affiliate API token | Afilio dashboard → **Login** area → **API token** |
| `AFILIO_AFF_ID` | Your numeric Affiliate ID | Afilio dashboard → your account / profile area (sent as the `affid` parameter) |

## Setup steps

1. Sign in to the Afilio dashboard at
   [https://v2.afilio.com.br/](https://v2.afilio.com.br/). Use the same
   credentials you use to view your performance reports.

2. Find your **Aff ID** (numeric Affiliate ID) in your account / profile area.

3. Open the **Login** area of your account and copy the value shown under
   **API token**. This is your `AFILIO_AFFILIATE_TOKEN`.

4. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Afilio** when prompted. The wizard will ask for:

   - **AFILIO_AFF_ID** — the numeric ID from step 2.
   - **AFILIO_AFFILIATE_TOKEN** — the token from step 3. The wizard validates the
     token live against the Afilio Sales API using the Aff ID you just entered.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
AFILIO_AFF_ID=123456
AFILIO_AFFILIATE_TOKEN=your-api-token-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: Afilio returned an error document` | Wrong token or Aff ID | Re-copy the token from Login → API token, and confirm the Aff ID is your numeric Affiliate ID. Watch for trailing spaces when pasting. |
| `auth_error: HTTP 401` / `HTTP 403` | Token or Aff ID not accepted | Confirm both values in the dashboard. The token is case-sensitive. |
| `config_error: Missing required credential AFILIO_AFFILIATE_TOKEN` | Token not set | Add `AFILIO_AFFILIATE_TOKEN=<your token>` to `~/.affiliate-mcp/.env`. |
| `config_error: Missing required credential AFILIO_AFF_ID` | Aff ID not set | Add `AFILIO_AFF_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: ... click-level data` | `listClicks` was called | Afilio does not expose click-level data to affiliates via a documented API. |
| `not_implemented: ... deterministic ... tracking-link` | `generateTrackingLink` was called | Afilio deeplinks are generated inside the dashboard; there is no documented affiliate-side link format to construct. |
| Transactions list is empty | Date range has no data, or the field names differ from a live account | Try a wider date window. If sales exist in the dashboard but not here, the XML field names may differ from those reconstructed from the docs; please file a finding. |

## Known limitations

- **Built from public documentation, not yet verified against a live account.**
  The `claim_status` is `experimental`.
- **XML field names unconfirmed.** Afilio's documentation PDFs are behind a bot
  filter, so the exact XML element names, the exact Campaign Description endpoint
  filename, and the full status vocabulary could not be read verbatim. The
  adapter tries several candidate field names and keeps every original value in
  `rawNetworkData`.
- **listClicks**: Afilio does not expose click-level data to affiliates via a
  documented API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: Afilio deeplinks are generated inside the dashboard.
  No deterministic affiliate-side link format (from a campaign id and Aff ID) is
  documented, so the operation throws `NotImplementedError` rather than emit a
  guessed URL that would silently fail to track.
- **getProgramme** filters the Campaign Description list client-side; Afilio does
  not document a single-campaign lookup endpoint.
- **Currency** defaults to BRL when a response omits a currency field.

## Verifying

```
affiliate-networks-mcp test afilio
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- afilio`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your `afilio/affid:<id>` identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes` → returns the campaigns your account can see.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
