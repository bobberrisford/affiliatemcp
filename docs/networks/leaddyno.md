# Setting up affiliate-mcp with LeadDyno (advertiser side, estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aleaddyno%22)

Setup guide for the `leaddyno` adapter. LeadDyno is a SaaS affiliate-tracking
platform used by the merchant, so this is an advertiser integration: the view a
brand has of its own programme — the affiliates promoting it, the purchases
those affiliates referred, and the commissions owed. There is no publisher side.

You will end up with one value written to `~/.affiliate-mcp/.env`:
`LEADDYNO_API_KEY`.

Status: **experimental**. Built against the public REST API documentation but
not yet validated end to end against a live account. See "Known limitations".

## Prerequisites

- A LeadDyno account.
- Your private API key (from Account → Profile — see below).

API access on a LeadDyno account does not require a separate approval step: as
long as your account is active, the private key is available on demand.

## Credentials needed

- `LEADDYNO_API_KEY` — your private API key. It is sent as the `key` query
  parameter on every request (LeadDyno's documented authentication scheme, which
  is why this adapter's `auth_model` is `custom` rather than a bearer or basic
  header). Treat it as a full-access secret; it grants complete access to your
  LeadDyno data.

## Setup steps

1. Sign in to your LeadDyno account.
2. Open **Account → Profile**.
3. Copy the **private API key** shown on that page.
4. Run `affiliate-networks-mcp setup leaddyno` and paste it when prompted, or set
   `LEADDYNO_API_KEY` in `~/.affiliate-mcp/.env`.

### Binding your brand

Advertiser-side tools take a required `brand` argument that resolves to a network
brand id via `~/.affiliate-mcp/brands.json`. A LeadDyno private key scopes one
merchant account, so there is no automatic brand discovery — add one binding by
hand:

```json
{
  "version": 1,
  "brands": {
    "my-brand": [
      { "network": "leaddyno", "credentialId": "default", "networkBrandId": "my-account" }
    ]
  }
}
```

`networkBrandId` is a label of your choosing (the key already scopes the
account). Then call the advertiser tools with `brand: "my-brand"`.

## What success looks like

The wizard validates the key against the `/v1/affiliates` endpoint and writes
`LEADDYNO_API_KEY` to `~/.affiliate-mcp/.env` with file permissions `0600`. From
that point on, `affiliate-networks-mcp test leaddyno` should report `ok` for all
LeadDyno operations except `listClicks` and `generateTrackingLink`, which are
unsupported (see "Known limitations").

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated. Re-open **Account → Profile** in LeadDyno and copy a fresh value.
Paste it into the wizard without any leading or trailing spaces.

### Failure: "requires a brand context"

The tool was called without a `brand` argument, or the brand is not bound in
`brands.json`. Run `affiliate_resolve_brand` to see what is bound, then add a
binding as shown above.

### Failure: HTTP 429

LeadDyno rate-limits requests. The resilience layer retries 429s with backoff;
very wide pulls that page through many records may still approach the limit.

## Known limitations

Mirrors `known_limitations` in `network.json`:

- Adapter implemented from public API docs; not yet validated against a live
  account (claim status: experimental).
- Authentication is a private key passed as the `key` query parameter
  (`auth_model: custom`), not a bearer or basic header.
- `advertiser` + `single-brand`: one private key scopes one LeadDyno account.
  Bind your one brand manually (see above).
- LeadDyno exposes no multi-campaign concept via this API: one account is one
  programme. `listProgrammes` and `getProgramme` return a single synthetic
  programme with id `account`.
- Transactions are derived from `GET /v1/purchases`. Purchases carry
  `purchase_amount` and a `cancelled` flag but no per-purchase commission or
  currency; commission falls back to `commission_amount_override` when present
  and currency to a default. The full commission lifecycle (pending, due, paid,
  cancelled) lives on the separate per-affiliate `/commissions` resource. Field
  names and the amount unit are unconfirmed against a live account; verbatim
  payloads are preserved on `rawNetworkData`.
- Amount unit is assumed to be major units (for example `49.0` means `49.00`),
  not minor units or cents, per the documented purchase examples.
- `listClicks` is unsupported: LeadDyno tracks visitors and leads, not raw click
  records, via this API.
- `generateTrackingLink` is unsupported: affiliate links belong to individual
  affiliates (`affiliate_url`); the merchant API does not mint per-destination
  links.
- `getProgrammePerformance` is computed client-side from `/v1/purchases`, grouped
  by (affiliate, day). Clicks are not available and are reported as 0.
- Pagination is page-based, 100 records per page, sorted oldest-first. It is
  capped at an internal maximum with a warning logged rather than a silent
  truncation.

## Verifying

```
affiliate-networks-mcp test leaddyno
```

Runs the live diagnostic — the same engine as
`npm run validate:network -- leaddyno`.
