# Adtraction (advertiser)

Brand-side (advertiser) adapter for [Adtraction](https://adtraction.com/), a
Nordic affiliate network. This adapter reads an advertiser's programmes and
transactions and rolls transactions up into per-affiliate performance. It is
read-only and experimental: it was built from public API documentation and has
not yet been verified against a live advertiser account.

- Slug: `adtraction-advertiser`
- Side: advertiser
- Credential scope: multi-brand (one token may address several programmes)
- Auth model: custom (single API access token, sent as a query parameter)
- Claim status: experimental

## What you need

A single Adtraction API access token from your **advertiser** account.

1. Log in to your Adtraction advertiser account at https://adtraction.com/.
2. Open Account settings (top-right menu).
3. Find the "API" section.
4. Copy the existing access token, or generate a new one.

The token is the only credential. It is supplied to Adtraction as a `token`
query parameter on every request, not as an Authorization header, which is why
the auth model is `custom` rather than `bearer`.
Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api

## Setup

```
affiliate-networks-mcp setup adtraction-advertiser
```

The wizard prompts for one value and validates it live against the Adtraction
advertiser API:

| Field | Description |
| --- | --- |
| `ADTRACTION_ADVERTISER_API_TOKEN` | Your advertiser API access token. |

Estimated setup time: about 6 minutes. No approval step is required.

## Brands

This adapter is multi-brand: a single advertiser token may address several
programmes the advertiser runs. `listBrands()` enumerates those programmes from
the advertiser-programmes endpoint, returning each programme's id as the
`networkBrandId`. Advertiser-side tools take a `brand` argument that the
dispatcher resolves to a programme id via `brands.json`; brand-scoped operations
(`listProgrammes`, `listTransactions`, `getProgrammePerformance`) require that
context and refuse to run without it (surfacing a `config_error`, never guessing
a programme).

## Read-only, by allowlist (not by method)

This adapter is read-only at v0.1. The mechanism differs from the Impact
advertiser adapter, which enforces read-only by refusing every non-GET method.

Adtraction's reporting endpoints are POST-with-JSON-body **by design**: the date
window, channel id, and status filter travel in the request body even though the
call only reads data. A blanket "refuse POST" guard would therefore block all
reads. Instead, the HTTP client enforces read-only via an **allowlist of
documented data-READ paths**. Only the advertiser-transactions and
advertiser-programmes endpoints are reachable; any request to a path that is not
on the allowlist (including every write/mutation endpoint, such as approving or
rejecting transactions or editing programme terms) is refused with a
`config_error` before the network call goes out. The spirit matches the Impact
adapter — only data-read endpoints are callable — but the guard is a path
allowlist rather than a method ban. Enabling a new endpoint requires a conscious
PR that adds its path to the allowlist (read endpoints only) and rotating to a
read-write token.

## Operations

| Operation | Status | Notes |
| --- | --- | --- |
| `listBrands` | Supported | Enumerates the advertiser programmes the token addresses. |
| `verifyAuth` | Supported | Cheap authenticated programmes probe. |
| `listProgrammes` | Supported | The advertiser's programmes, scoped to the resolved brand. |
| `listTransactions` | Supported | The advertiser's transactions, brand-scoped, with status / age filters. |
| `getProgrammePerformance` | Supported | Advertiser transactions grouped by affiliate/channel into per-row performance. |
| `getProgramme` | Not implemented | Use `listProgrammes`. |
| `getEarningsSummary` | Not implemented | Use `getProgrammePerformance` for the per-affiliate rollup. |
| `listClicks` | Not implemented | Adtraction does not expose click-level data via the advertiser API. |
| `generateTrackingLink` | Not implemented | Publisher-side operation. |

Transaction status mapping: Adtraction encodes status as a numeric code
(`1` = approved, `2` = pending, `4` = open claim, `5` = rejected). The adapter
normalises these to the canonical states (`approved`, `pending`, `reversed`),
and the per-affiliate performance rows collapse to the three states
`pending | approved | reversed` (a settled approval rolls into `approved`).

## Known limitations

- Built from public API documentation; not yet verified against a live account.
- Read-only via the path allowlist described above.
- `getProgrammePerformance` is derived from the advertiser transactions feed,
  grouped by affiliate/channel. Adtraction transactions are per-conversion, so
  click counts read as `0` unless the transaction row carries one.
- The exact v3 advertiser endpoint paths (`/v3/advertiser/transactions/`,
  `/v3/advertiser/programs/`), the request/response field names, and the API
  host (`api.adtraction.com` vs `api.adtraction.net`) are inferred from public
  docs and the documented v2 partner pattern. They are marked `BLOCKED(verify)`
  in the source because both Apiary documentation sites returned HTTP 403 to
  automated fetch during development; they should be confirmed against a live
  advertiser account.
- Rate limit is roughly 30 requests/minute (some endpoints 10/minute).

## References

- API docs (v3): https://adtractionv3.docs.apiary.io/
- API docs (v2): https://apidocs.adtraction.net/v2/
- Get started with the Adtraction API: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
