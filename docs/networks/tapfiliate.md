# Setting up affiliate-mcp with Tapfiliate (estimated 5 minutes)

This guide walks you through the credential affiliate-mcp needs in order to
talk to your Tapfiliate account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `TAPFILIATE_API_KEY`.

Tapfiliate is an advertiser-side (merchant) integration: the API is your own
view of your programme, the affiliates promoting it, and the commissions owed.
There is no publisher side. A single API key scopes a single Tapfiliate
account, so this adapter is advertiser + single-brand. You bind that one brand
to a logical slug in `brands.json` yourself; see "Known limitations" below.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the Tapfiliate dashboard is shown alongside;
label wording can change between dashboard refreshes, so the layout is
described too.

## Prerequisites

- A Tapfiliate account you can sign in to, with permission to view the API
  settings. If you can sign in and open your programme dashboard, you have
  what you need.
- API access on Tapfiliate does not require a separate approval step. As long
  as your account is active, you can create an API key on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

## Credentials needed

- `TAPFILIATE_API_KEY` — created on the Tapfiliate *Settings* page, under the
  *API* tab. It is sent as the `X-Api-Key` header on every request and grants
  full access to your Tapfiliate data, so treat it as a secret.

## Setup steps

1. Sign in to Tapfiliate at [https://app.tapfiliate.com/](https://app.tapfiliate.com/).

2. Open *Settings* from the main navigation.

3. Open the *API* tab on the Settings page.

4. Create a new API key (or copy an existing one). Tapfiliate shows the key
   value on screen; copy it to a secure location.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Tapfiliate** when prompted. Paste the key when the wizard asks for
   `TAPFILIATE_API_KEY`. The wizard validates it against the `/1.6/programs/`
   endpoint before writing it to `~/.affiliate-mcp/.env`.

## What success looks like

The wizard confirms that the key validated against the `/1.6/programs/`
endpoint and writes the value to `~/.affiliate-mcp/.env` with file permissions
`0600`. From that point on, `affiliate-networks-mcp test tapfiliate` should
report `ok` for every Tapfiliate operation except `listClicks` and
`generateTrackingLink`, which are intentionally unsupported (see "Known
limitations").

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated in the dashboard. Re-open the *API* tab in Tapfiliate, confirm the
key is still listed (or create a new one), and paste it into the wizard without
any leading or trailing spaces.

### Failure: the *API* tab is missing from the Settings page

This usually means the signed-in user lacks permission to manage API access.
Ask an account owner to either grant that permission or create the API key and
share it with you securely.

### Failure: tools return "requires a brand context"

Advertiser-side tools take a `brand` argument that the dispatcher resolves to a
Tapfiliate account via `brands.json`. If you have not bound your brand yet, add
an entry mapping your logical brand slug to this network and your account
identifier. Until that binding exists, the advertiser tools refuse to run
rather than guess which brand you meant.

## Known limitations

These mirror `known_limitations` in `src/networks/tapfiliate/network.json`.

- This adapter is experimental. The conversion, commission, affiliate, and
  programme field names have not been confirmed against a live account.
  Transformers read fields defensively and preserve the verbatim upstream
  payload on `rawNetworkData` so you can always inspect what Tapfiliate
  actually returned.
- Amount unit: Tapfiliate documents amounts as decimal major units (for
  example `"amount": 100.0`), so this adapter passes amounts through verbatim
  and does not divide by 100. This assumption is marked `TODO(verify)` against
  a live account.
- Advertiser + single-brand: one API key scopes one Tapfiliate account. Bind
  your single brand in `brands.json` manually.
- Click-level data is not available. Tapfiliate exposes a POST endpoint that
  records a click, but no list-clicks endpoint on the merchant API, so
  `listClicks` is unsupported and reports that rather than returning an empty
  list.
- Tracking-link generation is not available. Tracking links belong to
  individual affiliates; the merchant API does not mint per-destination links,
  so `generateTrackingLink` is unsupported.
- Programme performance is computed on the client from `/conversions`, grouped
  by affiliate and day. Click totals are not available from `/conversions` and
  are reported as `0`.
- Pagination is 1-based via `?page=`, with the next-page link carried in the
  `Link` response header. Wide pulls are capped at an internal page limit and
  log a warning if the cap is reached, rather than truncating silently.

## Verifying

```
affiliate-networks-mcp test tapfiliate
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- tapfiliate`. The diagnostic engine's pass is the
verification contract.
