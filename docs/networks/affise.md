# Setting up affiliate-mcp with Affise (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aaffise%22)

This guide walks you through the credentials affiliate-mcp needs to talk to your
Affise partner (affiliate) account. You will end up with two values written to
`~/.affiliate-mcp/.env`: `AFFISE_BASE_URL` and `AFFISE_API_KEY`.

Affise is not a single network. It is a CPA platform that many independent
networks each run as their own instance, under their own host. There is no
shared API endpoint: every network's API lives on that network's own tracking
domain. This is why the setup asks for a base URL as well as a key. One adapter
covers every Affise-powered network, parameterised by the base URL and key you
supply.

No prior API experience is assumed. Where a step refers to a menu label, the
wording from the Affise partner panel is shown; label wording can change between
releases, so the location is described alongside.

## Prerequisites

- A partner (affiliate) account on an Affise-powered network. If you can sign in
  to that network's Affise partner panel and see your offers, you have what you
  need.
- The network must have API access enabled for partners. On most Affise
  instances this is available by default; a few networks disable it, in which
  case you need to ask the network's account manager to enable it.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

### `AFFISE_BASE_URL` — your network's tracking-domain base URL

Each Affise network responds to API calls on its own host. This is the network's
tracking domain, found in the partner panel under *Settings* -> *Tracking
domains*. Enter the full origin, including the scheme, for example
`https://api-yournetwork.affise.com`. The adapter validates this as a URL and
appends the API paths itself, so any trailing path or query you paste is ignored.

### `AFFISE_API_KEY` — your affiliate API key

The API key authenticates you against your network's host. It is found in the
same partner panel under *Settings* -> *Security*. The key is long-lived; there
is no refresh flow. If it is revoked you generate a new one in the same place.

## Setup steps

1. Sign in to your network's Affise partner panel using the same credentials you
   use to read your statistics.

2. Open *Settings* -> *Tracking domains*. Copy the tracking domain shown there.
   This is your `AFFISE_BASE_URL` (prefix it with `https://` if it is shown
   without a scheme).

3. Open *Settings* -> *Security*. Copy the API key shown there. If the panel
   offers a button to generate a key and none exists yet, generate one and copy
   it. This is your `AFFISE_API_KEY`.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Affise**. Paste the base URL when prompted for `AFFISE_BASE_URL`, then the
   key when prompted for `AFFISE_API_KEY`. The wizard validates the key by
   listing one offer from your network.

## What success looks like

The wizard confirms the base URL parses as a valid host, then validates the key
against `GET /3.0/partner/offers` on that host and writes both values to
`~/.affiliate-mcp/.env`. From that point on,
`affiliate-networks-mcp test affise` should report `ok` for `listProgrammes`,
`listTransactions`, `getEarningsSummary`, and `verifyAuth`. `listClicks` is
reported as unsupported (see Known limitations).

## Common failures

### Failure: the wizard reports the base URL is not a valid URL

You pasted the tracking domain without a scheme, or with surrounding text. Enter
the full origin, for example `https://api-yournetwork.affise.com`, with no
leading or trailing spaces. The value must start with `http://` or `https://`.

### Failure: the wizard reports `401` when validating the API key

Either the key is wrong or revoked, or the base URL points at a different
network. Affise keys are scoped to one network's instance, so a valid key against
the wrong host still fails. Re-check the key under *Settings* -> *Security* and
confirm the base URL is the same network's tracking domain.

### Failure: `listProgrammes` returns an empty list

The key is valid but your partner account is not connected to any offers on that
network yet, or the offers require approval you have not been granted. Confirm in
the partner panel that you have connected offers; connect or request approval for
the offers you expect to see.

## Known limitations

These mirror `known_limitations` in `src/networks/affise/network.json`.

- The adapter was implemented from public API documentation and has not yet been
  validated against a live account. Its claim status is `experimental`.
- The API base URL is per-tenant. Each network runs its own Affise instance, so
  the base is the network's tracking domain supplied via `AFFISE_BASE_URL`. There
  is no single shared host. The `base_url` recorded in `network.json` is a
  representative placeholder only.
- Amounts are assumed to be in major currency units (for example pounds, not
  pence). Confirm this against a live account before relying on the figures.
- Click-level data is not exposed via the partner API. Affise provides only
  aggregated traffic counts in its statistics slices, so `listClicks` is not
  implemented and surfaces a clear not-implemented message rather than an empty
  list.

## Verifying

```
affiliate-networks-mcp test affise
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- affise`. The diagnostic engine's pass is the
verification contract.
