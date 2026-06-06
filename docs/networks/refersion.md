# Setting up affiliate-mcp with Refersion (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Refersion merchant account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `REFERSION_API_KEY` (the public key) and
`REFERSION_SECRET_KEY` (the secret key).

Refersion is an advertiser-side, single-brand adapter: one key pair scopes one
Refersion merchant account. The API exposes the merchant's own view of their
programme — the offers they run, the affiliates promoting them, and the
conversions (and the commission owed on them).

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the Refersion dashboard is shown alongside; label
wording can change between dashboard refreshes, so the layout is described too.

## Prerequisites

- A Refersion merchant account. If you can sign in and see your affiliates,
  offers, and conversions, you have what you need.
- API access on a Refersion merchant account does not require a separate
  approval step. As long as your account is active, you can read your API keys
  on demand.

## Credentials needed

- `REFERSION_API_KEY` — the Public Key, sent as the `Refersion-Public-Key`
  header on every request.
- `REFERSION_SECRET_KEY` — the Secret Key, sent as the `Refersion-Secret-Key`
  header on every request.

Both are read from the same Refersion settings screen. Keep the secret key
private: together with the public key it grants full read access to your
Refersion data.

## Setup steps

1. Sign in to your Refersion account.

2. Open *Account* and then *Settings*. The API keys are listed on this screen.

3. Copy the *Public Key*. If no key pair is listed, generate one first.

4. Click *Show* next to the *Secret Key* to reveal it, then copy it.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Refersion** when prompted. Paste the public key when the wizard asks for
   `REFERSION_API_KEY`, then paste the secret key for `REFERSION_SECRET_KEY`.
   The wizard verifies the pair together once both are entered.

6. Bind your single brand in `~/.affiliate-mcp/brands.json` so the
   advertiser-side tools can resolve a `brand` argument to this account. Because
   Refersion is single-brand, this is a manual one-line entry.

## What success looks like

The wizard prints a confirmation that the key pair validated against the
`/v2/affiliate/list` endpoint and writes the two values to
`~/.affiliate-mcp/.env` with file permissions `0600`. From that point on,
`affiliate-networks-mcp test refersion` should report `ok` for every Refersion
operation except `listClicks` and `generateTrackingLink`, which are unsupported
on this REST surface (see "Known limitations" below).

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the keys

One of the keys was copied with surrounding whitespace, was truncated, or has
been regenerated. Re-open *Account* > *Settings* in Refersion and confirm both
keys are still listed; if the secret key is hidden, click *Show* to reveal it.
Paste both into the wizard without any leading or trailing spaces.

### Failure: only one key was entered

Both the public key and the secret key are required. The wizard accepts the
first key on its own and defers the live check until the second is entered, so
a verification only runs once the pair is complete. Re-run the setup and supply
both values.

### Failure: an advertiser tool reports a missing brand context

Advertiser-side tools take a `brand` argument that the dispatcher resolves to a
network brand id via `brands.json`. If no brand is bound, add one manually for
Refersion. Refersion is single-brand, so a single entry is enough.

## Known limitations

This adapter is **experimental**. It is built against the documented Refersion
REST v2 contract but has not been verified against a live account. The field
names on conversion, affiliate, and offer objects have not been confirmed;
transformers read fields defensively and preserve the verbatim upstream payload
on `rawNetworkData` so you can drill in.

- **Amount unit is assumed to be major currency units** (whole units, not minor
  units / cents). If Refersion reports minor units, the figures will be off by a
  factor of 100. This assumption is flagged for verification.
- **Click-level data is not available** via this REST surface. Refersion exposes
  clicks only through its separate GraphQL API, so `listClicks` is unsupported.
- **Tracking links are not minted by the merchant API.** Referral links belong
  to individual affiliates, so `generateTrackingLink` is unsupported.
- **Programme performance is computed locally** from the conversions feed,
  grouped by affiliate and day. Clicks are not present in that feed and are
  reported as `0`.
- **Wide pulls are paginated and capped.** A large result set is fetched page by
  page up to an internal cap; if the cap is reached a warning is logged rather
  than the result being silently truncated.

## Verifying

```
affiliate-networks-mcp test refersion
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- refersion`. The diagnostic engine's pass is the
verification contract.
