# Setting up affiliate-mcp with Tradedoubler (advertiser side) (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Atradedoubler%22)

This guide walks you through the credentials affiliate-mcp needs to read
your Tradedoubler **advertiser** account — the brand side that runs
programmes other publishers promote.

You will end up with two values written to `~/.affiliate-mcp/.env`:
`TRADEDOUBLER_ADV_TOKEN` and `TRADEDOUBLER_ADV_ORGANIZATION_ID`.

Tradedoubler's reporting API uses a **token-in-query-string** scheme:
the token is appended as `?token=<value>` on every request URL.
The adapter is **read-only** at v0.1: the HTTP client refuses any
non-GET method as defence-in-depth.

> **Important:** This adapter uses the Tradedoubler **REPORTS** system
> token, which is different from the token used by the Products API,
> Claims API, or Vouchers API. Make sure you copy the correct token.

## Prerequisites

- A Tradedoubler advertiser account with API access enabled.
- A user sign-in at [https://connect.tradedoubler.com/](https://connect.tradedoubler.com/).
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Credential 1 — TRADEDOUBLER_ADV_TOKEN

Your Tradedoubler REPORTS API token. This is a 40-character hexadecimal
string (SHA-1 format).

**Steps to find it:**

1. Log in to the Tradedoubler advertiser portal at
   [https://connect.tradedoubler.com/](https://connect.tradedoubler.com/).
2. Click your account name in the top-right corner.
3. Select **Manage tokens** from the dropdown menu.
4. Locate the row where the **System** column shows `REPORTS`.
5. Copy the 40-character hex token from that row.

If no REPORTS token exists:

1. Click **Generate new token** (or similar button).
2. Select `REPORTS` as the system.
3. Copy the generated token.

**Example format:** `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`

## Credential 2 — TRADEDOUBLER_ADV_ORGANIZATION_ID

Your Tradedoubler Organisation ID. This is a numeric identifier that
scopes all report queries to your advertiser account.

**Steps to find it:**

1. Log in to the Tradedoubler advertiser portal.
2. Click your account name in the top-right corner.
3. Select **Organisation Settings** from the dropdown menu.
4. The Organisation ID appears near the top of that page.

**Example format:** `123456`

## Setup steps

Run the wizard:

```
npx affiliate-networks-mcp setup
```

Select **Tradedoubler (Advertiser)** when prompted. The wizard will ask
for both credentials in the order above and run a live verification after
the Organisation ID is entered.

## Brand discovery

`listBrands` calls the `aAffiliateMyProgramsReport` report endpoint
and returns one `DiscoveredBrand` per programme in your account.
The `networkBrandId` for each brand is the Tradedoubler `programId`.

Use `affiliate_resolve_brand` to see which brands are registered after
the wizard completes.

## What each operation does

| Operation | Implementation |
|-----------|----------------|
| `listBrands` | `aAffiliateMyProgramsReport` — all programmes in the account |
| `listProgrammes` | Same report, with optional `programId` filter |
| `listMediaPartners` | Unique publishers from `aAffiliateEventBreakdownReport` (last 90 days by default) |
| `getProgrammePerformance` | `aAffiliateEventBreakdownReport` — one row per conversion event |
| `verifyAuth` | Lightweight probe against `aAffiliateMyProgramsReport` |

## Common failures

### "Tradedoubler returned HTML (login page) instead of XML"

The adapter receives an HTML page (Tradedoubler's login form) instead of
XML data. This means the `TRADEDOUBLER_ADV_TOKEN` is wrong.

**Resolution:** Go to Account → Manage tokens and copy the **REPORTS**
system token. Make sure you are not copying a token from a different
system (Products, Claims, Vouchers, etc.).

### "TRADEDOUBLER_ADV_TOKEN is missing"

The environment variable is not set.

**Resolution:** Run `npx affiliate-networks-mcp setup` and enter the
token, or manually add `TRADEDOUBLER_ADV_TOKEN=<token>` to
`~/.affiliate-mcp/.env`.

### "TRADEDOUBLER_ADV_ORGANIZATION_ID must be a numeric value"

The organisation ID contains non-numeric characters.

**Resolution:** The Organisation ID is a plain number (e.g. `123456`).
Find it at Account → Organisation Settings.

### Report returns no rows

If `listProgrammes` or `listMediaPartners` returns an empty list, check:

1. The Organisation ID corresponds to an active advertiser account.
2. For `listMediaPartners`: the default window is 90 days. If no
   publishers have converted in the last 90 days, the list will be empty.
   Pass `from` and `to` to widen the window via `getProgrammePerformance`
   instead.

## Known limitations

- **Not verified against a live account.** This adapter was built from
  public API documentation and community implementations. All endpoint
  shapes and column names carry `// TODO(verify)` annotations.
- **Read-only at v0.1.** The HTTP client refuses any non-GET request.
- **Legacy reports API.** Uses `reports.tradedoubler.com` (the classic
  Tradedoubler reporting surface) rather than the newer
  `connect.tradedoubler.com` management API. Report data is XML-based.
- **No click data.** `listClicks` is not implemented. The event breakdown
  report does not expose click-level data.
- **listMediaPartners only returns active publishers.** Only publishers
  who have generated at least one event within the query window are
  returned. Publishers with no recent events are not listed.
- **Event-level rows.** `getProgrammePerformance` returns one row per
  conversion event, not a rolled-up summary. Aggregate in your application
  if you need totals by publisher or date.

## Verifying the setup

```
npx affiliate-networks-mcp test tradedoubler-advertiser
```

This runs the capabilities check and prints which operations are
available. All operations should show `experimental` claim status at
v0.1 because the adapter has not yet been verified against a live account.
