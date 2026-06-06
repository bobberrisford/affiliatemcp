# Setting up affiliate-mcp with Post Affiliate Pro (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Post Affiliate Pro account. Post Affiliate Pro is a self-hosted
or hosted affiliate platform run by the merchant (the advertiser side), so this
adapter reads your own programme: campaigns, the affiliates promoting them, and
the commissions and transactions owed.

You will end up with two values written to `~/.affiliate-mcp/.env`:
`POST_AFFILIATE_PRO_BASE_URL` and `POST_AFFILIATE_PRO_API_KEY`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the Post Affiliate Pro merchant panel is shown in
italics; label wording can change between releases, so the layout is described
alongside.

## Prerequisites

- A Post Affiliate Pro account where you have merchant-panel access. If you can
  sign in at `https://YOUR_ACCOUNT.postaffiliatepro.com` and see the merchant
  panel, you have what you need.
- API v3 access does not require a separate approval step. As long as you can
  open *Configuration > Tools > Integration*, you can create an API key on
  demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Why two values

Post Affiliate Pro is hosted per account, so the API does not live on a single
shared host. Each account is its own subdomain, and the API base URL is
therefore a credential, not a fixed constant:

```
https://YOUR_ACCOUNT.postaffiliatepro.com/api/v3
```

You supply that full base URL as `POST_AFFILIATE_PRO_BASE_URL`, and the API key
as `POST_AFFILIATE_PRO_API_KEY`.

## Steps

1. Sign in to the Post Affiliate Pro merchant panel at
   `https://YOUR_ACCOUNT.postaffiliatepro.com`. Note the subdomain you log in
   to: it is the `YOUR_ACCOUNT` part of the address.

2. Work out your API base URL. It is your subdomain followed by `/api/v3`, for
   example `https://acme.postaffiliatepro.com/api/v3`. This is the value for
   `POST_AFFILIATE_PRO_BASE_URL`.

3. In the merchant panel, open *Configuration*, then *Tools*, then
   *Integration*.

4. Open the *API v3 (REST API)* section. Create an API key (or copy an existing
   one). This is the value for `POST_AFFILIATE_PRO_API_KEY`. Copy it to a secure
   location; it grants access to your Post Affiliate Pro data.

5. Optional: from the same screen you can open *View API documentation* to see
   the interactive API v3 reference (Swagger UI) for your own account.

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Post Affiliate Pro** when prompted. Paste the base URL when the wizard asks
   for `POST_AFFILIATE_PRO_BASE_URL`, then paste the API key when it asks for
   `POST_AFFILIATE_PRO_API_KEY`.

## What success looks like

The wizard validates the API key by calling `GET /affiliates?limit=1` on your
account base URL and writes the two values to `~/.affiliate-mcp/.env`. From that
point on, `affiliate-networks-mcp test post-affiliate-pro` should report `ok`
for the supported operations.

Because Post Affiliate Pro is an advertiser-side, single-brand adapter, bind
your single brand in `~/.affiliate-mcp/brands.json` so the advertiser tools can
resolve the `brand` argument to your account.

## Environment variables

- `POST_AFFILIATE_PRO_BASE_URL` — your account API base, e.g.
  `https://acme.postaffiliatepro.com/api/v3`. Must be a full URL including the
  scheme and the `/api/v3` path.
- `POST_AFFILIATE_PRO_API_KEY` — the Bearer API key created under
  *Configuration > Tools > Integration > API v3*.

## Supported operations

- `verifyAuth` — cheap `/affiliates` probe.
- `listProgrammes` / `getProgramme` — your campaigns. A single programme is
  synthesised if the account exposes no campaign list.
- `listTransactions` — your transactions and commissions, with status
  normalised from the Post Affiliate Pro `type` and `rstatus` codes.
- `getEarningsSummary` — derived client-side from `listTransactions`.
- `listMediaPartners` — your affiliates.
- `getProgrammePerformance` — computed client-side by grouping transactions per
  affiliate per day.

## Known limitations

- This adapter is experimental. It is built against the documented Post
  Affiliate Pro API v3 contract but has not been verified against a live
  account. Field names and the amount unit are read defensively and the verbatim
  upstream payload is preserved on `rawNetworkData`.
- The amount unit is assumed to be major currency units (whole currency), not
  minor units. Confirm against your account before relying on totals.
- `listClicks` is unsupported: API v3 exposes no raw click record list to the
  merchant via this surface.
- `getProgrammePerformance` reports clicks as `0`, because transactions carry no
  click data.
- `generateTrackingLink` is unsupported: affiliate links belong to individual
  affiliates; the merchant API does not mint per-destination links.

## Common failures

### Failure: the wizard reports the base URL is not a valid URL

`POST_AFFILIATE_PRO_BASE_URL` must be a full URL including the scheme and the
`/api/v3` path, for example `https://acme.postaffiliatepro.com/api/v3`. A bare
subdomain or a missing `/api/v3` path will be rejected.

### Failure: the wizard reports `401 Unauthorized` when validating the key

The key was copied with surrounding whitespace, was revoked, or the base URL
points at the wrong account. Re-open *Configuration > Tools > Integration >
API v3*, confirm the key is still listed, and confirm the subdomain in
`POST_AFFILIATE_PRO_BASE_URL` matches the account that owns the key.
