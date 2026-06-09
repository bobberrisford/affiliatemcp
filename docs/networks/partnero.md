# Partnero (advertiser side)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Apartnero%22)

Setup guide for the `partnero` adapter. Partnero is a SaaS referral and
affiliate platform, so this is a merchant/advertiser integration: the view a
brand has of its own programme — the partners promoting it, the customers they
refer, and the transactions (and the rewards owed against them). There is no
publisher side.

Status: **experimental**. The adapter was implemented from the public API docs
and has not yet been validated end to end against a live account. See "Known
limitations".

## Prerequisites

- A Partnero account with at least one programme.
- An API token for that programme (from Programs › Integration › API — see
  below). The token is generated per programme and shown once.

## Credentials needed

- `PARTNERO_API_KEY` — your Partnero API token. Sent as a Bearer token
  (`Authorization: Bearer <token>`) on every request. Treat it as a full-access
  secret for the programme it was generated for.

## Setup steps

1. Sign in to your Partnero account.
2. Under the **Programs** section, open **Integration**.
3. Switch to the **API** tab.
4. Create a new API key (one per integration you connect) and copy the token.
   It is shown once, so copy it before leaving the page.
5. Run `affiliate-networks-mcp setup partnero` and paste the token when
   prompted, or set `PARTNERO_API_KEY` in `~/.affiliate-mcp/.env`.

### Binding your brand

Advertiser-side tools take a required `brand` argument that resolves to a
network brand id via `~/.affiliate-mcp/brands.json`. A Partnero token scopes one
programme, so there is no automatic brand discovery — add one binding by hand:

```json
{
  "version": 1,
  "brands": {
    "my-brand": [
      { "network": "partnero", "credentialId": "default", "networkBrandId": "my-programme" }
    ]
  }
}
```

`networkBrandId` is a label of your choosing (the token already scopes the
programme), and it becomes the id of the single programme the adapter reports.
Then call the advertiser tools with `brand: "my-brand"`.

## What success looks like

The wizard validates the token against the `/v1/partners` endpoint and writes
`PARTNERO_API_KEY` to `~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test partnero` should report `ok` for every Partnero
operation except `listClicks` and `generateTrackingLink`, which are unsupported
(see "Known limitations").

## Supported operations

- `verifyAuth` — cheap `/v1/partners` probe.
- `listProgrammes` / `getProgramme` — a single synthetic programme (Partnero has
  no `/programs` list endpoint; the token scopes one programme).
- `listTransactions` — from `GET /v1/transactions`; commission is read from the
  transaction's reward(s).
- `getEarningsSummary` — derived client-side from `listTransactions`.
- `listMediaPartners` — from `GET /v1/partners`.
- `getProgrammePerformance` — client-side aggregation of transactions by
  (partner, day).

## Common failures

1. **401 Unauthorised** — the API token is wrong or was regenerated. Generate a
   fresh token under Programs › Integration › API and paste it without
   surrounding whitespace.
2. **"requires a brand context"** — the tool was called without a `brand`
   argument, or the brand is not bound in `brands.json`. Run
   `affiliate_resolve_brand` to see what is bound.
3. **HTTP 429** — Partnero rate-limits requests. The resilience layer retries
   429s with backoff; very wide pulls may still approach the limit. Pagination
   is capped at a maximum page count with a warning rather than a silent
   truncation.

## Known limitations

- Adapter implemented from public API docs; not yet validated against a live
  account (claim status: experimental).
- `transaction` / `reward` / `partner` field names and the amount unit (assumed
  major currency units, per the PHP SDK example `setAmount(99.99)` and the
  `is_currency` / `amount_units` fields) have not been confirmed against a live
  account. Verbatim payloads are preserved on `rawNetworkData`.
- `advertiser` + `single-brand`: one API token scopes one Partnero programme.
  Bind your one brand manually (see above).
- `listProgrammes` / `getProgramme` return a single synthetic programme:
  Partnero has no `/programs` list endpoint, so the programme is modelled from
  the configured token and the supplied brand context.
- `listClicks` is unsupported: Partnero exposes no raw click records via this
  API.
- `generateTrackingLink` is unsupported: referral links belong to an individual
  partner; the merchant API does not mint per-destination links.
- `getProgrammePerformance` is computed client-side from `/transactions`,
  grouped by (partner, day). Clicks are not available and are reported as 0.
- Commission per transaction is read from the transaction reward(s); a
  transaction with no reward contributes 0 commission.

## Verifying

```
affiliate-networks-mcp test partnero
```

Runs the live diagnostic — the same engine as
`npm run validate:network -- partnero`.
