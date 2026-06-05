# Setting up affiliate-mcp with Daisycon (advertiser side) (estimated 15 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your Daisycon **advertiser / brand** account — the side of Daisycon that
runs programmes other publishers promote, not the publisher side that
earns commissions.

You will end up with three values written to `~/.affiliate-mcp/.env`:
`DAISYCON_ADVERTISER_CLIENT_ID`, `DAISYCON_ADVERTISER_CLIENT_SECRET`, and
`DAISYCON_ADVERTISER_REFRESH_TOKEN`.

Daisycon uses OAuth 2.0. The adapter exchanges a refresh token for
short-lived access tokens against
`https://login.daisycon.com/oauth/access-token`, then sends
`Authorization: Bearer <token>` to the data host
`https://services.daisycon.com`. The adapter is **read-only**: the HTTP
client refuses any non-GET method, as defence-in-depth against an
accidentally introduced write call. We recommend pairing this with an
OAuth scope limited to reading advertiser, campaign, and user-profile
data.

## Prerequisites

- A Daisycon **advertiser** account.
- Access to the Daisycon console to create OAuth credentials (Settings →
  API / OAuth).
- The ability to complete the one-time interactive OAuth consent
  (authorization_code + PKCE) to obtain a refresh token.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Credentials needed

### `DAISYCON_ADVERTISER_CLIENT_ID`

Your OAuth Client ID, created in the Daisycon console under **Settings →
API / OAuth**. When creating the credentials, limit the scope to reading
advertiser, campaign, and user-profile data where the console allows it.

### `DAISYCON_ADVERTISER_CLIENT_SECRET`

The OAuth Client Secret shown alongside the Client ID when you create the
credentials. On entry the wizard performs a live token exchange to confirm
the credentials work.

### `DAISYCON_ADVERTISER_REFRESH_TOKEN`

The OAuth refresh token obtained from the one-time interactive consent.
You complete the authorization_code + PKCE flow once; afterwards the
adapter uses the refresh token to mint access tokens automatically and
never performs the interactive redirect itself.

## Steps

1. Sign in to the Daisycon console and open **Settings → API / OAuth**.
2. Create OAuth credentials. Note the Client ID and Client Secret.
3. Complete the one-time authorization_code + PKCE consent to obtain a
   refresh token (Daisycon's console / CLI guides this flow).
4. Run `npx affiliate-networks-mcp setup`, select **Daisycon
   (advertiser)** when prompted, and paste the three values. The wizard
   runs a token exchange against
   `https://login.daisycon.com/oauth/access-token` to confirm the
   credentials authenticate.

## Brands

Daisycon advertiser credentials are **multi-brand**: one OAuth credential
can address every advertiser account it is connected to. After auth
verifies, `listBrands` calls `GET /advertisers` and returns one
`DiscoveredBrand` per advertiser account. You bind each advertiser id to a
logical brand slug in `brands.json`; advertiser-side tools then take a
`brand` argument that the dispatcher resolves to the advertiser id before
calling the adapter.

## Read-only operations

The adapter is read-only and exposes the following advertiser operations:

- `listBrands` — `GET /advertisers`.
- `listTransactions` — `GET /advertisers/{advertiserId}/transactions`,
  scoped to the resolved brand. Daisycon statuses `open`, `approved`, and
  `disapproved` map to the canonical `pending`, `approved`, and `reversed`
  states; `paid` maps to `paid` where surfaced.
- `listProgrammes` — derived from the distinct programmes present on the
  advertiser's transactions over the queried window. Daisycon does not
  document an advertiser-scoped programmes enumeration endpoint, so this is
  a derived view.
- `getProgrammePerformance` — a per-publisher (media) rollup computed
  client-side from `GET /advertisers/{advertiserId}/transactions`. Daisycon's
  pre-aggregated statistics resource is publisher-scoped only, so the
  advertiser-side rollup is derived from transaction rows. `clicks` is
  reported as `0` because the transactions resource carries no click count;
  drill into `rawNetworkData` for the underlying rows.

The following operations throw `NotImplementedError`:

- `getProgramme`, `getEarningsSummary`, `listClicks`, `generateTrackingLink`
  (publisher-side or not applicable on the advertiser surface).
- `listMediaPartners` — Daisycon does not document an advertiser-scoped
  publisher-roster endpoint; publishers surface via
  `getProgrammePerformance` instead.

## Common failures

- **`config_error: requires a brand context`** — an advertiser-side tool was
  called without a `brand` argument, or the brand is not bound in
  `brands.json`. Run `affiliate_resolve_brand` to see which brands are
  bound, and complete brand discovery in the setup wizard.
- **`auth_error` on token exchange** — one of the three OAuth values is
  wrong, or the refresh token has expired. Re-run the one-time
  authorisation to mint a fresh refresh token.
- **Empty results** — confirm the queried date window overlaps real
  transactions, and that the resolved advertiser id is API-accessible under
  your account.

## Known limitations

- Adapter built from public API documentation; not yet verified against a
  live account.
- Read-only at v0.1. The HTTP client refuses any non-GET method.
- `getProgrammePerformance` and `listProgrammes` are derived from the
  advertiser transactions; Daisycon exposes no advertiser-scoped statistics
  or programmes enumeration endpoint. Verify against a live account.
- `listMediaPartners` is not implemented; publishers surface via
  `getProgrammePerformance`.
- OAuth2 access tokens are short-lived; the adapter caches the token in
  memory and re-fetches on expiry. The refresh token may expire and then
  requires re-authorisation.
- Transactions are multi-currency: the currency is read per row.

## Verifying

```
npx affiliate-networks-mcp test daisycon-advertiser
```
