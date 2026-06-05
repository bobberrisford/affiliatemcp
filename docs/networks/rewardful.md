# Rewardful (advertiser side)

Setup guide for the `rewardful` adapter. Rewardful is a Stripe-native affiliate
tool for SaaS brands, so this is a merchant/advertiser integration: the view a
brand has of its own affiliate programme — campaigns, the affiliates promoting
them, and the commissions owed. There is no publisher side.

Status: **experimental**. Built against the documented REST API but not yet
validated end to end against a live account. See "Known limitations".

## Prerequisites

- A Rewardful account with API access.
- Your API Secret (from Company Settings — see below).

## Credentials needed

- `REWARDFUL_API_SECRET` — your API Secret. Sent as the HTTP Basic **username**
  (with an empty password) on every request. Treat it as a full-access secret.

## Setup steps

1. Log in to your Rewardful account.
2. Open **Company Settings**.
3. Copy the **API Secret**.
4. Run `affiliate-networks-mcp setup rewardful` and paste it when prompted, or set
   `REWARDFUL_API_SECRET` in `~/.affiliate-mcp/.env`.

### Binding your brand

Advertiser-side tools take a required `brand` argument that resolves to a network
brand id via `~/.affiliate-mcp/brands.json`. A Rewardful API Secret scopes one
merchant account, so there is no automatic brand discovery — add one binding by
hand:

```json
{
  "version": 1,
  "brands": {
    "my-brand": [
      { "network": "rewardful", "credentialId": "default", "networkBrandId": "my-account" }
    ]
  }
}
```

`networkBrandId` is a label of your choosing (the secret already scopes the
account). Then call the advertiser tools with `brand: "my-brand"`.

## Common failures

1. **401 Unauthorised** — the API Secret is wrong or was regenerated. Copy a
   fresh value from Company Settings.
2. **"requires a brand context"** — the tool was called without a `brand`
   argument, or the brand is not bound in `brands.json`. Run
   `affiliate_resolve_brand` to see what is bound.
3. **HTTP 429** — Rewardful rate-limits at 45 requests / 30 seconds. The
   resilience layer retries 429s with backoff; very wide pulls may still hit it.

## Known limitations

- `commission` / `affiliate` / `campaign` field names and the amount unit
  (assumed minor units / cents) have not been confirmed against a live account.
  Verbatim payloads are preserved on `rawNetworkData`.
- `advertiser` + `single-brand`: one API Secret scopes one Rewardful account.
  Bind your one brand manually (see above).
- `listClicks` is unsupported: Rewardful exposes referral visitors, not raw
  click records, via this API.
- `generateTrackingLink` is unsupported: affiliate links belong to individual
  affiliates; the merchant API does not mint per-destination links.
- `getProgrammePerformance` is computed client-side from `/commissions`, grouped
  by (affiliate, day). Clicks are not available and are reported as 0.

## Verifying

```
affiliate-networks-mcp test rewardful
```

Runs the live diagnostic — the same engine as
`npm run validate:network -- rewardful`.
