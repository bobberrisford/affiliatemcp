# Setting up affiliate-mcp with Pepperjam / Ascend (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Pepperjam publisher account. Pepperjam is now operated as
*Ascend by Partnerize*; you will sign in at the Ascend console. You will end up
with one value written to `~/.affiliate-mcp/.env`: `PEPPERJAM_API_KEY`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the Ascend console is shown in italics; label
wording can change between dashboard refreshes, so the layout is described
alongside.

> Note: this adapter is **experimental**. It is built from public API
> documentation and has not yet been validated against a live publisher
> account. It is also distinct from the separate `partnerize` adapter: Ascend
> is Partnerize-owned, but this REST API (versioned under
> `api.pepperjamnetwork.com`) is unrelated to the Partnerize Reporting API.

## Prerequisites

- An approved Pepperjam (Ascend) publisher account. If you can sign in at
  [https://ascend.pepperjam.com/](https://ascend.pepperjam.com/) and see your
  publisher dashboard, you have what you need.
- API access on a publisher account does not require a separate approval step.
  As long as your account is active, you can self-issue an API key on demand
  from the console.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Steps

1. Sign in to the Ascend console at
   [https://ascend.pepperjam.com/](https://ascend.pepperjam.com/). Use the same
   credentials you use to read your performance reports.

2. Open *Resources* in the main navigation and select *API Keys*. The direct
   link is
   [https://ascend.pepperjam.com/affiliate/api/](https://ascend.pepperjam.com/affiliate/api/).

3. Click *Generate New Key*. Ascend creates a long-lived API key scoped to your
   publisher account. Copy the value immediately to a secure location.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Pepperjam** when prompted. Paste the key when the wizard asks for
   `PEPPERJAM_API_KEY`.

## What success looks like

The wizard validates the key against the `/publisher/advertiser` endpoint, then
writes `PEPPERJAM_API_KEY` to `~/.affiliate-mcp/.env` with file permissions
`0600`. From that point on, `affiliate-networks-mcp test pepperjam` should
report `ok` for `listProgrammes`, `getProgramme`, `listTransactions`,
`getEarningsSummary`, and `verifyAuth`.

## How the credential is used

Pepperjam authenticates by query parameter, not by header. Every request the
adapter makes carries `?apiKey=<your key>&format=json`, against the versioned
base `https://api.pepperjamnetwork.com/20120402/`. The key is the only secret
the adapter stores, and it never leaves your machine.

## Supported operations

- `listProgrammes` / `getProgramme` — the advertisers (programmes) you can work
  with, from `/publisher/advertiser`. Results are paginated server-side via the
  response `meta.pagination` block; the adapter walks every page.
- `listTransactions` — from `/publisher/report/transaction-details`, filtered by
  a `startDate`/`endDate` window (`YYYY-MM-DD`). Wide windows are split into
  31-day slices automatically.
- `getEarningsSummary` — derived from `listTransactions` so the totals are
  reproducible by listing the underlying transactions yourself.
- `verifyAuth` — a cheap call to `/publisher/advertiser` to confirm the key.

## Known limitations

- **Experimental.** Not yet validated against a live Pepperjam (Ascend)
  publisher account.
- **Amount unit assumption.** Transaction amounts are passed through as major
  currency units (for example `12.50` = $12.50) and the currency is assumed to
  be USD, because the report does not return a per-row currency code. The raw
  row is always preserved on `rawNetworkData` so you can reconcile.
- **No click data.** Click-level data is not exposed via the public publisher
  API, so `listClicks` is unsupported. The adapter raises a clear
  not-implemented response rather than returning an empty list.
- **No deterministic tracking links.** Pepperjam does not document a
  deterministic publisher tracking-link scheme; links are issued per-creative in
  the Ascend console, so `generateTrackingLink` is unsupported.

## Common failures

### Failure: the *API Keys* page is empty or missing

This usually means you are signed in to a merchant (advertiser) account rather
than a publisher account. Ascend uses one console for both sides; the publisher
API keys live under the publisher view at
[https://ascend.pepperjam.com/affiliate/api/](https://ascend.pepperjam.com/affiliate/api/).
The merchant equivalent at `/merchant/api/` issues a different key that this
publisher-side adapter cannot use.

### Failure: the wizard reports `401` when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
revoked. Re-open *Resources → API Keys* in the Ascend console and confirm the
key is still listed; if it is not, generate a new one. Paste it into the wizard
without any leading or trailing spaces.

### Failure: amounts or currency look wrong

The adapter assumes major-unit amounts in USD (see the limitations above). If
your account reports in another currency, compare the canonical `amount` and
`commission` fields against the verbatim values on `rawNetworkData` and raise an
issue so the assumption can be revisited.
