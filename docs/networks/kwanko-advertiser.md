# Setting up affiliate-mcp with Kwanko (advertiser side) (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Akwanko%22)

This guide walks you through the credentials affiliate-mcp needs to read
your Kwanko **advertiser / brand** account — i.e. the side of Kwanko
that runs a campaign other publishers promote, not the publisher side
that earns commissions on someone else's campaign.

You will end up with one value written to `~/.affiliate-mcp/.env`:
`KWANKO_ADVERTISER_API_TOKEN`.

Kwanko uses a single API token sent as a Bearer token in the
`Authorization` header. The adapter is **read-only**: the HTTP client
refuses any non-GET method client-side, and we strongly recommend
pairing that with a read-only token where the Kwanko platform allows it.

> This adapter is `experimental`. It is built from Kwanko's public API
> documentation and has not yet been verified against a live advertiser
> account. The Kwanko developer reference and advertiser help desk are
> not machine-readable (they return HTTP 403 to automated fetch), so the
> exact endpoint paths, query-parameter names, and JSON field names were
> taken from public summaries. The adapter reads every field defensively
> and preserves the verbatim upstream payload in `rawNetworkData`. Treat
> the field mapping as provisional until you have confirmed it against a
> live response.

## Prerequisites

- An active Kwanko **advertiser** account (sign-in at
  [https://platform.kwanko.com/](https://platform.kwanko.com/)).
- API access is self-serve: you generate the token yourself from the
  platform, with no separate approval step and no contact with Kwanko.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## How the advertiser API is used

Kwanko exposes an advertiser API at `https://api.kwanko.com` that lets
an advertiser retrieve their **statistics** and **conversions**. The
adapter maps these to the standard tools:

- `listBrands` enumerates the campaigns the token addresses
  (`GET /advertiser/campaigns`). The Kwanko advertiser API has no
  account-level enumeration endpoint, so each campaign is returned as a
  brand you can bind in `brands.json`.
- `listProgrammes` returns the campaign for the resolved brand.
- `listTransactions` returns the campaign's conversions
  (`GET /advertiser/conversions`), with leads, sales, and downloads
  normalised to the standard transaction status.
- `getProgrammePerformance` returns a per-publisher rollup
  (`GET /advertiser/statistics` grouped by website), with clicks,
  conversions, gross sale, and commission per publisher per period.

The following operations throw `NotImplementedError` at v0.1:
`getProgramme`, `getEarningsSummary`, `listClicks` (clicks are reported
only as an aggregate inside the statistics rollup), and
`generateTrackingLink` (a publisher-side operation).

## Brands

Kwanko advertiser credentials are **multi-brand**: one token can address
several campaigns. Advertiser-side tools take a `brand` argument that the
dispatcher resolves to a Kwanko campaign id (the `networkBrandId`) via
`brands.json`. The setup wizard runs a brand-discovery sub-flow that
calls `listBrands`, lists each campaign the token can address, and writes
a `brands.json` entry per campaign you bind to a local slug. If
`listBrands` fails or comes back empty, you can add entries to
`~/.affiliate-mcp/brands.json` by hand with `network=kwanko-advertiser`
and `networkBrandId` set to the campaign id.

## Steps

1. Sign in to the Kwanko platform at
   [https://platform.kwanko.com/](https://platform.kwanko.com/).

2. Open the main menu and click *Features and API*.

3. Generate an API token (or copy the existing one). Where the platform
   offers it, choose a read-only scope: this adapter only ever issues
   GET requests, and a read-only token gives you defence in depth on
   Kwanko's side too.

4. Optionally restrict the token by IP in the platform settings. If you
   do, make sure the host that runs affiliate-mcp is allowed, or the
   token will fail authentication from that host.

5. Copy the token value. Treat it as a password.

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and
   select **Kwanko (advertiser)** when prompted. Paste the token when
   the wizard asks for `KWANKO_ADVERTISER_API_TOKEN`. The wizard makes a
   minimal authenticated call to validate the token live and prints the
   result inline.

7. The wizard then runs the brand-discovery sub-flow described under
   **Brands** above and writes the bindings to `brands.json`.

## What success looks like

The wizard prints a token-verified message and writes
`KWANKO_ADVERTISER_API_TOKEN` to `~/.affiliate-mcp/.env` with file
permissions `0600`, then writes a `brands.json` entry per campaign you
bound. From that point on, `affiliate-networks-mcp test
kwanko-advertiser` should report `ok` for every supported operation, and
advertiser-side tools take a `brand` argument that the dispatcher
resolves to the right Kwanko campaign id under the hood.

## Common failures

### Failure: the wizard reports an authentication error when validating the token

The token was copied incorrectly, has been revoked, or is IP-restricted
from this host. Check that no trailing space or line break sneaked in
during copy-paste, re-open *Features and API* in the Kwanko platform to
copy the token fresh, and confirm any IP restriction allows this host.

### Failure: a supported operation returns fields that look wrong or empty

This adapter is built from public summaries because the Kwanko developer
reference is not machine-readable, so the field mapping is provisional.
The verbatim upstream payload is always preserved in `rawNetworkData` on
every returned object; inspect it to see what the live API actually sent,
and report any mismatch so the mapping can be corrected.

### Failure: the adapter refuses a write operation

This is by design. The Kwanko advertiser adapter is read-only at v0.1.
If you need to edit a campaign or change a conversion's validation, do it
via the Kwanko platform for now. A future PR will lift the read-only
guard explicitly; until then any non-GET call fails fast with a
`config_error` envelope and no network round-trip.
