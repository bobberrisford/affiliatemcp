# Setting up affiliate-mcp with Connexity (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Connexity publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `CONNEXITY_PUBLISHER_ID` and
`CONNEXITY_API_KEY`.

Connexity is a US cost-per-click commerce network; it powers the ShopYourLikes
monetisation tools. It is a separate network from Skimlinks: the two are not
interchangeable and use different credentials and endpoints.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the Connexity publisher portal is shown in
italics; label wording can change between portal refreshes, so the layout is
described alongside.

## Prerequisites

- An active Connexity publisher account. If you can sign in at
  [https://publisher.connexity.com/](https://publisher.connexity.com/) and see
  your publisher dashboard, you have what you need.
- API access enabled on the account. For most publisher accounts the publisher
  ID and API key are available from the portal without a separate approval
  step; if your account does not yet show an API Access screen, contact your
  Connexity account manager to have it enabled.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `CONNEXITY_PUBLISHER_ID` — your numeric publisher ID, shown on the
  *API Access* screen in the publisher portal.
- `CONNEXITY_API_KEY` — the API key shown on the same *API Access* screen. It
  is sent alongside the publisher ID on every API request.

## Setup steps

1. Sign in to the Connexity publisher portal at
   [https://publisher.connexity.com/](https://publisher.connexity.com/).

2. Open *Account* and then *API Access* from the portal navigation. (Some
   accounts show this as *API* under account settings; both lead to the same
   screen.)

3. Copy the *Publisher ID* value shown on that screen. This is your
   `CONNEXITY_PUBLISHER_ID`.

4. Copy the *API Key* value shown on the same screen. If no key is listed,
   click *Generate API Key* first, then copy it. This is your
   `CONNEXITY_API_KEY`. Treat it as a secret.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Connexity** when prompted. Enter the publisher ID, then paste the API key.
   The wizard validates the pair with a single-day earnings report call.

## What success looks like

The wizard prints a confirmation that the credentials validated against the
earnings reporting endpoint, shows your publisher ID as the identity, and
writes the two values to `~/.affiliate-mcp/.env` with file permissions `0600`.
From that point on, `affiliate-networks-mcp test connexity` should report `ok`
for the supported operations. `listClicks` is reported as unsupported (see
Known limitations).

## Common failures

### Failure: the wizard reports `401` when validating the API key

The key was copied with surrounding whitespace, was regenerated (invalidating
the old value), or the publisher ID does not match the key. Re-open the
*API Access* screen, confirm both the publisher ID and the API key, and paste
them without any leading or trailing spaces. Both values are required for a
valid call; an otherwise correct key fails if the publisher ID is wrong.

### Failure: the *API Access* screen is missing from the portal

API access may not be enabled on your account. Confirm you are signed in to a
publisher account (not an advertiser or agency view) and contact your Connexity
account manager to enable API access if the screen is absent.

### Failure: `getProgramme` cannot find a known merchant

Connexity merchant discovery is keyword-driven through the Merchant Match API;
there is no by-id lookup. A merchant only appears when it matches the search
keyword. Use `listProgrammes` with a relevant search term for the merchant you
are looking for, then read the id from those results.

## Known limitations

These mirror `known_limitations` in `src/networks/connexity/network.json`:

- Experimental: the adapter has not been validated against a live Connexity
  publisher account; endpoint shapes are mapped from public documentation.
- Connexity is a cost-per-click network, so reporting is daily aggregate rather
  than per sale. `listTransactions` returns one synthetic transaction per day
  (redirects, estimated earnings, effective CPC), and every row is reported as
  *approved* because CPC earnings carry no pending or reversed sale lifecycle.
- The amount unit is assumed to be major currency units (US dollars) based on
  the documented decimal earnings figures; this has not been confirmed against
  a live account.
- Click-level data is not exposed as structured records via the publisher API.
  The click report is a CSV download rather than per-click rows, so
  `listClicks` is unsupported.
- Connexity is distinct from the Skimlinks adapter: a separate network with
  separate credentials, hosts, and API.

## Verifying

```
affiliate-networks-mcp test connexity
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- connexity`. The diagnostic engine's pass is the
verification contract.

## API reference

- Publisher API Reference:
  [https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference](https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference)
- Merchant Match API:
  [https://pubresources.connexity.com/hc/en-us/articles/17357975725085-Merchant-Match-API](https://pubresources.connexity.com/hc/en-us/articles/17357975725085-Merchant-Match-API)
- ShopYourLikes Monetisation (Deep Link) API:
  [http://api.cnnx.link/docs/api/overview](http://api.cnnx.link/docs/api/overview)
