# Partnerize publisher adapter

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Apartnerize%22)

Partnerize (formerly Performance Horizon) is an affiliate network used by
major brands worldwide. This adapter connects to the Partnerize Partner API
on behalf of a publisher (affiliate) account.

## Prerequisites

- An active publisher account on Partnerize.
- API access is available to all publisher accounts; no separate approval is
  required for API credentials.
- Your account must be approved on at least one campaign to retrieve
  transactions and earnings data.

## Credentials needed

### `PARTNERIZE_APPLICATION_KEY`

Found in the Partnerize console:

1. Log in at https://console.partnerize.com/.
2. Click your user avatar (top-right) → **Settings** → **Account Settings**.
3. Copy the value under **User Application Key**.

The application key identifies the Partnerize network partition. It does not
rotate automatically.

### `PARTNERIZE_USER_API_KEY`

Found in the same location as the application key:

1. Log in at https://console.partnerize.com/.
2. Click your user avatar (top-right) → **Settings** → **Account Settings**.
3. Copy the value under **User API Key**.

The user API key is your personal API credential and acts as the Basic-auth
password alongside the application key.

### `PARTNERIZE_PUBLISHER_ID`

The wizard derives this automatically from the `GET /user/publisher` response
after both of the above keys are validated. You do not normally need to enter
it manually.

If auto-derivation fails (e.g. your credentials span multiple publisher
accounts and the wrong one is selected), you can find your publisher ID in the
Partnerize console URL after login. For example, a URL of
`https://console.partnerize.com/publisher/1234567/...` indicates a publisher
ID of `1234567`.

## Setup steps

1. Run the setup wizard: `affiliate-networks-mcp setup`.
2. Select **Partnerize** from the network list.
3. When prompted for **Application Key**, copy the value from the Partnerize
   console → Settings → Account Settings → User Application Key.
4. When prompted for **User API Key**, copy the value from the same screen
   under User API Key.
5. The wizard verifies both keys by calling `GET /user/publisher` and
   auto-fills the **Publisher ID**. Press Enter to confirm the auto-derived
   value (or edit it if multiple accounts are available under your credentials).

## Common failures

1. **HTTP 401 Unauthorized** — The application key or user API key is incorrect
   or has been revoked. Re-generate the key in the Partnerize console →
   Settings → Account Settings. Copy the new value carefully; avoid leading or
   trailing whitespace.

2. **Publisher ID not derived** — If the wizard reports "no publisher accounts
   found", your API credentials may be associated with an account that has no
   active publisher records. Log in to the Partnerize console and confirm that
   your account type is "Publisher" and not "Advertiser". If you have both, use
   the publisher-specific credentials.

3. **HTTP 403 on reporting endpoints** — Campaign-level reporting requires that
   you are approved on at least one campaign. If you have no approved campaigns,
   `listTransactions` will return an empty list or a 403 response. Apply to join
   campaigns in the Partnerize console under **Campaigns → Available**.

4. **Tracking link mismatch** — `generateTrackingLink` requires a camref (not
   a campaign_id). If the link does not track correctly, confirm that you are
   passing the camref from the campaign tracking details page, not the numeric
   campaign ID shown in the URL.

## Known limitations

- **Built from public API documentation; not yet verified against a live account.**
  All endpoint paths, field names, and status values are sourced from the
  Partnerize API blueprint (`github.com/PerformanceHorizonGroup/apidocs`).
  Field names may differ from live responses. TODO(verify) annotations in the
  code mark unconfirmed fields.

- **listClicks is experimental.** The publisher click endpoint is documented in
  the API blueprint but its JSON response field names have not been confirmed
  against a live account. Results may require adapter adjustment after live
  testing.

- **generateTrackingLink expects a camref, not a campaign_id.** A camref is a
  per-publisher, per-campaign identifier that differs from the numeric
  campaign_id. Find your camref in the Partnerize console on the campaign
  tracking details page, or from the tracking endpoint
  `GET /user/publisher/{publisher_id}/campaign/a/tracking`.

- **Pagination is limited.** The adapter fetches one page of results per
  date-window request. For very active accounts with many conversions in a
  short window, results may be truncated at the API's default page size.
  Cursor-based pagination following is not yet implemented.

## Verifying

```
affiliate-networks-mcp test partnerize
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- partnerize`. The diagnostic engine's pass is the
verification contract.

To verify manually after setup:

```
affiliate-networks-mcp list-programmes --network partnerize
affiliate-networks-mcp list-transactions --network partnerize --from 2026-01-01 --to 2026-05-28
```
