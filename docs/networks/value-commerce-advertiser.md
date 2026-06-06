# Setting up affiliate-mcp with ValueCommerce (advertiser side) (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Avalue-commerce%22)

This guide walks you through the credentials affiliate-mcp needs to read
your ValueCommerce **advertiser / brand (広告主)** account — i.e. the side
of ValueCommerce that runs a programme publishers promote, not the
publisher (affiliate site) side that earns commissions.

You will end up with two values written to `~/.affiliate-mcp/.env`:
`VALUE_COMMERCE_ADVERTISER_CLIENT_KEY` and
`VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET`.

ValueCommerce uses a self-issued report API authentication key pair. The
two values are Base64-encoded together to obtain a short-lived (30 minute)
bearer token; that token authorises the EC Order Report API. The adapter
is **read-only**: the HTTP client refuses any non-GET method client-side,
and we recommend pairing that with a report-only key on the console side.

## Prerequisites

- An active ValueCommerce **advertiser (広告主)** contract.
- The authority to issue an API authentication key. Only the contract
  owner or a sub-contract owner can issue the key.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Credentials needed

### `VALUE_COMMERCE_ADVERTISER_CLIENT_KEY`

The CLIENT_KEY half of the report API authentication key pair. Found under
Settings (設定) → Report API auth key (レポートAPI認証キーの取得) once the key
has been issued.

### `VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET`

The CLIENT_SECRET half of the same key pair, shown on the same page. Treat
it as a password.

## Steps

1. Sign in to the ValueCommerce advertiser management console.

2. Open Ads (広告) → 対応機能別 → Web service (Webサービス). On first use,
   agree to the terms and issue the API authentication key.

3. Open Settings (設定) → Report API auth key (レポートAPI認証キーの取得).
   Copy the value shown as CLIENT_KEY, then copy the CLIENT_SECRET.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **ValueCommerce (advertiser)** when prompted. Paste the CLIENT_KEY when
   the wizard asks for `VALUE_COMMERCE_ADVERTISER_CLIENT_KEY`, then paste
   the CLIENT_SECRET when it asks for
   `VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET`.

5. The wizard validates the secret step by exchanging the key pair for a
   token against the EC token endpoint
   (`/auth/v1/merchant/token/`). If the pair is wrong it tells you
   immediately rather than at first API use.

## Brands

ValueCommerce advertiser credentials are **multi-brand**: one key pair can
address every site / programme (PID) the contract runs. After auth is
verified, the wizard's brand-discovery sub-flow calls `listBrands()`, which
enumerates the distinct programmes (PIDs) seen in the EC Order Report over a
recent window and prompts you to bind each one to a local brand slug in
`brands.json`. Advertiser-side tools then take a `brand` argument that the
dispatcher resolves to the right ValueCommerce programme id under the hood.

There is no documented self-serve site-directory endpoint for the report
key, so the discovered set is derived from report rows. If a programme has
had no recent activity it may not appear; you can still bind it manually.

## Read-only

The adapter ships read-only at v0.1. The HTTP client refuses any non-GET
request and fails fast with a `config_error` envelope and no network
round-trip. The ValueCommerce advertiser surface does expose a mutation
endpoint (the EC order status-change API); a future PR would have to lift
the guard explicitly before any write could be issued. For now, perform any
status changes via the ValueCommerce console.

## What success looks like

The wizard prints the verified identity and writes the two values to
`~/.affiliate-mcp/.env` with file permissions `0600`, then writes a
`brands.json` entry per selected programme. From that point on,
`affiliate-networks-mcp test value-commerce-advertiser` should report `ok`
for the supported operations.

## Common failures

### The wizard reports an auth error when validating the credentials

Either the CLIENT_KEY or the CLIENT_SECRET was copied incorrectly. Re-open
Settings → Report API auth key (レポートAPI認証キーの取得) and copy both values
fresh, with no leading or trailing spaces.

### The token endpoint returns `locked`

ValueCommerce rate-limits token acquisition: more than 15,000 successful
token requests in a 30-minute window locks the key for 30 minutes. The
adapter caches the token for its 30-minute lifetime to stay well under this,
so a `locked` response usually means another integration is sharing the same
key. Wait 30 minutes or issue a separate key for this integration.

### A report row's fields look empty

The EC Order Report API returns XML, and the exact element names are not yet
confirmed against a live account. The adapter reads several candidate tag
names defensively and preserves the verbatim XML on each row's
`rawNetworkData`, so any field it could not map is still recoverable there.
If you see consistently empty fields, the live element names differ from the
candidates; please file a finding so the mapping can be corrected.

## Known limitations

- Adapter built from public API documentation; not yet verified against a
  live account.
- Read-only at v0.1 (the client refuses non-GET methods).
- `getProgrammePerformance` groups EC report rows by the publisher site id
  (sid) client-side; the sid element name is unconfirmed (`BLOCKED(verify)`).
- `listBrands` / `listProgrammes` derive the advertiser programmes from the
  EC report over a recent window; there is no documented site-directory
  endpoint (`BLOCKED(verify)`).
- `getProgramme`, `getEarningsSummary`, `listClicks`, and
  `generateTrackingLink` are not implemented.
- Access tokens are valid for 30 minutes; the adapter caches and re-fetches.
- The EC Order Report API ships v1/v2; the adapter targets v2
  (`BLOCKED(verify)`).

## Verifying

```
affiliate-networks-mcp test value-commerce-advertiser
```
