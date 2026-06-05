# PartnerStack (advertiser side)

Setup guide for the `partnerstack-advertiser` adapter, which integrates with the
PartnerStack **Vendor API** — the view a brand has of its own partner programme:
the partners promoting it, the transactions they generate, and the rewards
(commissions) owed. If you are a partner tracking your own earnings, use the
`partnerstack` adapter instead.

Status: **experimental**. Built against the documented Vendor API but not yet
validated end to end against a live vendor account. See "Known limitations".

## Prerequisites

- A PartnerStack vendor account with Vendor API access.
- A Vendor API key pair (public key + secret key).

## Credentials needed

- `PARTNERSTACK_PUBLIC_KEY` — the Vendor API public key (HTTP Basic username).
- `PARTNERSTACK_SECRET_KEY` — the Vendor API secret key (HTTP Basic password).

## Setup steps

1. Log in to your PartnerStack vendor account.
2. Open **Settings → API keys**.
3. Copy the **public key** and the **secret key**.
4. Run `affiliate-networks-mcp setup partnerstack-advertiser` and paste both when
   prompted, or set `PARTNERSTACK_PUBLIC_KEY` and `PARTNERSTACK_SECRET_KEY` in
   `~/.affiliate-mcp/.env`.

### Binding your brand

Advertiser-side tools take a required `brand` argument that resolves to a
network brand id via `~/.affiliate-mcp/brands.json`. A Vendor API key pair scopes
exactly one vendor account, so there is no automatic brand discovery — add one
binding by hand:

```json
{
  "version": 1,
  "brands": {
    "my-brand": [
      { "network": "partnerstack-advertiser", "credentialId": "default", "networkBrandId": "my-vendor" }
    ]
  }
}
```

`networkBrandId` is a label of your choosing here (the key already scopes the
account); it is echoed back on synthetic programme records. Then call the
advertiser tools with `brand: "my-brand"`.

## Common failures

1. **401 Unauthorised** — the public/secret pair is wrong or revoked. Regenerate
   from Settings → API keys.
2. **"requires a brand context"** — the tool was called without a `brand`
   argument, or the brand is not bound in `brands.json`. Run
   `affiliate_resolve_brand` to see what is bound.
3. **No partners or rewards** — a valid key on a vendor with no partners returns
   an empty list rather than an error.

## Known limitations

- The Vendor API auth scheme (public/secret Basic key pair) and the `reward` /
  `partner` field names have not been confirmed against a live vendor account.
  Verbatim payloads are preserved on `rawNetworkData`.
- `advertiser` + `single-brand`: one key pair scopes one vendor account. There
  is no multi-brand enumeration and no `listBrands()`; bind your one brand
  manually (see above).
- `listProgrammes` is synthetic: the Vendor API has no advertiser-programmes
  list, so the adapter returns one Programme for the bound vendor account.
- `getProgrammePerformance` is computed client-side from `/rewards`, grouped by
  (partner, day). Clicks are not available from `/rewards` and are reported as 0.
- `getProgramme`, `listClicks`, and `generateTrackingLink` are not implemented on
  the vendor side.
- Reward amounts are assumed to be minor units (cents).

## Verifying

```
affiliate-networks-mcp test partnerstack-advertiser
```

Runs the live diagnostic — the same engine as
`npm run validate:network -- partnerstack-advertiser`.
