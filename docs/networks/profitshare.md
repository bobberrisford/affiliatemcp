# Setting up affiliate-mcp with Profitshare (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Profitshare affiliate account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `PROFITSHARE_API_USER` and
`PROFITSHARE_API_KEY`.

Profitshare is a Romanian affiliate network and amounts are reported in RON.
This adapter is experimental: it has not yet been validated against a live
Profitshare account, so endpoint shapes and field names are inferred from the
public reference client and may differ in production. See `REPORT.md` for the
full known-limitation notes.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording shown is taken from the Profitshare dashboard; label wording
can change between dashboard refreshes, so the layout is described alongside.

## Prerequisites

- An active Profitshare affiliate account. If you can sign in and see your
  affiliate dashboard, you have what you need.
- API access does not require a separate approval step: as long as your
  affiliate account is active, you can read your API user and key on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## How authentication works

Profitshare does not use a bearer token. It signs every request with an
HMAC-SHA1 signature computed locally from your API key, so the key itself is
never transmitted:

- `PROFITSHARE_API_USER` is sent on each request as the `X-PS-Client` header.
- `PROFITSHARE_API_KEY` is used locally to sign a canonical string (HTTP method,
  path, query string, API user, and a `Date` header) into the `X-PS-Auth`
  header.

Because the signature includes a GMT timestamp, a machine whose clock is far
out of sync with GMT can produce signature failures. If verification fails for
no obvious reason, check your system clock.

## Steps

1. Sign in to the Profitshare affiliate dashboard.

2. Open *Account* and then the *API* section. (The exact label may vary by
   dashboard version; look for an API or API access entry under your account
   settings.)

3. Copy the *API user* value. This is the public half of the credential pair.

4. Copy the *API key* value. This is the secret half. If no key is shown,
   click the option to generate one and copy it immediately.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Profitshare** when prompted. Enter the API user when asked for
   `PROFITSHARE_API_USER`, then paste the API key for `PROFITSHARE_API_KEY`.
   The wizard verifies the pair by making one signed call to the advertisers
   endpoint.

## What success looks like

The wizard prints a confirmation line that the credentials validated against
the `affiliate-advertisers` endpoint and writes the two values to
`~/.affiliate-mcp/.env` with file permissions `0600`. From that point on,
`affiliate-networks-mcp test profitshare` should report `ok` for
`listProgrammes`, `getProgramme`, `listTransactions`, `getEarningsSummary`, and
`verifyAuth`.

## Supported operations

- `listProgrammes` / `getProgramme` — advertisers (affiliate programmes) you
  can promote, from `affiliate-advertisers`. `getProgramme` selects a single
  advertiser from that list.
- `listTransactions` — commissions from `affiliate-commissions`, filtered by a
  date window and paged automatically. Statuses are normalised to the canonical
  set (`pending`, `approved`, `reversed`, `paid`, `other`).
- `getEarningsSummary` — aggregated client-side from `listTransactions`, so the
  totals are reproducible by listing transactions yourself.
- `verifyAuth` — a cheap signed call to the advertisers endpoint.

## Unsupported operations

- `listClicks` — Profitshare does not expose click-level data via the public
  affiliate API. The operation reports not-implemented rather than an empty
  list, so you can tell "no clicks" from "no endpoint".
- `generateTrackingLink` — tracking links are minted through the
  `affiliate-links` endpoint, which is not a deterministic URL scheme and has
  not been verified against a live account. The operation reports
  not-implemented until the endpoint contract is confirmed.

## Known limitations

- Commission amounts are assumed to be major-currency units (RON) as returned
  by the API. The unit is not authoritatively documented; the verbatim upstream
  payload is preserved on `rawNetworkData` so you can confirm it.
- The adapter is experimental and the affiliate endpoint shapes are inferred
  from the public reference client. Field names may differ in production.

## Common failures

### Failure: the wizard reports an `InvalidSignature` error

This means the signature did not match. The usual causes are an API key copied
with surrounding whitespace, a mismatched API user and key, or a system clock
that is far out of sync with GMT. Re-open the *API* section, confirm both
values, and paste them without leading or trailing spaces.

### Failure: the *API* section is missing from the account page

Confirm you are signed in to an affiliate account rather than an advertiser
account. API access for affiliates lives under your account settings; if you
cannot find it, contact Profitshare support to confirm your account has API
access enabled.

## Verifying

```
affiliate-networks-mcp test profitshare
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- profitshare`. The diagnostic engine's pass is the
verification contract.
