# Setting up affiliate-mcp with Digistore24 (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs to talk
to your Digistore24 account as an affiliate. You will end up with one value
written to `~/.affiliate-mcp/.env`: `DIGISTORE24_API_KEY`.

Digistore24 is a German digital-products network. No prior API experience is
assumed. Where a step refers to a button or menu label, the exact wording is
shown so a person who has never used the developer portal can still complete
setup.

## Prerequisites

- A Digistore24 account that promotes products as an affiliate. If you can sign
  in at [https://www.digistore24.com/](https://www.digistore24.com/) and see
  your reports, you have what you need.
- API access on a Digistore24 account does not require a separate approval
  step. As long as your account is active, you can create an API key on demand.
- No regional configuration is needed: the API is served from a single host,
  `https://www.digistore24.com`.

## Credentials needed

- `DIGISTORE24_API_KEY` — the API key from the Digistore24 developer portal. The
  key is sent in the `X-DS-API-KEY` request header on every call.

## Setup steps

1. Sign in to Digistore24 at
   [https://www.digistore24.com/](https://www.digistore24.com/).

2. Open the developer portal at
   [https://dev.digistore24.com/](https://dev.digistore24.com/) and click
   *Create API key*. (In the main dashboard the same screen is reachable under
   *Settings* → *API keys*.)

3. Give the key at least *read* access (read access is sufficient for every
   operation this adapter performs), create it, and copy the value. The key is
   shown so you can copy it; store it somewhere safe before leaving the page.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Digistore24** when prompted. Paste the API key when the wizard asks for
   `DIGISTORE24_API_KEY`.

## What success looks like

The wizard validates the key against the `getUserInfo` function, shows your
Digistore24 ID and account name, and writes the value to
`~/.affiliate-mcp/.env` with file permissions `0600`. From that point on,
`affiliate-networks-mcp test digistore24` should report `ok` for the
operations the adapter supports (see "Known limitations" below for the ones it
does not).

## Common failures

### Failure: the wizard reports the key is invalid or revoked

Digistore24 returns this as a `result: "error"` body even though the HTTP
status is `200`. The key was copied with surrounding whitespace, was revoked,
or was created without read access. Re-open *Create API key* in the developer
portal, confirm the key is still listed and has read access, and paste it into
the wizard without leading or trailing spaces.

### Failure: the key works but `list programmes` shows only one entry

This is expected, not a fault. Digistore24 has no per-merchant programme
concept exposed to affiliates through the API. The adapter reports a single
synthetic programme that represents the Digistore24 platform; you promote
individual products via promolinks rather than by joining per-merchant
programmes.

### Failure: `generate tracking link` is rejected with a config error

Digistore24 promolinks are per-product. Pass the Digistore24 *product id* of
the product you want to promote in the `programmeId` argument, not the
synthetic platform programme id. The product id is shown on the product in your
Digistore24 marketplace or on the vendor's page.

## Known limitations

These mirror `known_limitations` in `src/networks/digistore24/network.json`:

- The adapter was built from the public API documentation and has not yet been
  verified against a live Digistore24 account, so its claim status is
  `experimental`.
- Monetary amounts are assumed to be major currency units (for example
  `49.00` EUR rather than `4900` cents). This matches the documented examples
  but is unconfirmed against a live account.
- Digistore24 has no per-merchant programme concept. `list programmes` and
  `get programme` return a single synthetic programme representing the
  platform, and transactions are keyed off it.
- Click-level data is not exposed via the public Digistore24 API, so
  `list clicks` is unsupported. The adapter reports this rather than returning
  an empty list, so you can tell "no clicks" apart from "no click API".

## Verifying

```
affiliate-networks-mcp test digistore24
```

The CLI runs the live diagnostic, the same engine as
`npm run validate:network -- digistore24`. The diagnostic engine's pass is the
verification contract.
