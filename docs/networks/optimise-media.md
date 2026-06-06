# Setting up affiliate-mcp with Optimise Media (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aoptimise-media%22)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Optimise Media publisher account through the OMG Network API.
You will end up with one value written to `~/.affiliate-mcp/.env`:
`OPTIMISE_MEDIA_API_TOKEN`.

No prior API experience is assumed. The OMG Network API is the programmatic
interface to the Insights Dashboard, written to OpenAPI 3.0. It authenticates
with a key minted from a Service Account.

This adapter is `experimental`: the seven operations are implemented against the
documented OMG Network API, but the field mappings have not yet been confirmed
against a live Service Account. See "Known limitations" below.

## Prerequisites

- An Optimise Media publisher account with access to the Insights Dashboard.
- The ability to create a Service Account in the Insights Dashboard. Service
  Account management is usually an account-administrator function; if you cannot
  see the Service Accounts screen, ask your account administrator to create the
  key for you.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `OPTIMISE_MEDIA_API_TOKEN` — the API key generated for a Service Account in
  the Insights Dashboard. It is sent in the `apikey` request header on every
  call.

## Setup steps

1. Sign in to the Optimise Insights Dashboard.

2. Open *Settings* and then *Service Accounts*.

3. Create a Service Account (or open an existing one). Give it a name you will
   recognise later, such as `affiliate-mcp`.

4. Generate an API key for the Service Account and copy the value immediately.
   Treat it as a secret; it grants the same read access your Service Account
   has.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Optimise Media** when prompted. Paste the key when the wizard asks for
   `OPTIMISE_MEDIA_API_TOKEN`.

## What success looks like

The wizard verifies the key against the `/Campaigns` endpoint, reports the
number of campaign relationships visible to the key, and writes the value to
`~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test optimise-media` should report `ok` for the
programme, transaction, earnings, and auth operations. `listClicks` and
`generateTrackingLink` report as unsupported by design (see below).

## Common failures

### Failure: the wizard reports `401` or `403` when validating the key

The key was copied with surrounding whitespace, has been revoked, or the
Service Account lacks read access. Re-open *Settings → Service Accounts* in the
Insights Dashboard, confirm the Service Account is active and its key is still
listed, and paste the key without leading or trailing spaces.

### Failure: the Service Accounts screen is not visible

Service Account management is typically restricted to account administrators.
If you cannot see *Settings → Service Accounts*, ask the administrator on your
Optimise account to create a Service Account and share its API key with you.

### Failure: amounts look off by a factor of 100

This adapter assumes conversion amounts are reported in major currency units
(for example pounds, not pence). If your figures look out by a factor of 100,
this assumption is wrong for your account; the verbatim payload is preserved on
`rawNetworkData` so you can confirm the unit, and you should report it so the
mapping can be corrected.

## Known limitations

These mirror `known_limitations` in `src/networks/optimise-media/network.json`:

- **Experimental field mappings.** The mappings follow the documented OMG
  Network API but have not been confirmed against a live Service Account.
- **Amount unit assumed.** Amounts are assumed to be in major currency units
  (pounds), not minor units (pence). Verify against a live account; raw payloads
  are preserved on `rawNetworkData`.
- **No click-level data.** The OMG Network API does not expose click-level data
  to publishers, so `listClicks` is unsupported (it raises a clear
  not-implemented error rather than returning an empty list).
- **No documented tracking-link scheme.** Tracking links are issued through the
  dashboard; the OMG Network API does not document a deterministic deep-link
  format or a link-generation endpoint, so `generateTrackingLink` is
  unsupported.
- **Product feeds not modelled.** Product feeds are documented for the network
  but are not modelled by this adapter.

## Verifying

```
affiliate-networks-mcp test optimise-media
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- optimise-media`. The diagnostic engine's pass is
the verification contract.
