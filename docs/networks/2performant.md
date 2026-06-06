# Setting up affiliate-mcp with 2Performant (estimated 5 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your 2Performant affiliate (publisher) account. You will end up with two
values written to `~/.affiliate-mcp/.env`: `TWOPERFORMANT_EMAIL` and
`TWOPERFORMANT_PASSWORD`.

2Performant is a Romanian (RO) affiliate network. Affiliates settle in RON or
EUR depending on the advertiser.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the 2Performant dashboard is described; label wording
can change between dashboard refreshes, so the layout is described alongside.

## How 2Performant authentication works

2Performant does not issue a static API key. Authentication is
credential/session based: the adapter signs in with your account email and
password to a sign-in endpoint and receives a short-lived session (three
rotating headers: `access-token`, `client`, and `uid`). The adapter caches that
session in memory, replays it on every call, and re-establishes it
automatically if the network reports that it has expired.

Practical consequences:

- The email and password you provide are stored locally in
  `~/.affiliate-mcp/.env` (file permissions `0600`) and are used only to obtain
  a session. They never leave your machine.
- If you change your 2Performant account password, you must update
  `TWOPERFORMANT_PASSWORD` here, or sign-in will start failing.
- The cached session is held in memory and is lost on process restart; the
  adapter signs in again on the next call.

## Prerequisites

- An active 2Performant affiliate account. If you can sign in at
  [https://network.2performant.com/](https://network.2performant.com/) and see
  your affiliate dashboard, you have what you need.
- The account must be an affiliate (publisher) account, not an advertiser
  account. The adapter checks the role after sign-in.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Steps

1. Confirm you can sign in to 2Performant at
   [https://network.2performant.com/](https://network.2performant.com/) with the
   email and password you normally use to read your reports.

2. Make a note of that email address and password. There is no separate API key
   or token to generate: the adapter uses the same login the website uses.

3. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **2Performant** when prompted. Enter your account email when the wizard asks
   for `TWOPERFORMANT_EMAIL`, then enter your account password when it asks for
   `TWOPERFORMANT_PASSWORD`.

## What success looks like

The wizard signs in to 2Performant with the supplied credentials, confirms that
a session was issued, shows your account identity, and writes the two values to
`~/.affiliate-mcp/.env` with file permissions `0600`. From that point on,
`affiliate-networks-mcp test 2performant` should report `ok` for the supported
operations.

## Supported operations

- `listProgrammes` / `getProgramme` — your affiliate programmes
  (`/affiliate/programs`).
- `listTransactions` — your commissions (`/affiliate/commissions`), with status
  normalised to the canonical set (`pending` → pending, `accepted` → approved,
  `rejected` → reversed, `paid` → paid) and an age filter for unpaid-commission
  checks.
- `getEarningsSummary` — aggregated client-side from your commissions.
- `generateTrackingLink` — a quicklink built deterministically in the documented
  `events/click` format. It needs the programme **unique code** (read it from
  `rawNetworkData` on a programme), not the numeric id.

## Not supported

- `listClicks` — 2Performant does not expose click-level data as a list endpoint
  via the public affiliate API. Click context is only available embedded on a
  commission, not as a standalone list, so the operation reports
  `NotImplementedError` rather than returning an empty list.

## Known limitations

This adapter is `experimental`. It was built from the public API documentation
([https://doc.2performant.com/](https://doc.2performant.com/)) and the
2Performant PHP reference wrapper, and has not yet been verified against a live
2Performant account. In particular:

- Commission amounts are assumed to be in major currency units (RON / EUR, not
  bani / cents). This has not been confirmed against a live account.
- The commission date filter is sent as a `YYYY-MM-DD,YYYY-MM-DD` range; the
  exact accepted format may vary per tenant.

## Common failures

### Failure: the wizard reports an authentication error on sign-in

The email or password was entered incorrectly, copied with surrounding
whitespace, or the account password has changed. Re-enter both values. Confirm
you can sign in with the same credentials at
[https://network.2performant.com/](https://network.2performant.com/).

### Failure: the account is not an affiliate account

The adapter expects an affiliate (publisher) account. If your login is an
advertiser account, the affiliate endpoints are not available to it. Use the
affiliate account credentials instead.

### Failure: `generateTrackingLink` reports a missing programme unique code

Tracking links require the programme's unique code rather than its numeric id.
List your programmes first and read the unique code from the programme's
`rawNetworkData`, then pass that value as the programme id to the tracking-link
operation.
