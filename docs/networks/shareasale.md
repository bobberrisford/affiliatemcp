# Setting up affiliate-mcp with ShareASale (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your ShareASale affiliate (publisher) account. You will end up with
three values written to `~/.affiliate-mcp/.env`: `SHAREASALE_AFFILIATE_ID`,
`SHAREASALE_API_TOKEN`, and `SHAREASALE_API_SECRET`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the ShareASale dashboard is shown in italics;
label wording can change between dashboard refreshes, so the layout is
described alongside.

ShareASale is a US network. It is owned by Awin, but it runs on a separate
account and a separate API, so this adapter is standalone: your Awin
credentials will not work here, and ShareASale credentials will not work with
the Awin adapter.

## Prerequisites

- An approved ShareASale affiliate account. If you can sign in at
  [https://account.shareasale.com/](https://account.shareasale.com/) and see
  your affiliate dashboard, you have what you need.
- API access enabled on the account. ShareASale exposes the API Manager to
  affiliate accounts directly; you generate a token and secret on demand. If
  the *API Manager* screen is not visible, contact ShareASale support to have
  API access switched on for your account.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `SHAREASALE_AFFILIATE_ID` — your numeric affiliate id, shown in the account
  header and on the *API Manager* screen.
- `SHAREASALE_API_TOKEN` — the *API Token* on the *API Manager* screen. Sent
  on every request and also mixed into the request signature.
- `SHAREASALE_API_SECRET` — the *Secret Key* on the same screen. Used locally
  to sign each request (HMAC-SHA256); it is never transmitted.

## Setup steps

1. Sign in to the ShareASale dashboard at
   [https://account.shareasale.com/](https://account.shareasale.com/).

2. Note your numeric affiliate id. It appears in the account header and on the
   *API Manager* screen.

3. Open the *API Manager* at
   [https://account.shareasale.com/a-apimanager.cfm](https://account.shareasale.com/a-apimanager.cfm).
   Copy the *API Token* and the *Secret Key*. If no token exists yet, generate
   one from the same screen; ShareASale shows the secret once, so copy it
   immediately.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **ShareASale** when prompted. Enter the affiliate id, the API token, and the
   secret key in turn. The wizard verifies the secret by making one signed call
   to the merchant-status report, so a wrong value is caught immediately.

## What success looks like

The wizard prints a confirmation that the signed merchant-status call
succeeded, shows your affiliate id as the identity, and writes the three values
to `~/.affiliate-mcp/.env` with file permissions `0600`. From that point,
`affiliate-networks-mcp test shareasale` should report `ok` for all ShareASale
operations except `listClicks` (ShareASale does not expose click-level data via
the public affiliate API).

## Common failures

1. **Signature failure on every call** — the request signature is computed
   from a timestamp; if your machine clock is skewed from GMT by more than a
   few minutes, ShareASale rejects the signature. Confirm the system clock is
   accurate and retry. A mistyped *Secret Key* produces the same symptom, so
   re-copy the secret from the *API Manager* screen if the clock is correct.

2. **API Manager screen not visible** — API access has not been enabled for
   the account. Contact ShareASale support and ask for API access to be
   switched on, then re-run the wizard once it appears.

3. **Wrong credential half** — the affiliate id, token, and secret are three
   distinct values from the same screen. A swapped token and secret, or an id
   from a different account, surfaces as an authentication error during setup.
   Re-copy each value from the *API Manager* screen.

## Known limitations

This adapter mirrors the `known_limitations` in
[`src/networks/shareasale/network.json`](../../src/networks/shareasale/network.json):

- **Experimental.** The adapter was implemented from public API documentation
  and has not yet been validated against a live account. Field names, response
  envelopes, and the amount unit are inferred and may differ in production.
- **Amount unit assumption.** Commission amounts are treated as major-currency
  units (USD) as returned by the API; the unit is not authoritatively
  documented and the verbatim value is always preserved on `rawNetworkData`.
- **HMAC-SHA256 signing.** Every request is signed over a
  `token:date:action:secret` string; a clock skewed from GMT will produce
  signature failures.
- **Awin-owned but separate.** ShareASale is owned by Awin but runs on a
  separate account and a separate API; this adapter is standalone and does not
  reuse the Awin adapter.
- **No click data.** Click-level data is not exposed via the public affiliate
  API, so `listClicks` is unsupported and reports as such rather than returning
  an empty list.

## Verifying

```
affiliate-networks-mcp test shareasale
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- shareasale`. The diagnostic engine's pass is the
verification contract. Because the adapter is `experimental`, treat a green
diagnostic as confirmation that the request shape authenticates, not as a
guarantee that every transformed field matches a production payload.
