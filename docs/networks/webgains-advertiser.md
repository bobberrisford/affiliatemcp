# Setting up affiliate-mcp with Webgains (advertiser side) (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Awebgains%22)

This guide walks you through the credentials affiliate-mcp needs to read
your Webgains **brand / advertiser** account — i.e. the side of Webgains
that runs a programme publishers promote, not the publisher side that
earns commissions on someone else's programme.

You will end up with two values written to `~/.affiliate-mcp/.env`:
`WEBGAINS_ADVERTISER_API_KEY` and `WEBGAINS_ADVERTISER_ACCOUNT_ID`.

Webgains uses the Smart Platform API with OAuth2 **Personal Access
Tokens**: you generate a token self-serve and the adapter sends it as a
bearer credential on every request. The adapter is **read-only**: the
HTTP client refuses any non-GET method client-side, and we recommend
pairing that with a read-only token where the dashboard offers one.

> This adapter was built from public API documentation and the Webgains
> Knowledge Hub. It has **not** yet been verified against a live
> advertiser account, so it ships with `claim_status: experimental`.
> Several endpoint paths and field names are marked `BLOCKED(verify)` in
> the source because the documentation host (`docs.webgains.dev`)
> returned HTTP 403 to automated fetch during the build. Confirm them
> against your live account before relying on the output.

## Prerequisites

- An active Webgains **advertiser** account.
- A Personal Access Token generated in the advertiser dashboard
  (account / developer / API settings). Generating a token does not
  require a separate approval step.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Brands

A Webgains advertiser Personal Access Token is scoped to one advertiser
account, which may run one or several **programmes** (campaigns). This
adapter treats each programme as a discoverable **brand**:

- `listBrands()` enumerates the advertiser account's programmes via the
  Get Programs endpoint (`/advertisers/{accountId}/programs`,
  `BLOCKED(verify)`).
- Advertiser-side tools take a `brand` argument; the dispatcher resolves
  it to a `networkBrandId` (the Webgains programme/campaign id) via
  `brands.json`. The setup wizard's brand-discovery sub-flow writes one
  `brands.json` entry per programme you choose to bind.

Unlike the Impact advertiser adapter there is **no** confirmed
agency-passthrough tier for Webgains advertisers, so the credential
model is a single tier: one account, N programmes.

## Read-only by design

The Webgains advertiser surface exposes mutation endpoints (commission
validation, transaction approvals). This adapter never touches them: the
HTTP client refuses any method other than GET and fails fast with a
`config_error` envelope before any network round-trip. Pair that with a
read-only Personal Access Token, where the dashboard offers one, for
defence in depth. To enable writes a future PR must lift the guard
explicitly and you must rotate to a read-write token.

## Steps

1. Sign in to the Webgains advertiser dashboard.

2. Open your account / developer settings (the API or *Personal Access
   Tokens* section). `BLOCKED(verify)`: the precise in-dashboard
   navigation could not be confirmed against the live dashboard.

3. Generate a new Personal Access Token and copy it. Prefer a read-only
   token if the option is offered. Treat the token as a secret; anyone
   holding it can read your account data.

4. Note your numeric advertiser account ID. It appears in your account
   settings and usually in the platform URL.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and
   select **Webgains (advertiser)** when prompted. Paste the token when
   the wizard asks for `WEBGAINS_ADVERTISER_API_KEY`, then paste the
   account ID when it asks for `WEBGAINS_ADVERTISER_ACCOUNT_ID`. Once
   both are set the wizard runs a live Get Programs call to confirm the
   token works.

6. The wizard then runs the brand-discovery sub-flow: it lists the
   programmes the credential can address and prompts you for the local
   slug to bind each one to under `brands.json`.

## What success looks like

The wizard verifies the token against the Webgains API and writes the
two values to `~/.affiliate-mcp/.env` with file permissions `0600`, then
writes a `brands.json` entry per selected programme. From that point on,
`affiliate-networks-mcp test webgains-advertiser` should report `ok` for
every supported operation, and advertiser-side tools take a `brand`
argument that the dispatcher resolves to the right Webgains programme id
under the hood.

## Supported operations

- `listBrands` — the advertiser account's programmes/campaigns.
- `verifyAuth` — a cheap Get Programs probe.
- `listProgrammes` — the advertiser's programme, scoped to the brand.
- `listTransactions` — the advertiser's transactions for the brand
  programme (the Get Transaction Report endpoint; 1-year max window per
  call, chunked automatically).
- `getProgrammePerformance` — a per-publisher rollup derived from the Get
  Transaction Report. The Webgains advertiser performance report breaks
  down performance by publisher; grouping is done client-side here
  because a server-side group-by parameter could not be confirmed.

Not implemented at v0.1 (each throws a `not_implemented` envelope):
`getProgramme`, `getEarningsSummary`, `listClicks`,
`generateTrackingLink` (a publisher-side operation), `listPublishers`,
`listPublisherSectors`.

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the token

The Personal Access Token was copied incorrectly or has been revoked.
Tokens can be long; check that no trailing space, line break, or
ellipsis sneaked in during copy-paste, then regenerate the token in the
advertiser dashboard and paste it fresh.

### Failure: `listBrands` returns nothing

The account ID may be wrong, or the token may not have reporting scope.
Confirm the numeric account ID in the dashboard and that the programme(s)
are live.

### Failure: the adapter refuses a write operation

This is by design. The Webgains advertiser adapter is read-only at v0.1.
Perform commission validation, approvals, or any other mutation via the
Webgains dashboard for now. Any non-GET call fails fast with a
`config_error` envelope and no network round-trip.
