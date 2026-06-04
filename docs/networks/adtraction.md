# Setting up affiliate-mcp with Adtraction (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs to read
your Adtraction affiliate account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `ADTRACTION_API_TOKEN`.

No prior API experience is assumed. Adtraction authenticates with a single API
access token that you generate inside your Adtraction account.

## Prerequisites

- An active Adtraction affiliate (publisher) account. Sign in at
  [https://adtraction.com/](https://adtraction.com/).
- The ability to generate or view your API access token in the account
  settings. No separate approval step is required for a standard affiliate
  account.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `ADTRACTION_API_TOKEN` | Your unique Adtraction API access token | Adtraction account → Account settings → API section |

The token is sent to Adtraction as a `token` query parameter on each request,
so the adapter's authentication model is recorded as `custom` rather than a
standard bearer header.

## Setup steps

1. Sign in to your Adtraction account at
   [https://adtraction.com/](https://adtraction.com/).

2. Open **Account settings** from the top-right menu.

3. Find the **API** section.

4. Copy the existing **API access token**, or generate a new one if none is
   shown.

5. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Adtraction** when prompted. The wizard will ask for:

   - **ADTRACTION_API_TOKEN** — paste the token from step 4. The wizard
     validates it live against the Adtraction API immediately, so you learn at
     once if it is wrong.

You can also set the credential manually in `~/.affiliate-mcp/.env`:

```
ADTRACTION_API_TOKEN=your-api-token-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` | Wrong or expired token | Re-copy the token from Account settings → API. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential ADTRACTION_API_TOKEN` | Token not set | Add `ADTRACTION_API_TOKEN=<your token>` to `~/.affiliate-mcp/.env`, or rerun the setup wizard. |
| `rate_limit` after several quick calls | Adtraction limits most endpoints to roughly 30 requests per minute | Wait a minute and retry; narrow your date window so fewer calls are needed. |
| `not_implemented: Adtraction does not expose click-level data` | `listClicks` called | Adtraction's affiliate API does not return click-level data; this is expected. |
| `not_implemented: ... tracking links are programme-specific` | `generateTrackingLink` called | Read the `trackingURL` on the Programme returned by `listProgrammes` / `getProgramme`; Adtraction issues tracking links per approved programme. |
| `network_api_error: non-JSON body` | Adtraction returned an HTML error page | Wait a few minutes and retry; check the Adtraction status if it persists. |
| `transactions` array is empty | Date range has no data, or the account has no transactions yet | Try a wider date window and confirm the token belongs to the right account. |

## Known limitations

- **Not verified against a live account**: this adapter was built from public
  Adtraction API documentation and third-party integration guides. The exact v3
  endpoint paths (`/v3/affiliate/transactions/`, `/v3/affiliate/programs/`),
  the request and response field names, and the API host
  (`api.adtraction.com` versus `api.adtraction.net`) have not been confirmed
  against a live API response. The `claim_status` is `experimental` until a live
  account test is completed.
- **Authentication**: the API access token is sent as a `token` query parameter,
  not an Authorization header. The adapter's `auth_model` is therefore `custom`.
- **listClicks**: Adtraction does not expose click-level data via the affiliate
  API. The operation throws `NotImplementedError` rather than returning an empty
  list.
- **generateTrackingLink**: Adtraction does not provide a deterministic,
  account-wide tracking-link template. Tracking links are programme-specific and
  are returned per approved programme (the `trackingURL` field on the programmes
  endpoint). The operation throws `NotImplementedError`; read the `trackingURL`
  on the Programme returned by `listProgrammes` / `getProgramme` instead.
- **Multiple currencies**: Adtraction spans several Nordic markets. Transaction
  currency is read per row. The earnings summary's top-level currency is the
  first transaction's currency; for a mixed-currency account, read the
  per-programme currency on each row.
- **Rate limit**: most endpoints allow roughly 30 requests per minute (some
  10 per minute). Large date windows may need to be split by the caller.

## Verifying

```
affiliate-networks-mcp test adtraction
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- adtraction`. On a successful run you should see:

- `verifyAuth` → `ok: true` with a masked-token identity.
- `listProgrammes` → your approved programmes (may be empty).
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → aggregated from the transactions above.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
