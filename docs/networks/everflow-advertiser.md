# Everflow (Advertiser) — Setup Guide

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aeverflow%22)

This document describes how to connect the Everflow advertiser adapter.
The adapter integrates with the Everflow Network API on the brand/advertiser side,
giving you access to affiliate performance data for your programme.

> **Note:** This adapter has been built from public API documentation and has
> not yet been verified against a live account. Endpoint shapes and field names
> have been confirmed from Everflow's public developer documentation via
> web research (2026-05-28). See
> [docs/findings/everflow-advertiser.md](../findings/everflow-advertiser.md)
> for the current verification status.

---

## Prerequisites

- An active Everflow network account (advertiser side).
- A **Network API key** created by the network admin (not self-service; see below).
- Your **advertiser ID** (`network_advertiser_id`) — a positive integer.

---

## Credentials needed

### `EVERFLOW_API_KEY`

Your Everflow Network API key. This key is created by the **network admin**, not
by the advertiser user directly.

To obtain one:

1. Ask your Everflow account manager or network admin to log in to the Everflow UI.
2. Navigate to **Control Center → Security → API Keys**.
3. Click **Generate API Key**.
4. Enter a descriptive label (e.g. `affiliate-mcp-advertiser-integration`).
5. Set appropriate permission scopes — limit to the minimum required for reporting
   (read access to advertisers and affiliates).
6. Click **Generate**. The key is displayed **only once** — copy it immediately.
7. Share the key via a secure channel (e.g. a password manager) with the
   integration operator.

**Security note:** Network API keys grant access to all advertisers on the
network that the key's scopes permit. Create narrowly scoped keys per
integration rather than reusing a single admin key.

### `EVERFLOW_ADVERTISER_ID`

The numeric `network_advertiser_id` of the advertiser account to integrate with.

To find it:

1. Log in to the Everflow UI.
2. Navigate to **Advertisers** in the left-hand menu.
3. Click on the advertiser account.
4. Read the ID from the URL bar — for example, `/advertisers/42` → use `42`.

Alternatively, after setting `EVERFLOW_API_KEY`, run:

```
affiliate-networks-mcp setup everflow-advertiser
```

The wizard calls `listBrands()` which returns all advertisers visible under the
API key, including their `network_advertiser_id` values.

---

## Setup steps

Run the interactive setup wizard:

```
affiliate-networks-mcp setup everflow-advertiser
```

The wizard prompts for each credential in order and validates them live where
possible. On completion the credentials are written to `~/.affiliate-mcp/.env`.

### Manual setup

If you prefer to set credentials directly, add the following to
`~/.affiliate-mcp/.env`:

```
EVERFLOW_API_KEY=your-api-key-here
EVERFLOW_ADVERTISER_ID=42
```

---

## Available operations

| Operation | Status | Notes |
|---|---|---|
| `verifyAuth` | Experimental | GET /v1/networks/advertisers — confirms key validity |
| `listBrands` | Experimental | Returns all advertisers visible under the API key |
| `listMediaPartners` | Experimental | All affiliates on the network via POST /v1/networks/affiliatestable |
| `getProgrammePerformance` | Experimental | POST /v1/advertisers/reporting/entity, grouped by affiliate |
| `listClicks` | Experimental | POST /v1/networks/reporting/clicks/stream; max 5,000 clicks / 14-day window |
| `listProgrammes` | Not implemented | Use the `everflow` (publisher) adapter |
| `getProgramme` | Not implemented | — |
| `listTransactions` | Not implemented | Use `getProgrammePerformance` for aggregate data |
| `getEarningsSummary` | Not implemented | — |
| `generateTrackingLink` | Not implemented | Publisher-side operation |

---

## Common failures

### `HTTP 401` or `HTTP 403`

The API key is invalid or lacks permission for the requested resource.

- Confirm `EVERFLOW_API_KEY` is set correctly (no leading/trailing whitespace).
- Ask the network admin to check the key's permission scopes include read access
  to Advertisers and Affiliates.
- Network API keys are shown only once at creation. If lost, the admin must
  generate a new one.

### `config_error: Missing required credential EVERFLOW_API_KEY`

The credential is not set. Run `affiliate-networks-mcp setup everflow-advertiser`
or add `EVERFLOW_API_KEY=...` to `~/.affiliate-mcp/.env`.

### `config_error: Everflow advertiser getProgrammePerformance requires a brand context`

An advertiser-side tool was called without a `brand` argument. Advertiser-side
tools require `brand` to be specified (the adapter resolves it to a
`networkBrandId` via `brands.json`). Run `affiliate_resolve_brand` to see
which brands are registered, or re-run the setup wizard.

### `getProgrammePerformance` returns no rows

- The date window may be wider than one year (Everflow's API limit).
- The advertiser ID may not match any offer/affiliate data in the requested window.
- Confirm the `EVERFLOW_ADVERTISER_ID` matches the correct account.

### `listClicks` returns a 400 error

- The date window may exceed 14 days. Narrow the `from`/`to` range.
- The click data may be older than 3 months (retention limit for raw clicks without conversions).

---

## Known limitations

- **Adapter built from public API documentation; not yet verified against a live account.**
  Endpoint shapes and field names have been confirmed from Everflow's public
  developer documentation (hardening pass 2026-05-28), but a live account
  integration test has not been performed.
- API keys are created by a network admin, not by the advertiser directly.
  Contact your Everflow account manager to obtain a key.
- `listMediaPartners` returns all affiliates on the network; there is no
  server-side filter by advertiser in the Everflow affiliates table endpoint.
  Filter client-side where needed.
- `getProgrammePerformance` is limited to a one-year date window per Everflow's
  API constraint. `timezone_id` and `currency_id` use account defaults when omitted.
- `listClicks` via POST /v1/networks/reporting/clicks/stream enforces a 14-day
  maximum window and returns at most 5,000 clicks per request. Raw click data
  (without conversions) is only retained for 3 months.
- Publisher-side operations are not implemented. Use the `everflow` (publisher)
  adapter for listing programmes, transactions, and generating tracking links.

---

## Verifying the integration

```
affiliate-networks-mcp test everflow-advertiser
```

This runs `capabilitiesCheck()` which reports the supported/unsupported status
of each operation. Because the adapter has not been verified against a live
account, all operations report `claimStatus: experimental`.
