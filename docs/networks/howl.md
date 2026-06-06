# Setting up affiliate-mcp with Howl (estimated 5 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Ahowl%22)

This guide walks you through the credentials affiliate-mcp needs to talk to
your Howl publisher account. Howl was formerly known as Narrativ, and its API
is still served from the `narrativ.com` domain. You will end up with two values
written to `~/.affiliate-mcp/.env`: `HOWL_API_KEY` and `HOWL_PUBLISHER_ID`.

No prior API experience is assumed. Label wording can change between dashboard
refreshes, so the layout is described alongside each step.

## Prerequisites

- An active Howl publisher account. If you can sign in and see your publisher
  dashboard, you have what you need.
- API access on a Howl publisher account does not require a separate approval
  step: you generate a key on demand from the Developer Options page.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `HOWL_API_KEY` — the API key from Howl's Developer Options page. Howl sends
  it in a custom `Authorization: NRTV-API-KEY <key>` header.
- `HOWL_PUBLISHER_ID` — your numeric Howl publisher id. Howl addresses
  statistics and link creation by publisher id, which is distinct from the user
  id behind your key, so the wizard cannot derive it automatically.

## Setup steps

1. Sign in to the Howl dashboard. Use the same credentials you use to read your
   earnings reports.

2. Open your account menu and go to the *Developer Options* page. Follow the
   on-screen directions to create an API key, then copy the key value. Howl
   shows the key once, so copy it to a secure location before leaving the page.
   Paste only the key value into the wizard, not the `NRTV-API-KEY` prefix.

3. Note your numeric publisher id. It appears in the dashboard URL after you
   sign in, and on the Developer Options page.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Howl** when prompted. Paste the key when the wizard asks for `HOWL_API_KEY`,
   then enter your publisher id for `HOWL_PUBLISHER_ID`.

## What success looks like

The wizard validates the key against the `GET /api/v1/tokeninfo/` endpoint,
shows the user id behind the key, and writes the two values to
`~/.affiliate-mcp/.env`. From that point, `affiliate-networks-mcp test howl`
exercises the implemented operations.

## Common failures

### Failure: the wizard reports `401` when validating the key

The key was copied with surrounding whitespace, was truncated, was revoked, or
the `NRTV-API-KEY` prefix was pasted in along with it. Re-open Developer Options
in Howl, confirm the key is still listed, and paste only the key value with no
leading or trailing spaces.

### Failure: statistics or link creation return an error for the wrong id

Howl addresses statistics and smart links by publisher id, not by the user id
behind your key. If `HOWL_PUBLISHER_ID` is wrong, those calls fail even though
the key validated. Confirm the numeric publisher id from the dashboard URL and
re-run `npx affiliate-networks-mcp setup` to correct it.

### Failure: `listProgrammes` returns fewer merchants than expected

Howl does not expose a live merchant catalogue for a publisher key. This adapter
derives programmes from the merchants you have driven activity to in the recent
window, so a quiet period returns few or no programmes. This is expected, not an
error.

## Known limitations

These mirror `known_limitations` in `src/networks/howl/network.json`:

- This adapter is **experimental**: it is implemented against the published Howl
  (Narrativ) API documentation and has not yet been verified against a live
  publisher account.
- Monetary amounts are assumed to be in **USD major units** (for example,
  dollars). The statistics endpoint exposes no currency field, so this is an
  assumption pending live verification.
- Howl has no live per-order transactions endpoint. `listTransactions` returns
  daily per-(article, merchant) aggregates from the statistics endpoint.
  Individual orders are only available through the scheduled Publisher Report
  CSV files (Clicks, Orders, Returns).
- Howl has no live merchant/programme catalogue endpoint for a publisher key.
  `listProgrammes` returns only the merchants you have driven activity to in the
  requested window.
- Howl does not expose a transaction approval or payment lifecycle through the
  statistics API, so transaction status cannot be normalised to
  pending/approved/paid. Rows are reported as `approved` when earnings are
  present, otherwise `other`.
- Click-level data is not exposed through a queryable endpoint, only the
  scheduled Clicks report file, so `listClicks` is unsupported.

## Verifying

```
affiliate-networks-mcp test howl
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- howl`. Because this adapter is experimental, treat a
pass as confirmation that the implemented endpoints respond, not as a production
guarantee.
