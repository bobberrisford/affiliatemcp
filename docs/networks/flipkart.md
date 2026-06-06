# Flipkart Affiliate adapter

Flipkart Affiliate is the publisher-side programme for the Indian Flipkart
marketplace. This adapter is publisher-side and single-brand: one set of
credentials addresses one affiliate account, and there is a single merchant
(Flipkart) rather than a catalogue of advertisers.

The adapter ships as `experimental`: it has not been validated against a live
Flipkart account, and a few field conventions in the orders report are assumed
rather than confirmed (see Known limitations).

## Prerequisites

- A publisher account on Flipkart Affiliate at https://affiliate.flipkart.com/.
- An API token generated from that account (see Credentials needed).
- Region: the programme and its product data are India-specific; amounts are
  in Indian Rupees (INR).
- Flipkart periodically pauses new affiliate signups. If you cannot register,
  the programme may be closed to new applicants at the moment; there is no
  workaround other than waiting for signups to reopen.

## Credentials needed

The adapter reads two environment variables. Both are shown on the same
dashboard screen.

- `FLIPKART_AFFILIATE_ID` — your affiliate tracking ID. Sign in at
  https://affiliate.flipkart.com/, open the "API" menu, then "API Token", and
  copy the value in the "Affiliate Tracking ID" field. It is sent on every
  request as the `Fk-Affiliate-Id` header.
- `FLIPKART_AFFILIATE_TOKEN` — your API token. On the same "API Token" screen,
  click "Generate API Token" and copy the value. It is sent as the
  `Fk-Affiliate-Token` header. Only one token is active per account:
  generating a new token disables the previous one.

## Setup steps

1. Sign in at https://affiliate.flipkart.com/.
2. Open the "API" menu, then "API Token".
3. Copy the "Affiliate Tracking ID" into the `FLIPKART_AFFILIATE_ID` prompt.
4. Click "Generate API Token", then copy the token into the
   `FLIPKART_AFFILIATE_TOKEN` prompt.

The wizard validates the token against the tracking ID by calling the product
feed listing endpoint, so enter the tracking ID first.

## Common failures

1. **Cannot register / no API menu** — Flipkart has paused new affiliate
   signups. The dashboard shows no way to create an account or the API token
   screen is unavailable. There is no workaround; wait for signups to reopen.
2. **401 / 403 on every call** — the token and tracking ID do not match, or the
   token was regenerated (which disabled the one you are using). Open the "API
   Token" screen, confirm the tracking ID, regenerate the token, and update
   `FLIPKART_AFFILIATE_TOKEN`.
3. **Empty orders report for a known-active period** — the orders report only
   covers windows the programme has data for, and the adapter defaults to the
   last 30 days when no dates are given. Pass an explicit `from`/`to` window
   that you know contains orders.

## Known limitations

- The adapter has not been validated against a live Flipkart affiliate account,
  so it ships as `experimental`.
- Order and commission amounts are assumed to be in Indian Rupees (INR) as
  whole-rupee decimal values. The orders report does not document the
  minor-unit convention, so amounts are surfaced verbatim from the report's
  `amount` field without rescaling. Confirm against your dashboard totals.
- Flipkart periodically pauses new affiliate signups, so the programme may be
  closed to new applicants when you attempt to register.
- Click-level data is not exposed via the public affiliate API, so `listClicks`
  is unsupported. The adapter raises a clear "not implemented" error rather
  than returning an empty list.

## Verifying

```
affiliate-networks-mcp test flipkart
```

The CLI runs the live diagnostic. A pass confirms the credentials reach the
Flipkart API and the implemented operations respond.
