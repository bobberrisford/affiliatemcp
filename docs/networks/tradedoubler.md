# Tradedoubler — Publisher Adapter

**Status:** Experimental  
**Side:** Publisher  
**Adapter version:** 0.1.0  
**Last verified:** 2026-05-28 (built from public docs; not yet verified against a live account)

## Overview

Tradedoubler is a European performance marketing network. This adapter targets the modern
[Publisher Management API](https://docs.tradedoubler.com/publisher) hosted at
`https://connect.tradedoubler.com`, which uses OAuth2 bearer tokens.

Note: Tradedoubler also operates an older `api.tradedoubler.com` surface (Products, Vouchers,
Claims) that uses per-product tokens passed as `?token=` query parameters. This adapter does
**not** use that surface; it uses the newer `connect.tradedoubler.com` bearer-token API.

## Prerequisites

- A Tradedoubler publisher account.
- An API token generated in the dashboard (see Setup below).
- Your numeric organisation ID.

## Setup

### 1. Generate an API Token

1. Log in at [https://login.tradedoubler.com/](https://login.tradedoubler.com/).
2. Navigate to **Account → Manage tokens**.
3. Create a new API token for the publisher account.
4. Copy the token value — it will not be shown again.

### 2. Find Your Organisation ID

Your organisation ID is a numeric string visible in the Tradedoubler dashboard URL after login,
for example: `https://login.tradedoubler.com/home/1234567` — `1234567` is your organisation ID.
It is also visible in **Account → Organisation settings**.

### 3. Configure Credentials

Add the following to `~/.affiliate-mcp/.env`:

```
TRADEDOUBLER_API_TOKEN=your_bearer_token_here
TRADEDOUBLER_ORGANIZATION_ID=1234567
```

Or run the interactive wizard:

```bash
affiliate-networks-mcp setup tradedoubler
```

## Supported Operations

| Operation | Status | Notes |
|-----------|--------|-------|
| `listProgrammes` | Experimental | Lists programmes via `GET /publisher/programs` |
| `getProgramme` | Experimental | Single programme detail via `GET /publisher/programs/detail` |
| `listTransactions` | Experimental | Conversions via `GET /publisher/report/transactions` |
| `getEarningsSummary` | Experimental | Derived from `listTransactions` |
| `listClicks` | Not supported | Tradedoubler does not expose per-click records via the publisher API |
| `generateTrackingLink` | Experimental | Deterministic construction via `clk.tradedoubler.com/click` |
| `verifyAuth` | Experimental | Token check via `GET /usermanagement/users/me` |

## Tracking Link Format

Tracking links follow the Tradedoubler standard format:

```
https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedDestinationUrl}
```

- `p` — Programme ID (mandatory).
- `a` — Publisher site/affiliate ID (uses `TRADEDOUBLER_ORGANIZATION_ID`).
- `url` — Destination URL, URL-encoded. Must be the last parameter.

## Authentication

**Auth model:** OAuth2 bearer token  
**Header:** `Authorization: Bearer {token}`  
**Token location:** HTTP request header (not query parameter)

## Transaction Status Mapping

Tradedoubler uses single-character status codes:

| Tradedoubler | Canonical |
|-------------|-----------|
| `A` (Accepted) | `approved` |
| `P` (Pending) | `pending` |
| `D` (Denied) | `reversed` |
| `paid: true` flag | `paid` |
| Any other | `other` |

## Programme Status Mapping

| Tradedoubler | Canonical |
|-------------|-----------|
| `JOINED` | `joined` |
| `APPLIED` | `pending` |
| `DECLINED` | `declined` |
| `NOT_JOINED` | `available` |
| `TERMINATED` | `suspended` |
| Anything else | `unknown` |

## Known Limitations

- **Not verified against a live account.** All field mappings carry `// TODO(verify)` annotations where the exact API response shape has not been confirmed with real credentials.
- **No click-level data.** `listClicks` throws `NotImplementedError`. Aggregated click statistics are available via the Tradedoubler dashboard only.
- **Separate token types.** The older `api.tradedoubler.com` surface (Products, Vouchers, Claims) uses per-product tokens (`?token=` query parameter). This adapter does not address that surface.
- **Organisation ID required.** `TRADEDOUBLER_ORGANIZATION_ID` must be set manually; auto-derivation from the token is not implemented at v0.1.
- **Pagination max 100 per page.** Tradedoubler's API caps `limit` at 100 results per request; the adapter paginates automatically.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRADEDOUBLER_API_TOKEN` | Yes | OAuth2 bearer token from Account → Manage tokens |
| `TRADEDOUBLER_ORGANIZATION_ID` | Yes | Numeric publisher organisation ID |

## API Documentation

- Publisher Management API (Apiary): https://docs.tradedoubler.com/publisher
- Developer portal: https://dev.tradedoubler.com/
- Tracking documentation: https://dev.tradedoubler.com/link-converter/publisher/
