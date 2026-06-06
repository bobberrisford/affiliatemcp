# Setting up affiliate-mcp with Adservice (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aadservice%22)

This guide walks you through the credentials affiliate-mcp needs to read your
Adservice publisher account. You will end up with two required values written to
`~/.affiliate-mcp/.env`: `ADSERVICE_UID` and `ADSERVICE_LOGIN_TOKEN`, plus an
optional `ADSERVICE_AFFILIATE_ID`.

Adservice is a Nordic publisher-side affiliate network, now part of the merged
Adtraction/Adservice group. Its first-party publisher API documentation lives at
[https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html](https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html).

No prior API experience is assumed. Adservice authenticates each request with a
`UID` and a `LoginToken` sent as cookies; the wizard handles that for you once
you supply the two values.

## Prerequisites

- An active Adservice publisher account. Sign in at
  [https://publisher.adservice.com/](https://publisher.adservice.com/).
- API access does not require a separate approval step. As long as your account
  is active, you can obtain the API credentials yourself.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** This adapter was built from public API documentation and has not yet
been verified against a live Adservice account. Several endpoint and field
details are marked `BLOCKED(verify)` in the source and known limitations below.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `ADSERVICE_UID` | Publisher/client ID, sent as the `UID` cookie | Obtained via the Account API (`/Account.pl/loginToken`) in your Adservice account |
| `ADSERVICE_LOGIN_TOKEN` | Login token, sent as the `LoginToken` cookie | Obtained alongside the UID via `/Account.pl/loginToken` |
| `ADSERVICE_AFFILIATE_ID` | Optional. Affiliate ID shown in the Account section | The Account section of the publisher dashboard. Used only as an identity label; not sent on requests |

The exact way to obtain `UID` and `LoginToken` via `/Account.pl/loginToken` is
documented in the Adservice publisher API docs. The shape of that call could not
be confirmed against a live account at the time of writing
(`BLOCKED(verify)`); treat the values as account-derived credentials you copy
into your config.

## Setup steps

1. Sign in to the Adservice publisher interface at
   [https://publisher.adservice.com/](https://publisher.adservice.com/).

2. Open the API documentation at
   [Statistics.pl](https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html)
   and follow the `/Account.pl/loginToken` instructions to obtain your **UID**
   and **LoginToken**.

3. (Optional) Note your **Affiliate ID** from the Account section of the
   dashboard if you want it shown in diagnostics.

4. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Adservice** when prompted. The wizard will ask for:

   - **ADSERVICE_UID** — paste the UID from step 2.
   - **ADSERVICE_LOGIN_TOKEN** — paste the LoginToken from step 2. The wizard
     validates both values live against the Adservice Statistics API immediately
     after you enter the token.
   - **ADSERVICE_AFFILIATE_ID** — optional; leave blank if you do not know it.

You can also set the credentials manually in `~/.affiliate-mcp/.env`:

```
ADSERVICE_UID=12345
ADSERVICE_LOGIN_TOKEN=your-login-token-here
ADSERVICE_AFFILIATE_ID=aff-67890
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` or `HTTP 403` | Wrong or expired UID/LoginToken | Re-obtain both via `/Account.pl/loginToken`. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential ADSERVICE_UID` | UID not set | Add `ADSERVICE_UID=<your uid>` to `~/.affiliate-mcp/.env`. |
| `config_error: Missing required credential ADSERVICE_LOGIN_TOKEN` | LoginToken not set | Add `ADSERVICE_LOGIN_TOKEN=<your token>` to `~/.affiliate-mcp/.env`. |
| `network_api_error: non-JSON body` | Adservice returned an HTML login page | The session was rejected. Re-obtain UID and LoginToken; they may have expired. |
| `not_implemented: ... listClicks ...` | `listClicks` called | Adservice exposes aggregate click counts only, not row-level click events. |
| `not_implemented: ... tracking-link ...` | `generateTrackingLink` called | The deeplink format is not documented publicly; this operation is unsupported. |
| Transactions look like daily/per-campaign totals | Expected | `Statistics.pl` returns aggregate statistics; each transaction is a summary row, not an individual sale. |

## Known limitations

- **Not verified against a live account**: This adapter was built from public
  Adservice API documentation. Several endpoint and field details have not been
  confirmed against a live API response. The `claim_status` is `experimental`
  until a live account test is completed.
- **Authentication**: Uses a `UID` and a `LoginToken` supplied as cookies on
  every request, obtained via `/Account.pl/loginToken`. The exact login exchange
  shape is `BLOCKED(verify)` — the documentation host returns HTTP 403 to
  automated fetches, so the adapter takes the two values as configured
  credentials.
- **listTransactions returns summary rows**: `Statistics.pl` returns aggregate
  statistics grouped by a dimension (campaign, date), not row-level conversions.
  Each transaction represents a campaign/date group's summed earnings (settled
  and, separately, pending), not an individual sale. Whether a row-level
  conversion endpoint exists is `BLOCKED(verify)`.
- **listClicks**: Adservice exposes aggregate click counts via `Statistics.pl`
  but no row-level click-event endpoint (per-click timestamp/referrer). The
  operation throws `NotImplementedError`.
- **generateTrackingLink**: The deeplink/redirect URL format is not documented
  in any accessible public source. The operation throws `NotImplementedError`.
- **Field names and host**: Exact `Statistics.pl` / `Campaigns.pl` response
  field names and the precise base host are inferred from public docs and
  third-party guides (`BLOCKED(verify)`). The adapter reads every field
  defensively and preserves the verbatim payload in `rawNetworkData`.

## Verifying

```
affiliate-networks-mcp test adservice
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- adservice`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your identity.
- `listProgrammes` → may return campaigns from `Campaigns.pl`.
- `listTransactions` → summary rows; may return 0 records if your date window is
  empty.
- `getEarningsSummary` → derived from `listTransactions`.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
