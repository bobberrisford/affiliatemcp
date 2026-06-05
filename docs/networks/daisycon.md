# Setting up affiliate-mcp with Daisycon (estimated 15 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
Daisycon publisher account. You will end up with four values written to
`~/.affiliate-mcp/.env`: `DAISYCON_CLIENT_ID`, `DAISYCON_CLIENT_SECRET`,
`DAISYCON_REFRESH_TOKEN`, and `DAISYCON_PUBLISHER_ID`.

Daisycon uses OAuth2. The initial consent is interactive (authorisation code
with PKCE); once you have completed it you receive a refresh token, which the
adapter uses to obtain short-lived access tokens without any further browser
step.

## Prerequisites

- An active Daisycon publisher account. Sign in at
  [https://www.daisycon.com/](https://www.daisycon.com/).
- You self-create OAuth credentials in the Daisycon console; there is no
  separate manual approval step.
- A terminal in which you can run the one-time OAuth authorisation and then
  `npx affiliate-networks-mcp setup`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `DAISYCON_CLIENT_ID` | OAuth2 Client ID | Daisycon console → Settings → API / OAuth → create an OAuth client |
| `DAISYCON_CLIENT_SECRET` | OAuth2 Client Secret | Same page as the Client ID |
| `DAISYCON_REFRESH_TOKEN` | OAuth2 refresh token from the one-time authorisation | Produced by the authorisation step (see below) |
| `DAISYCON_PUBLISHER_ID` | Your numeric publisher ID | Daisycon console URL and account settings |

## Setup steps

1. Sign in to the Daisycon publisher console at
   [https://www.daisycon.com/](https://www.daisycon.com/).

2. Open **Settings → API / OAuth** and create a new OAuth client. You choose a
   redirect URI yourself. Copy the **Client ID** and **Client Secret**.

3. Complete the one-time OAuth authorisation to obtain a refresh token.
   Daisycon publishes example clients that do this for you at
   [https://github.com/DaisyconBV/oauth-examples](https://github.com/DaisyconBV/oauth-examples).
   The PHP CLI client, for instance, is run as:

   ```
   php PHP/cli-client.php --clientId CLIENT_ID --clientSecret CLIENT_SECRET --outputFile tokens.json
   ```

   It opens the Daisycon authorisation page, you grant access, and it writes a
   `tokens.json` containing the `refresh_token`. Copy that `refresh_token`
   value.

4. Find your numeric **Publisher ID** in the console URL when logged in, or on
   the Account / Settings page.

5. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Daisycon** when prompted. The wizard asks for:

   - **DAISYCON_CLIENT_ID** — paste from step 2.
   - **DAISYCON_CLIENT_SECRET** — paste from step 2.
   - **DAISYCON_REFRESH_TOKEN** — paste from step 3. The wizard validates the
     three OAuth values together against the Daisycon token endpoint
     immediately after you enter the refresh token.
   - **DAISYCON_PUBLISHER_ID** — the numeric ID from step 4.

You can also set the credentials manually in `~/.affiliate-mcp/.env`:

```
DAISYCON_CLIENT_ID=your-client-id-here
DAISYCON_CLIENT_SECRET=your-client-secret-here
DAISYCON_REFRESH_TOKEN=your-refresh-token-here
DAISYCON_PUBLISHER_ID=123456
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on token exchange | Wrong Client ID/Secret, or an expired refresh token | Re-copy the Client ID and Secret. If the refresh token has expired, re-run the authorisation step to obtain a fresh one. |
| `auth_error: ... no access_token field` | Refresh token revoked or rotated | Re-run the one-time authorisation step and update `DAISYCON_REFRESH_TOKEN`. |
| `config_error: Missing required credential DAISYCON_PUBLISHER_ID` | Publisher ID not set | Add `DAISYCON_PUBLISHER_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| `config_error: Missing required credential DAISYCON_REFRESH_TOKEN` | Refresh token not set | Complete the authorisation step and add the refresh token to your config. |
| `not_implemented: ... click-level data` | `listClicks` called | Daisycon does not expose click-level data via the public publisher API. |
| `not_implemented: ... programme/media binding` | `generateTrackingLink` called | Daisycon click URLs cannot be constructed from credentials alone; copy the click URL from your programme in the Daisycon console. |
| `network_api_error: non-JSON body` | Daisycon returned an HTML error page | Wait a few minutes and retry; check the Daisycon status page. |
| transactions list is empty | Date window has no data, or Publisher ID is wrong | Try a wider window. Confirm `DAISYCON_PUBLISHER_ID` matches your account. |

## Known limitations

- **Not verified against a live account**: this adapter was built from public
  Daisycon API documentation and example clients. Some field names and endpoint
  shapes have not been confirmed against a live API response. The
  `claim_status` is `experimental` until a live account test is completed.
- **OAuth flow**: Daisycon's initial consent is interactive (authorisation code
  with PKCE). The adapter uses the refresh-token grant for ongoing access, so
  you must complete the one-time authorisation to obtain `DAISYCON_REFRESH_TOKEN`.
  Whether Daisycon also offers a pure client-credentials grant for first-party
  accounts is not confirmed publicly.
- **listClicks**: Daisycon does not expose click-level data via the public
  publisher API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: a Daisycon tracking (click) URL is issued per
  programme/media binding and is not deterministically constructible from
  credentials alone. The operation throws `NotImplementedError`; obtain the
  click URL from the programme in the Daisycon console.
- **Programmes endpoint**: the exact `/publishers/{id}/programs` path and the
  maximum `per_page` page size are confirmed only via secondary sources;
  live account verification is required.
- **Multi-currency**: transactions can mix currencies. The adapter reads the
  currency per row; the earnings summary reports its headline total in the
  first currency seen, and preserves the verbatim per-row currency on each
  transaction.
- **Token lifetime**: OAuth2 access tokens are short-lived. The adapter
  refreshes the access token automatically, but cached tokens are lost on
  process restart, and the refresh token itself may expire.

## Verifying

```
affiliate-networks-mcp test daisycon
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- daisycon`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your publisher identity.
- `listProgrammes` / `listTransactions` → may return 0 records if your account
  or date window is empty.
- `getEarningsSummary` → derived from `listTransactions`.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
