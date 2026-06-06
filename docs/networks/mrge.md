# mrge

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Amrge%22)

mrge (formerly Yieldkit/Metapic) is a commerce advertising platform that
connects publishers with advertisers across affiliate and performance marketing
campaigns.

## Prerequisites

- A publisher account on mrge. Sign up at https://publisher.mrge.com/.
- API access enabled on your account (see step 3 below).
- At least one website registered as a "site" in your publisher dashboard.

mrge does not gate API access behind a manual approval step, but new accounts
may need to be accepted by individual advertisers before commissions are
visible.

## Credentials needed

Three credentials are required:

### `MRGE_API_KEY`

Found in the mrge publisher dashboard under Account → API access. This is the
public-facing portion of your API credential pair.

### `MRGE_API_SECRET`

Found on the same page as `MRGE_API_KEY` (Account → API access). Treat this
as a secret — do not share it or commit it to version control.

### `MRGE_SITE_ID`

The hexadecimal identifier for your website within Yieldkit/mrge. Found at
`https://home.yieldkit.com/account/sites`. If you have multiple websites
registered, use the ID for the site you want to attribute commissions to.

**Important:** The site ID is a 24- or 32-character hexadecimal string
(e.g. `51e8ee76e4b0dc18d49a4337`), **not** a plain integer.
Source: Yieldkit documentation examples and live API call captures.

> BLOCKED(verify): confirm the exact dashboard labels and navigation paths
> in the current mrge-branded interface (publisher.mrge.com may have replaced
> home.yieldkit.com). The paths above are from Yieldkit documentation.

## Setup steps

1. Log in at https://home.yieldkit.com/ (or https://publisher.mrge.com/ if rebranded).
2. Navigate to **Account → API access** or go to https://home.yieldkit.com/account/api.
3. Copy the **API Key** value (a 32-character hex string) into `MRGE_API_KEY`.
4. Copy the **API Secret** value (a 32-character hex string) into `MRGE_API_SECRET`.
5. Navigate to **Account → Your Sites** or go to https://home.yieldkit.com/account/sites.
6. Copy the hexadecimal site ID of your primary website into `MRGE_SITE_ID`.
7. Run `affiliate-networks-mcp setup mrge` to validate all three credentials.

## Common failures

1. **Invalid credentials (401)** — All three credentials (API key, API secret,
   site ID) must match the same publisher account. A typo in any one of them
   returns a 401. Re-copy each value directly from the dashboard without
   leading or trailing whitespace.

2. **Wrong site ID** — If you have multiple sites registered in mrge, using
   the wrong site ID may return empty programme or commission data rather than
   a clear error. Verify the site ID in Account → Your Sites and confirm it
   corresponds to the site you intend to use.

3. **Reporting API unavailable** — The Yieldkit reporting API host used for
   commission data is `reporting-api.yieldkit.com` with path `/v3/commission`
   (host BLOCKED; cannot be confirmed without live credentials). If
   `listTransactions` fails with a connection error, the host may have changed
   in the mrge rebrand. Check `docs/findings/mrge.md` for the latest status
   and raise an issue if the endpoint has moved.

## Known limitations

- **Built from public documentation only.** This adapter has not been
  validated against a live mrge publisher account. All field names, endpoint
  paths, and response shapes are derived from the Yieldkit legacy API
  documentation and third-party integration guides. Promote `claim_status`
  from `experimental` only after live verification.

- **Public docs are limited.** The `publisher-api.mrge.com/documentation/`
  site returns HTTP 403 to automated fetches as of 2026-05-28. Consequently,
  some endpoint shapes are estimated and marked `BLOCKED(verify)` pending
  live account verification. See `docs/findings/mrge.md` for the full list.

- **Click-level data unavailable.** The mrge/Yieldkit public publisher API
  does not expose a click log endpoint. `listClicks` throws
  `NotImplementedError`. Only the click ID (`yk_tag`) is available on
  commission records.

- **Reporting API path unverified.** The commission endpoint path
  (`/v3/commission` on `reporting-api.yieldkit.com`) is derived from search
  snippets and documentation fragments. The actual path and host may differ.

- **Tracking URL format unverified.** The `generateTrackingLink` operation
  uses the `tracking_url` field from the advertiser/terms response. If that
  field is absent, a best-effort Yieldkit redirect URL is constructed. Both
  require live verification.

## Verifying

```
affiliate-networks-mcp test mrge
```

The CLI runs the live diagnostic against your configured credentials. Because
this adapter is marked `experimental`, expect some operations to fail until
the endpoint shapes are confirmed against a live account.
