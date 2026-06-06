# Setting up affiliate-mcp with Adrecord (estimated 5 minutes)

This guide walks you through the single credential affiliate-mcp needs in order
to talk to your Adrecord publisher account. You will end up with one value
written to `~/.affiliate-mcp/.env`: `ADRECORD_API_KEY`.

Adrecord is a Nordic (Swedish) network, so reporting is typically in Swedish
kronor (SEK). No prior API experience is assumed. Where a step refers to a
button or menu label, the wording from the Adrecord dashboard is shown in
italics; label wording can change between dashboard refreshes, so the layout is
described alongside.

## Prerequisites

- An approved Adrecord publisher account. If you can sign in at
  [https://www.adrecord.com/](https://www.adrecord.com/) and see your publisher
  dashboard, you have what you need.
- API access on an Adrecord publisher account does not require a separate
  approval step. As long as your publisher account is active, you can generate
  a private API key on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

### `ADRECORD_API_KEY`

A private API key generated from your publisher account. Adrecord sends this key
in a request header named `APIKEY` (the key may also be passed as a query or
form variable, but affiliate-mcp uses the header so the secret stays out of
URLs and logs). The key is long-lived and does not auto-expire, but it can be
regenerated from the same screen at any time.

## Setup steps

1. Sign in to the Adrecord publisher dashboard at
   [https://www.adrecord.com/](https://www.adrecord.com/). Use the same
   credentials you use to read your reports.

2. Open *Settings* (the account or cog menu). The exact placement varies by
   dashboard version; it is usually reached from your account menu.

3. Open the *API* section within settings.

4. Generate a private API key and copy the value. Store it somewhere secure
   before leaving the page.

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Adrecord** when prompted. Paste the key when the wizard asks for
   `ADRECORD_API_KEY`.

## What success looks like

The wizard validates the key against the `GET /programs` endpoint, reports that
the key is authenticated, and writes the value to `~/.affiliate-mcp/.env` with
file permissions `0600`. From that point on, `affiliate-networks-mcp test
adrecord` should report `ok` for the programme, transaction, and earnings
operations.

## Common failures

### Failure: the wizard reports `401` when validating the key

The key was copied with surrounding whitespace, was truncated, or has been
regenerated (which revokes the previous value). Re-open the *API* section in the
Adrecord dashboard, confirm the key, and paste it into the wizard without any
leading or trailing spaces.

### Failure: the *API* section is missing from settings

This usually means you are signed in to an advertiser account rather than a
publisher account, or the API has not been enabled for your account. Confirm you
are using the publisher dashboard; if the section is still absent, contact
Adrecord support (api@adrecord.com) to confirm API access for your account.

### Failure: requests start returning errors after a burst of calls

The Adrecord affiliate API throttles at roughly 30 requests per 30 seconds. The
adapter chunks wide date ranges and retries throttled responses with backoff,
but a very large reporting window run repeatedly in a short period can still
reach the limit. Narrow the date window or wait for the limit to reset.

## Known limitations

These mirror `known_limitations` in `src/networks/adrecord/network.json`:

- The adapter was built from the public Adrecord affiliate API documentation
  and has not yet been verified against a live Adrecord account, so its claim
  status is `experimental`.
- Click-level data is not exposed as a list endpoint by the public affiliate
  API. The `/statistics` endpoint reports aggregate click counts per channel,
  not individual click rows, so `listClicks` is unsupported and returns a
  not-implemented result rather than an empty list.
- The tracking-link URL format is not publicly documented in a way that allows
  the link to be constructed deterministically, so `generateTrackingLink` is
  unsupported. Build tracking links from the Adrecord dashboard for now.
- Transaction amounts (`orderValue`, `commission`) are assumed to be in major
  currency units (for example SEK, not öre). This matches the documented
  examples but has not been confirmed against a live account.

## Verifying

```
affiliate-networks-mcp test adrecord
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- adrecord`. Programme, transaction, and earnings
operations should report `ok`; `listClicks` and `generateTrackingLink` are
reported as unsupported by design.
