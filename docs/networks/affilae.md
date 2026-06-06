# Setting up affiliate-mcp with Affilae (estimated 5 minutes)

This guide walks you through the credential affiliate-mcp needs in order to
talk to your Affilae publisher account. You will end up with one value written
to `~/.affiliate-mcp/.env`: `AFFILAE_API_TOKEN`.

No prior API experience is assumed. Where a step refers to a menu label, the
wording from the Affilae dashboard is shown in italics; label wording can change
between dashboard refreshes, so the location is described alongside.

This adapter is `experimental`. It was implemented from Affilae's public API
documentation and has not yet been validated against a live publisher account.
Treat its output as unverified until you have confirmed it against your own
data.

## Prerequisites

- An active Affilae publisher account. If you can sign in at
  [https://app.affilae.com/](https://app.affilae.com/) and see your publisher
  dashboard, you have what you need.
- API access does not require a separate approval step. As long as your
  publisher account is active, you can generate a token on demand.
- Affilae issues separate tokens for publishers and advertisers. Use a
  publisher token for this adapter.

## Credentials needed

- `AFFILAE_API_TOKEN` — a bearer token generated from the *API Tokens* menu in
  the Affilae dashboard. Affilae sends this token on every request as
  `Authorization: Bearer <token>`.

## Setup steps

1. Sign in to the Affilae publisher dashboard at
   [https://app.affilae.com/](https://app.affilae.com/).

2. Open the *API Tokens* menu. It sits under your account settings; the exact
   placement depends on your dashboard version.

3. Create a new token and copy the value. Affilae shows the token so you can
   copy it; store it somewhere secure. The token is long-lived but can be
   revoked from the same screen.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Affilae** when prompted. Paste the token when the wizard asks for
   `AFFILAE_API_TOKEN`. The wizard validates it against
   `GET /publisher/publishers.me` before saving.

## Common failures

1. **The wizard reports `401` or `403` when validating the token.** The token
   was copied with surrounding whitespace, was revoked, or is an advertiser
   token rather than a publisher token. Re-open the *API Tokens* menu, confirm
   the token is still listed, and paste it without leading or trailing spaces.

2. **Wrong token type (advertiser instead of publisher).** Affilae issues
   separate tokens for the two sides. A publisher adapter authenticated with an
   advertiser token will fail to read `/publisher/...` routes. Generate a token
   from the publisher dashboard.

3. **Empty transaction results for a recent period.** Affilae returns
   conversions only for windows in which the account recorded activity. An
   empty result is not an error; widen the date range or confirm against your
   dashboard.

## Known limitations

- This adapter was implemented from public API documentation and has not yet
  been validated against a live account (`claim_status: experimental`).
- Monetary amounts are returned by Affilae in cents. The adapter converts them
  to major units (for example, `100` becomes `1.00`); the verbatim cents value
  is preserved on `rawNetworkData`.
- Click-level data is not exposed to publishers via the documented API, so
  `listClicks` is unsupported and returns a `not_implemented` result rather than
  an empty list.
- Tracking links are minted server-side with a per-programme format (C2S or
  S2S) that is not publicly documented. `generateTrackingLink` is therefore
  unsupported pending live verification, rather than producing a guessed link
  that might not track.

## Verifying

```
affiliate-networks-mcp test affilae
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- affilae`. The diagnostic engine's pass is the
verification contract.
