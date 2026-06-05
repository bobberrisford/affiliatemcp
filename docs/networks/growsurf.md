# Setting up affiliate-mcp with GrowSurf (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your GrowSurf account. GrowSurf is a referral platform used on the
merchant (advertiser) side, so this adapter reads your own programme's
participants and referral credit. You will end up with two values written to
`~/.affiliate-mcp/.env`: `GROWSURF_API_KEY` and `GROWSURF_CAMPAIGN_ID`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the GrowSurf dashboard is shown; label wording can
change between dashboard refreshes, so the layout is described alongside.

## Prerequisites

- A GrowSurf account with at least one campaign (programme). If you can sign in
  and open a campaign in the dashboard, you have what you need.
- API access on a GrowSurf account does not require a separate approval step.
  As long as your account is active, you can generate an API key on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

GrowSurf is campaign-scoped: every data request names a campaign id. This
adapter is single-brand — one API key plus one campaign id addresses one
programme. If you run several campaigns, choose the one you want to manage and
note its id (see step 5).

## Credentials needed

- `GROWSURF_API_KEY` — the API key from your GrowSurf account settings. Sent as
  a bearer token (`Authorization: Bearer <key>`) on every request. Keep it
  secret; it grants full access to your GrowSurf data.
- `GROWSURF_CAMPAIGN_ID` — the id of the campaign (programme) you want to read.
  It is the short code in the dashboard URL after `/campaign/`.

## Setup steps

1. Sign in to your GrowSurf account.

2. Open *Settings* (the gear icon).

3. Open the *Account* tab, then the *API* section. Generate a new API key or
   copy an existing one. Copy the value to a secure location before leaving the
   page.

4. Open the campaign (programme) you want to manage.

5. Read the campaign id from the dashboard URL. It is the segment after
   `/campaign/` — for example, `4pdlhb` in `.../campaign/4pdlhb`.

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **GrowSurf** when prompted. Paste the API key when the wizard asks for
   `GROWSURF_API_KEY`, then paste the campaign id for `GROWSURF_CAMPAIGN_ID`.
   The wizard verifies the pair together by reading the campaign.

## What success looks like

The wizard confirms that the key and campaign id validated against the
`GET /v2/campaign/:id` endpoint, then writes the two values to
`~/.affiliate-mcp/.env`. From that point on, `affiliate-networks-mcp test
growsurf` should report `ok` for the supported operations. `listClicks` and
`generateTrackingLink` report as unsupported by design (see Known limitations).

## Common failures

### Failure: the wizard reports an authentication error when validating

The key was copied with surrounding whitespace, was truncated, or has been
regenerated; or the campaign id does not belong to the account behind the key.
Re-open *Settings → Account → API*, confirm the key is still listed, and
re-read the campaign id from the dashboard URL. Paste both without any leading
or trailing spaces.

### Failure: the campaign id is rejected, but the key looks correct

The key and campaign id are validated together. A valid key paired with a
campaign id from a different account fails. Confirm both belong to the same
GrowSurf account, then re-run `npx affiliate-networks-mcp setup`.

### Failure: transaction amounts look like small whole numbers, not money

This is expected. GrowSurf is referral-credit oriented, not classic
pay-per-sale. The adapter maps each participant who has earned referral credit
to one transaction whose amount and commission are the referral count, with the
currency set to the sentinel `CREDIT`. See Known limitations.

## Known limitations

These mirror `known_limitations` in `src/networks/growsurf/network.json`.

- This adapter was implemented from the public API documentation and has not
  yet been validated against a live account (`claim_status: experimental`).
- GrowSurf is referral-credit oriented, not classic pay-per-sale. The API does
  not expose a monetary commission per referral event, so each participant with
  referral credit is mapped to one transaction whose amount and commission are
  the referral count (not money), and whose currency is the sentinel `CREDIT`.
  Reward fulfilment (coupons, account credit, gift cards) is configured per
  campaign and is not returned per event.
- One API key plus one campaign id addresses one programme (advertiser,
  single-brand). Bind your single brand in `brands.json` manually.
- Click-level data is not exposed: GrowSurf reports impression counts on
  participants, not raw click records. `listClicks` is unsupported.
- `generateTrackingLink` is unsupported: a participant share URL is minted per
  participant and is not derivable from a destination URL via the merchant API.
- The participants-list wrapper key and the campaign reward field names have
  not been confirmed against a live account. Transformers read fields
  defensively and preserve the verbatim payload on `rawNetworkData`.
- Participant list pagination is cursor-based (`nextId` / `more`). Wide pulls
  are capped at an internal maximum page count and log a warning rather than
  silently truncating.

## Verifying

```
affiliate-networks-mcp test growsurf
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- growsurf`. The diagnostic engine's pass is the
verification contract.
