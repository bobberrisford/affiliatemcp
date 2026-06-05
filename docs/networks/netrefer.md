# Setting up affiliate-mcp with NetRefer (estimated 15 minutes)

This guide covers the credentials affiliate-mcp needs to read your NetRefer
affiliate data through the ASR (Affiliate Standard Reporting) REST API. You
will end up with five values written to `~/.affiliate-mcp/.env`:
`NETREFER_BASE_URL`, `NETREFER_CLIENT_ID`, `NETREFER_CLIENT_SECRET`,
`NETREFER_USERNAME`, and `NETREFER_PASSWORD`.

NetRefer is an iGaming affiliate-platform engine used by operators. ASR is the
affiliate-facing reporting surface: it reports aggregated activity (clicks,
registrations, deposits, CPA, RevShare) per tracker and brand. It is a
read-only reporting API. This adapter is **experimental** and has not been run
against a live operator account.

No prior API experience is assumed.

## Prerequisites

- An affiliate account with a NetRefer-powered operator.
- ASR access provisioned for that account. ASR access is granted manually
  during onboarding by your operator or NetRefer account manager. There is no
  self-service screen to generate these credentials; if you do not have them,
  request them. Allow a few working days.
- The per-operator ASR base URL. ASR does not use a single shared host: each
  operator is reachable at its own host, which you are given at onboarding.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `NETREFER_BASE_URL` — the per-operator ASR host you call for reports, for
  example `https://asr.operator.netrefer.com`. This is a credential, not a
  fixed value: it differs per operator. Enter the full base URL including the
  `https://` scheme.
- `NETREFER_CLIENT_ID` — the OAuth2 client ID from your ASR credential set.
- `NETREFER_CLIENT_SECRET` — the OAuth2 client secret paired with the client ID.
- `NETREFER_USERNAME` — the username from your ASR credential set. ASR uses the
  OAuth2 resource-owner password grant, so a username and password accompany
  the client ID and secret.
- `NETREFER_PASSWORD` — the password paired with the username.

Two optional overrides exist for non-standard onboarding:

- `NETREFER_TOKEN_URL` — overrides the Microsoft Entra token endpoint if your
  operator uses a different tenant.
- `NETREFER_SCOPE` — overrides the ASR token scope if your operator uses a
  different resource id.

## Setup steps

1. Request ASR access from your NetRefer operator or account manager if you do
   not already have it. They provision a credential set (client ID, client
   secret, username, password) and tell you your ASR base URL.

2. Collect the five values above from the credential set and the onboarding
   details.

3. In your terminal, run `npx affiliate-networks-mcp setup` and select
   **NetRefer** when prompted. Enter the base URL first, then the four OAuth
   values. The wizard validates each field's format, then exchanges the OAuth
   credentials for a token to confirm they work.

## What success looks like

The wizard confirms that the OAuth credentials exchanged successfully for a
token at the Microsoft Entra token endpoint, then writes the five values to
`~/.affiliate-mcp/.env`. From that point, `affiliate-networks-mcp test netrefer`
should report `ok` for `verifyAuth`, `listTransactions`, `getEarningsSummary`,
and `listProgrammes`, and report `listClicks` and `generateTrackingLink` as
unsupported (see the known limitations below).

Because the ASR endpoint paths and field names in this adapter follow the
public ASR 1.0 documentation rather than a confirmed live response, treat a
first successful run as a starting point and reconcile the figures against your
operator's own reporting before relying on them.

## Common failures

### Failure: the wizard rejects the base URL

`NETREFER_BASE_URL` must be a full URL including the scheme, for example
`https://asr.operator.netrefer.com`. A bare hostname is rejected. The host is
operator-specific; use the one your operator gave you, not a value copied from
another affiliate.

### Failure: the token exchange returns `400` or `401`

The four OAuth values are exchanged together at the token endpoint. A `400` or
`401` usually means one of them is wrong, was copied with surrounding
whitespace, or the credential set has been rotated. Re-copy each value without
leading or trailing spaces. If the operator uses a non-standard Entra tenant or
ASR resource id, set `NETREFER_TOKEN_URL` and `NETREFER_SCOPE` to the values
your operator provided.

### Failure: `listProgrammes` returns fewer brands than expected

`listProgrammes` and `getProgramme` are synthesised from the brands present in
the recent Daily Activity Report, because ASR exposes no programme catalogue.
A brand with no activity in the recent window will not appear. Widen the
reporting window or expect only brands with recent activity.

## Known limitations

These mirror `known_limitations` in `network.json`:

- **Experimental.** The adapter has not been validated against a live NetRefer
  ASR operator account. Endpoint paths and field names follow the public ASR
  1.0 documentation and may need adjustment.
- **Per-operator base URL.** There is no single fixed host. The adapter reads
  the host from `NETREFER_BASE_URL` and validates that it parses as a URL.
- **Amount unit assumed.** The public ASR docs do not state whether monetary
  values are major units (decimal) or minor units. The adapter assumes major
  units and passes values through unscaled. Verbatim values are preserved on
  `rawNetworkData` for reconciliation.
- **iGaming domain.** ASR rows report iGaming metrics. Sale amount is mapped
  from deposits and commission from CPA + RevShare; this differs from a classic
  retail-affiliate transaction.
- **Synthesised programmes.** `listProgrammes` and `getProgramme` derive brands
  from report data rather than a catalogue endpoint.
- **No click-level data.** ASR reports clicks only as a per-day aggregate, so
  `listClicks` throws a not-implemented error.
- **No tracking-link generation.** ASR is read-only reporting; tracking-link
  construction is not part of the affiliate surface, so
  `generateTrackingLink` throws a not-implemented error.
- **Brand-side operations scaffolded.** `listPublishers` and
  `listPublisherSectors` throw a not-implemented error until v0.2.

## Verifying

```
affiliate-networks-mcp test netrefer
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- netrefer`. The diagnostic engine's pass is the
verification contract.
