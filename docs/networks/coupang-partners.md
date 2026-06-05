# Setting up affiliate-mcp with Coupang Partners (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
Coupang Partners (쿠팡 파트너스) publisher account. You will end up with two
values written to `~/.affiliate-mcp/.env`: `COUPANG_PARTNERS_ACCESS_KEY` and
`COUPANG_PARTNERS_SECRET_KEY`.

No prior API experience is assumed. Coupang Partners signs each request with an
HMAC-SHA256 signature derived from your Access Key and Secret Key; the adapter
builds that signature for you on every call.

## Prerequisites

- An active, approved Coupang Partners account. Sign in at
  [https://partners.coupang.com/](https://partners.coupang.com/).
- Open API access. Coupang only shows the Open API menu once your account is
  approved and has met the minimum sales threshold Coupang requires to unlock
  the API. If you do not see the Open API menu, you do not yet have API access.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** Coupang Partners is a single-merchant network: you promote Coupang
itself, so there is no list of merchant programmes to join. The adapter does not
implement `listProgrammes` or `getProgramme`. You can still use
`listTransactions`, `getEarningsSummary`, `verifyAuth`, and
`generateTrackingLink`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|------------------|
| `COUPANG_PARTNERS_ACCESS_KEY` | The public half of your Open API key pair | Coupang Partners → 도구 (Tools) → 오픈 API (Open API) → Access Key |
| `COUPANG_PARTNERS_SECRET_KEY` | The secret half; used to sign each request | Same page → Secret Key |

## Setup steps

1. Sign in to the Coupang Partners dashboard at
   [https://partners.coupang.com/](https://partners.coupang.com/).

2. Open the **도구** (Tools) menu in the top navigation.

3. Select **오픈 API** (Open API).

4. If you have not generated keys yet, click the issue button (발급) to create an
   API key pair. You will see two values:
   - **Access Key** — issued to you; safe to display.
   - **Secret Key** — keep this private; it signs your requests.

5. Copy the **Access Key** and keep the page open for the next step.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Coupang Partners** when prompted. The wizard will ask for:

   - **COUPANG_PARTNERS_ACCESS_KEY** — paste the value from step 5.
   - **COUPANG_PARTNERS_SECRET_KEY** — copy from the Open API page and paste
     here. The wizard signs a live one-day commission-report request to validate
     both keys immediately after you enter the Secret Key.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
COUPANG_PARTNERS_ACCESS_KEY=your-access-key-here
COUPANG_PARTNERS_SECRET_KEY=your-secret-key-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `auth_error: HTTP 401` or `403` on a report call | Wrong key, mismatched key pair, or clock skew | Re-copy both keys from the Open API page. Watch for trailing spaces. The signature embeds a GMT timestamp, so make sure your machine clock is accurate. |
| `rate_limit: HTTP 429` | Too many calls in a short window | Coupang enforces strict rate limits (the product-search endpoint is documented at roughly 10 calls per hour; reports are similarly throttled). Wait, then space out your calls. |
| `config_error: Missing required credential COUPANG_PARTNERS_SECRET_KEY` | Secret Key not set | Add `COUPANG_PARTNERS_SECRET_KEY=<your key>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: ... single-merchant network ...` | `listProgrammes` / `getProgramme` called | Coupang Partners has no programme list. Use `listTransactions` and `getEarningsSummary` instead. |
| `not_implemented: ... click-level data ...` | `listClicks` called | Coupang exposes only an aggregate daily click count, not per-click rows. |
| `network_api_error: deeplink API returned no shortenUrl` | Destination URL is not a valid Coupang URL | `generateTrackingLink` only works for `coupang.com` product and category URLs. |

## Known limitations

- **Not verified against a live account**: This adapter was built from public
  Coupang Partners API documentation and reference clients. Some field names and
  endpoint shapes have not been confirmed against a live API response. The
  `claim_status` is `experimental` until a live account test is completed.
- **Strict rate limits**: The Coupang Open API throttles aggressively (the
  affiliate product-search endpoint is documented at roughly 10 calls per hour;
  the reports endpoint is similarly limited). Frequent polling returns HTTP 429.
- **listProgrammes / getProgramme**: Not implemented. Coupang Partners is a
  single-merchant network and exposes no programme-listing API. Both operations
  throw `NotImplementedError`.
- **listClicks**: Not implemented. The commission report carries only an
  aggregate daily `clickCount`, not per-click rows. The operation throws
  `NotImplementedError`.
- **listTransactions returns daily aggregates**: The reports/commission endpoint
  returns one row per day (date, clickCount, orderCount, gmv, commission), not
  individual orders. There is no per-row settlement status, so every transaction
  is normalised to status `other`, and the amounts are daily totals in KRW.
- **generateTrackingLink is a live API call**: Unlike some networks, Coupang
  mints the tracking URL server-side via the deeplink endpoint, so it is subject
  to the same rate limits.

## Verifying

```
affiliate-networks-mcp test coupang-partners
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- coupang-partners`. On a successful run you should
see:

- `verifyAuth` → `ok: true` with your access-key identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes`, `getProgramme`, `listClicks` → `supported: false` with the
  known-limitation note.
- `generateTrackingLink` → `supported: true` (a live deeplink call).
