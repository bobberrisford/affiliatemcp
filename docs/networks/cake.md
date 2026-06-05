# CAKE (Publisher / Affiliate side)

**Claim status:** experimental
**Adapter version:** 0.1.0
**Last verified:** 2026-06-05
**API docs:** <https://support.getcake.com/support/solutions/folders/5000173061>

---

## Overview

CAKE (getcake) is a performance-marketing platform used by affiliate networks
and brands to track and manage campaigns. CAKE is a per-instance engine: every
CAKE-powered network runs on its own host. This adapter integrates with the
**Affiliate API** (publisher side), allowing you to list offers (programmes),
read a single offer, pull conversion reports, and derive an earnings summary.

Because CAKE is per-instance, the API base URL is itself a credential. There is
no shared global CAKE host. You supply your instance host via `CAKE_BASE_URL`,
your Affiliate API Key via `CAKE_API_KEY`, and your numeric Affiliate ID via
`CAKE_AFFILIATE_ID`.

> **Note:** the CAKE affiliate API returns XML, not JSON. The adapter parses the
> XML internally; this is transparent to you as a user.

---

## Prerequisites

- An active affiliate account on a CAKE-powered network.
- Access to the affiliate portal you log in to (this provides your instance
  host, your Affiliate ID, and your API Key).

---

## Credentials needed

| Variable | Required | Description |
|---|---|---|
| `CAKE_BASE_URL` | Yes | Your CAKE instance host, including scheme, e.g. `https://your-network.cakemarketing.com`. This is the domain you log in to. |
| `CAKE_API_KEY` | Yes | Your Affiliate API Key, passed to CAKE as the `api_key` query parameter. |
| `CAKE_AFFILIATE_ID` | Yes | Your numeric Affiliate ID. |

---

## Setup steps

### 1. Find your instance host, Affiliate ID, and API Key

1. Log in to your CAKE affiliate portal.
2. The instance host is the domain shown in your browser address bar, including
   the scheme (for example `https://your-network.cakemarketing.com`). Copy the
   host only, with no path.
3. Click **Reporting API** in the top-right of the portal. That panel shows your
   **Affiliate ID** and your **API Key**.

### 2. Configure credentials

Run the setup wizard:

```bash
affiliate-networks-mcp setup cake
```

Or add credentials manually to `~/.affiliate-mcp/.env`:

```env
CAKE_BASE_URL=https://your-network.cakemarketing.com
CAKE_AFFILIATE_ID=12345
CAKE_API_KEY=your-affiliate-api-key
```

### 3. Verify the connection

```bash
affiliate-networks-mcp doctor cake
```

A successful check reports an identity of the form
`cake/<your-host>/affiliate/<your-affiliate-id>`.

---

## Supported operations

| Operation | Status | Notes |
|---|---|---|
| `listProgrammes` | Experimental | Lists offers via `GET /affiliates/api/4/offers.asmx/OfferFeed`. Search, status, and category filters are applied client-side. |
| `getProgramme` | Experimental | Fetches a single offer by numeric ID via `GET /affiliates/api/2/offers.asmx/GetCampaign`. |
| `listTransactions` | Experimental | Conversion report via `GET /affiliates/api/5/reports.asmx/Conversions`. Wide date ranges are split into 31-day calls automatically. |
| `getEarningsSummary` | Experimental | Derived from `listTransactions` — aggregates commission by programme and status. |
| `listClicks` | Unsupported | CAKE's documented affiliate reporting surface exposes conversions, not affiliate-scoped click rows; the Clicks report is admin-side. |
| `generateTrackingLink` | Unsupported | CAKE tracking links are assigned server-side per creative; no documented deterministic construction exists for the affiliate API. |
| `verifyAuth` | Experimental | Cheap probe via the OfferFeed endpoint with a single-row limit. |

---

## Known limitations

- **Adapter built from public API documentation; not yet verified against a live
  CAKE instance.**
- **The API base is the per-instance CAKE host**, supplied via `CAKE_BASE_URL`,
  not a fixed value.
- **Conversion amounts are assumed to be major currency units** (for example
  dollars, not cents). CAKE renders money as decimal strings such as `6.00`.
- **Click-level data is not exposed** via the documented CAKE affiliate
  reporting API; `listClicks` is unsupported.
- **Tracking links are assigned server-side** per creative; `generateTrackingLink`
  is unsupported.

---

## API reference

| Endpoint | Method | Description |
|---|---|---|
| `/affiliates/api/4/offers.asmx/OfferFeed` | GET | List offers visible to the affiliate. |
| `/affiliates/api/2/offers.asmx/GetCampaign` | GET | Single offer / campaign detail. |
| `/affiliates/api/5/reports.asmx/Conversions` | GET | Conversion report for a date window. |

Authentication is by the `api_key` query parameter plus `affiliate_id`. Dates
use `MM/DD/YYYY HH:mm:ss`. Report endpoints page with `start_at_row` and
`row_limit`.

---

## Common failures

1. **`config_error: Missing required credential CAKE_BASE_URL`**
   The instance host has not been configured. Run `affiliate-networks-mcp setup cake`
   or add `CAKE_BASE_URL` to `~/.affiliate-mcp/.env`.

2. **`config_error: CAKE_BASE_URL is not a valid URL`**
   Include the scheme and host only, for example
   `https://your-network.cakemarketing.com`, with no trailing path.

3. **`auth_error: HTTP 401`**
   The API key is invalid, revoked, or copied incorrectly, or `CAKE_BASE_URL`
   points at the wrong instance. Re-check the Reporting API panel in your
   affiliate portal.

---

## Verifying

```bash
affiliate-networks-mcp test cake
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- cake`.
