# Setting up affiliate-mcp with Lomadee (estimated 15 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
Lomadee publisher account. Lomadee is a Brazilian affiliate network; its
developer documentation is in Portuguese. You will end up with five values
written to `~/.affiliate-mcp/.env`: `LOMADEE_APP_TOKEN`, `LOMADEE_SOURCE_ID`,
`LOMADEE_PUBLISHER_ID`, `LOMADEE_REPORT_USER`, and `LOMADEE_REPORT_PASSWORD`.

No prior API experience is assumed. Lomadee uses two credential families: an
app-token plus a source ID for the offers and deeplink APIs, and your account
e-mail plus password for the sales-report API ("Consulte suas vendas"). The
wizard handles both.

## Prerequisites

- An active Lomadee publisher (affiliate) account. Sign in at
  [https://developer.lomadee.com/](https://developer.lomadee.com/) or the
  affiliate panel.
- Lomadee may take up to 3 days to release API access on a newly created
  account. Until access is released, the "Gerar Token" step will not produce a
  usable app-token.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `LOMADEE_APP_TOKEN` | App-token for the offers and deeplink APIs | Affiliate panel → user menu → **Credenciais de API** → **Gerar Token** |
| `LOMADEE_SOURCE_ID` | The sourceId for your publisher channel | Affiliate panel (generate or copy your sourceId) |
| `LOMADEE_PUBLISHER_ID` | Your numeric publisher ID (required by the report API) | Affiliate panel → account details |
| `LOMADEE_REPORT_USER` | The e-mail you sign in with (mints the report token) | Your Lomadee/SocialSoul login e-mail |
| `LOMADEE_REPORT_PASSWORD` | The password you sign in with (mints the report token) | Your Lomadee/SocialSoul login password |

## Setup steps

1. Sign in to Lomadee at
   [https://developer.lomadee.com/](https://developer.lomadee.com/) (or the
   affiliate panel). Use the same credentials you use to view your earnings.

2. Open your user menu and select **Credenciais de API**.

3. Click **Gerar Token**. If your account is new, Lomadee may take up to 3 days
   to release access. Once available, copy the generated token — this is your
   `LOMADEE_APP_TOKEN`.

4. Find or generate your **sourceId** in the affiliate panel. This identifies
   the publisher channel that links and offers are attributed to — this is your
   `LOMADEE_SOURCE_ID`.

5. Note your numeric **publisher ID** from your account details — this is your
   `LOMADEE_PUBLISHER_ID`. It is required by the sales-report API.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Lomadee** when prompted. The wizard will ask for:

   - **LOMADEE_APP_TOKEN** — paste the value from step 3.
   - **LOMADEE_SOURCE_ID** — paste the value from step 4. The wizard validates
     the app-token and sourceId together against the Lomadee deeplink endpoint
     immediately after you enter the sourceId.
   - **LOMADEE_PUBLISHER_ID** — the numeric ID from step 5.
   - **LOMADEE_REPORT_USER** — your account e-mail.
   - **LOMADEE_REPORT_PASSWORD** — your account password. The wizard validates
     the e-mail and password together against the Lomadee createToken endpoint.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
LOMADEE_APP_TOKEN=your-app-token-here
LOMADEE_SOURCE_ID=12345678
LOMADEE_PUBLISHER_ID=654321
LOMADEE_REPORT_USER=you@example.com
LOMADEE_REPORT_PASSWORD=your-password-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error` on the deeplink endpoint | Wrong app-token or sourceId | Re-copy both from the affiliate panel → Credenciais de API. Watch for trailing spaces when pasting. |
| `auth_error: Lomadee createToken returned no token field` | Wrong report e-mail or password | Confirm `LOMADEE_REPORT_USER` and `LOMADEE_REPORT_PASSWORD` match your Lomadee sign-in. |
| `config_error: Missing required credential LOMADEE_PUBLISHER_ID` | Publisher ID not set | Add `LOMADEE_PUBLISHER_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| App-token not available in "Gerar Token" | Account access not yet released | Lomadee can take up to 3 days to release API access on a new account; wait and retry. |
| `not_implemented: Lomadee does not expose click-level data` | `listClicks` called | Lomadee has no public click-level API for publishers. |
| `network_api_error: No Lomadee store with id ... was found` | `getProgramme` for a store with no current offers | The offers surface only includes stores with live offers; use a search term via `listProgrammes` to widen it. |

## Known limitations

- **Not verified against a live account**: This adapter was built from public
  Lomadee API documentation. Some field names and endpoint shapes have not been
  confirmed against a live API response. The `claim_status` is `experimental`
  until a live account test is completed.
- **Sales-report XML**: The `reportTransaction` API returns XML whose exact
  element names are not published. The adapter parses the document defensively
  and preserves the verbatim XML on each transaction's `rawNetworkData`. The
  transaction status mapping (Portuguese state strings) and the date fields
  require live-account verification.
- **90-day report window**: The sales-report API covers a maximum of 90 days
  from the start date. `listTransactions` defaults to the most recent 90 days
  when no window is supplied.
- **listProgrammes / getProgramme**: These are derived from the Offers API
  (the distinct merchant stores carried on offers), not a joined-programmes
  endpoint. Programme status is reported as `available` because Lomadee does not
  expose per-publisher join state via this API. `getProgramme` can only return
  a store that currently has offers.
- **listClicks**: Lomadee does not expose click-level data via its public
  publisher API. The operation throws `NotImplementedError`.
- **Two credential families**: The offers and deeplink APIs authenticate with
  the app-token and sourceId; the sales-report API authenticates with a token
  minted from your account e-mail and password. Both are needed for the full
  operation set.

## Verifying

```
affiliate-networks-mcp test lomadee
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- lomadee`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your source identity.
- `listProgrammes` → returns the stores currently carrying offers.
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → aggregates the transactions in the window.
- `listClicks` → `supported: false` with the known-limitation note.
- `generateTrackingLink` → mints a Lomadee deeplink via the createLinks API.
