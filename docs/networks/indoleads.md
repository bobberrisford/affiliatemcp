# Setting up affiliate-mcp with Indoleads (estimated 5 minutes)

This guide walks you through the credential affiliate-mcp needs to read your
Indoleads publisher account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `INDOLEADS_API_TOKEN`.

No prior API experience is assumed. Indoleads uses a single self-issued API
token: you generate it once in the Indoleads app and paste it into the setup
wizard.

## Prerequisites

- An active Indoleads publisher account. Sign in at
  [https://app.indoleads.com/](https://app.indoleads.com/).
- API access does not require a separate approval step. As long as your account
  is active, you can generate a token from your account settings.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** This adapter was built from the public Indoleads API documentation and
has not yet been verified against a live account. In particular, the
conversions-report endpoint path and its response field names could not be
confirmed from the public documentation; the adapter reads those fields
defensively. See "Known limitations" below.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `INDOLEADS_API_TOKEN` | Your self-issued API token | Indoleads app → Account → API Settings |

## Setup steps

1. Sign in to the Indoleads app at
   [https://app.indoleads.com/](https://app.indoleads.com/). Use the same
   credentials you use to view your performance reports.

2. Open **Account** from the main menu.

3. Select the **API Settings** page.

4. Copy the **API token** shown there. If no token is present, generate one
   first, then copy it.

5. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Indoleads** when prompted. The wizard will ask for:

   - **INDOLEADS_API_TOKEN** — paste the value from step 4. The wizard validates
     the token live against the Indoleads API immediately after you enter it.

You can also set the credential manually in `~/.affiliate-mcp/.env`:

```
INDOLEADS_API_TOKEN=your-api-token-here
```

The token is sent on every request as an `Authorization: Bearer` header.
Indoleads also accepts the token as a `?token=` query parameter, but this
adapter uses the header.

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` | Wrong or revoked token | Re-copy the token from Account → API Settings. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential INDOLEADS_API_TOKEN` | Token not set | Add `INDOLEADS_API_TOKEN=<your token>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: Indoleads does not expose click-level data` | `listClicks` called | Indoleads does not publish a click-level endpoint for publishers. There is no workaround at present. |
| `network_api_error: ... offer was not found` | `getProgramme` called with an unknown offer id | Confirm the offer id, and that your account has access to that offer. |
| `network_api_error: non-JSON body` | Indoleads returned an HTML error page | Wait a few minutes and retry; check the Indoleads status channels for outages. |
| `conversions` result is empty | Date range has no data | Try a wider date window. The default window is the last 30 days. |

## Known limitations

- **Not verified against a live account**: This adapter was built from the
  public Indoleads API documentation. Some field names and endpoint shapes have
  not been confirmed against a live API response. The `claim_status` is
  `experimental` until a live account test is completed.
- **Conversions-report endpoint unverified**: The exact path and response field
  names of the conversions report could not be confirmed from the public
  documentation snippets (the full Confluence API page is access-gated). The
  adapter targets `GET /api/conversions` and reads field names defensively.
- **listClicks**: Indoleads does not expose click-level data via the public
  publisher API. The operation throws `NotImplementedError`.
- **getProgramme**: Indoleads does not document a single-offer endpoint. The
  adapter derives a single programme by filtering the `GET /api/offers` listing
  client-side.
- **generateTrackingLink**: Makes a real API call to the offers endpoint with a
  `source_id` and reads the tracking link from the offer payload. The exact
  query parameter names and the tracking-link field name are unverified against
  a live account.
- **Date window**: The maximum date window per conversions-report call is not
  publicly documented; a live account test is required to confirm no server-side
  cap exists.

## Verifying

```
affiliate-networks-mcp test indoleads
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- indoleads`. On a successful run you should see:

- `verifyAuth` → `ok: true` with a redacted token identity.
- `listProgrammes` → returns your accessible offers (may be many).
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → derived from `listTransactions`.
- `listClicks` → `supported: false` with the known-limitation note.
- `getProgramme`, `generateTrackingLink` → `supported: true` (recorded without a
  blind probe; both need a real offer id).
