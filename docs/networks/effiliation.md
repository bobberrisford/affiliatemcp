# Setting up affiliate-mcp with Effiliation (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs in
order to talk to your Effiliation publisher account. You will end up with one
value written to `~/.affiliate-mcp/.env`: `EFFILIATION_API_KEY`.

Effiliation is the long-standing French network operated by Effinity. No prior
API experience is assumed. Where a step refers to a menu label, the exact
wording from the dashboard is shown in italics; label wording can change
between dashboard refreshes, so the layout is described alongside.

## Prerequisites

- An active Effiliation publisher account. If you can sign in at
  [https://www.effiliation.com/](https://www.effiliation.com/) and see your
  publisher dashboard, you have what you need.
- API access on an Effiliation publisher account does not require a separate
  approval step. As long as your publisher account is active, the API key is
  available on demand from your profile.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `EFFILIATION_API_KEY` — the single API key that authenticates every request.
  Effiliation sends it as the `key` query-string parameter, not as a header.
  The key is scoped to your publisher account, so there is no second
  identifier to enter.

## Steps

1. Sign in to the Effiliation publisher dashboard at
   [https://www.effiliation.com/](https://www.effiliation.com/).

2. Open *My account* and go to *Personal data*, then the *Credentials* tab.
   The same key is also surfaced under *Tools* → *API* on some dashboard
   layouts; both show the same value.

3. Copy the API key value.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Effiliation** when prompted. Paste the key when the wizard asks for
   `EFFILIATION_API_KEY`.

## What success looks like

The wizard validates the key against the `programs.json` endpoint and writes
`EFFILIATION_API_KEY` to `~/.affiliate-mcp/.env` with file permissions `0600`.
From that point on, `affiliate-networks-mcp test effiliation` should report
`ok` for the supported operations and clearly mark `listClicks` and
`generateTrackingLink` as unsupported.

## Common failures

### Failure: the wizard reports an authentication error when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated. Re-open *My account* → *Personal data* → *Credentials* and
confirm the key still matches what you pasted. Paste it without any leading or
trailing spaces.

### Failure: no programmes are returned

The programmes endpoint returns the programmes your publisher account is
affiliated with. An empty list means your account has no active affiliations
for the API to report, not that the key is wrong. Confirm your affiliations in
the dashboard.

### Failure: a recent sale is missing from transactions

Effiliation refreshes transaction data roughly every two hours. A conversion
that happened a few minutes ago may not appear in the API yet. Re-check after
the next refresh window before treating it as a discrepancy.

## Known limitations

These mirror `known_limitations` in `network.json`:

- The adapter was built from the public API documentation and has not yet been
  verified against a live account. It ships with `claim_status: experimental`.
- Click-level data is not exposed via the publisher API, so `listClicks` is
  unsupported. The operation throws rather than returning an empty list, so
  "no clicks" is never confused with "no click API".
- Tracking-link (deeplink) construction is not deterministically documented for
  the publisher API, so `generateTrackingLink` is unsupported. Rather than
  guess a URL scheme that might produce untracked links, the operation throws.
- Transaction amounts are assumed to be major currency units (for example,
  `12.50` means €12.50) in EUR. This assumption has not been confirmed against
  a live account; the verbatim payload is preserved on `rawNetworkData` so you
  can check.
- Transaction data is refreshed roughly every two hours upstream, so very
  recent conversions may be missing.

## Verifying

```
affiliate-networks-mcp test effiliation
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- effiliation`. The diagnostic engine's pass is the
verification contract.
