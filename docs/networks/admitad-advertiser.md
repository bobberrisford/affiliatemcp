# Setting up affiliate-mcp with Admitad (advertiser side) (estimated 12 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your Admitad **brand / advertiser** account: the side of Admitad that
runs an affiliate programme publishers promote, not the publisher side
that earns commissions on someone else's programme.

You will end up with three values written to `~/.affiliate-mcp/.env`:
`ADMITAD_ADVERTISER_CLIENT_ID`, `ADMITAD_ADVERTISER_CLIENT_SECRET`, and
`ADMITAD_ADVERTISER_ID`.

Admitad uses OAuth2 with the `client_credentials` grant. You register
your own API application in your advertiser account; the Client ID and
Client Secret are exchanged for a short-lived bearer token at
`POST https://api.admitad.com/token/`. The adapter is **read-only**: the
HTTP client refuses any non-GET method, so reporting calls cannot turn
into writes.

## Prerequisites

- An active Admitad **advertiser** account.
- Permission to register an API application in that account (the
  account owner can always do this; some seats may be restricted).
- Your numeric advertiser id. Admitad uses it in the advertiser API
  paths, e.g. `GET /advertiser/{id}/statistics/actions/`.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Credentials and scopes

The adapter requests three advertiser-scoped OAuth scopes in one token
exchange:

- `advertiser_statistics` for the actions report
  (`GET /advertiser/{id}/statistics/actions/`), the source of
  `getProgrammePerformance` and `listTransactions`.
- `advertiser_info` for `GET /advertiser/{id}/info/`, the source of
  `listBrands` and `listProgrammes`.
- `advertiser_websites` for `GET /advertiser/{id}/websites/` (the joined
  ad spaces), reserved for future use.

Make sure all three scopes are enabled on the API application; the
wizard's live token exchange fails if a requested scope is missing, and
the upstream error message is surfaced verbatim.

## Steps

1. Sign in to your Admitad advertiser account.

2. Open the API applications area and create a new application. After it
   is created, click **Show credentials** to reveal the **Client ID**
   (app id) and **Client Secret** (secret key). Enable the
   `advertiser_statistics`, `advertiser_info`, and `advertiser_websites`
   scopes for the application.

3. Note your numeric **advertiser id**. It appears in the
   `/advertiser/{id}/...` API paths and scopes every reporting call.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and
   select **Admitad (advertiser)** when prompted. Paste the Client ID
   for `ADMITAD_ADVERTISER_CLIENT_ID`, the Client Secret for
   `ADMITAD_ADVERTISER_CLIENT_SECRET`, and the advertiser id for
   `ADMITAD_ADVERTISER_ID`. On the secret step the wizard exchanges the
   credentials for an access token to confirm they work.

## Brands

This adapter declares `credentialScope: multi-brand`, so the wizard runs
the brand-discovery sub-flow after auth verifies. `listBrands()` reads
`GET /advertiser/{id}/info/` (the advertiser id you entered) and returns
the campaigns the credential addresses. Each one is written to
`~/.affiliate-mcp/brands.json` bound to a local brand slug you choose.
Advertiser-side tools then take a `brand` argument that the dispatcher
resolves to the right advertiser id (the `networkBrandId`).

If `listBrands` comes back empty, the adapter synthesises a single entry
keyed by `ADMITAD_ADVERTISER_ID` so you can still bind the brand.

## What success looks like

The wizard prints a verified identity (your account username, where
available) and writes the three values to `~/.affiliate-mcp/.env` with
file permissions `0600`, plus a `brands.json` entry per discovered
campaign. From that point on, `affiliate-networks-mcp test
admitad-advertiser` should report `ok` for the supported operations.

## Common failures

### The wizard reports an auth error when validating the Client Secret

The Client ID or Client Secret was copied incorrectly, or the API
application is missing one of the requested scopes. Re-open the
application's credentials, confirm `advertiser_statistics`,
`advertiser_info`, and `advertiser_websites` are enabled, and copy the
values fresh.

### A reporting call returns an error mentioning the advertiser id

Confirm `ADMITAD_ADVERTISER_ID` is your own numeric advertiser id and
that the API application belongs to the same account. The id is part of
the URL path, so a wrong id addresses the wrong (or no) advertiser.

### The adapter refuses a write operation

This is by design. The Admitad advertiser adapter is read-only at v0.1.
Any non-GET call fails fast with a `config_error` envelope and no
network round-trip. Manage campaigns, tariffs, and connections in the
Admitad dashboard for now.

## Known limitations

- Built from public API documentation; not yet verified against a live
  advertiser account. The Admitad developer docs host blocked automated
  fetches during development, so the actions report's webmaster/website
  field names were inferred from search snippets and the public Python
  wrapper and carry `// BLOCKED(verify)` notes in the code.
- Read-only at v0.1.
- `getProgrammePerformance` is derived from the actions report grouped by
  publisher. Admitad does not expose per-publisher click counts on this
  report, so `clicks` is reported as `0`.
- `getProgramme`, `getEarningsSummary`, `listClicks`, and
  `generateTrackingLink` throw `NotImplementedError`.

## Verifying

Run `npx affiliate-networks-mcp test admitad-advertiser` to exercise the
supported operations against your account, or
`npx affiliate-networks-mcp doctor` for an environment and config
diagnostic.
