# Setting up affiliate-mcp with AvantLink (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your AvantLink affiliate account. You will end up with three values
written to `~/.affiliate-mcp/.env`: `AVANTLINK_AFFILIATE_ID`,
`AVANTLINK_WEBSITE_ID`, and `AVANTLINK_API_KEY`.

AvantLink is a US affiliate network with a strong focus on the outdoor niche.
Its API is a single REST "report framework" endpoint at
`https://classic.avantlink.com/api.php`: every operation is selected by a
`module=` query parameter, and the three credentials above travel as query
parameters rather than as an HTTP header.

No prior API experience is assumed. Where a step refers to a button or menu
label, the wording from the AvantLink dashboard is shown in italics; label
wording can change between dashboard refreshes, so the layout is described
alongside.

This adapter is **experimental**: it was built from AvantLink's public API
documentation and has not yet been verified against a live account. Treat its
output as provisional until you have confirmed it against your own dashboard
figures. See the known limitations below.

## Prerequisites

- An active AvantLink affiliate account. If you can sign in at
  [https://classic.avantlink.com/](https://classic.avantlink.com/) and see your
  affiliate dashboard, you have what you need.
- At least one registered website under the account. AvantLink scopes reports
  and tracking links to a website, so you need a website ID.
- API access on an AvantLink affiliate account does not require a separate
  approval step: as long as your account is active, the API key is available in
  the dashboard.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

- `AVANTLINK_AFFILIATE_ID` — your numeric affiliate identifier, shown under
  *Account* → *API*.
- `AVANTLINK_WEBSITE_ID` — the numeric identifier of the registered website you
  report on, shown under *Account* → *Websites*.
- `AVANTLINK_API_KEY` — your 32-character API key (the `auth_key` query
  parameter), shown under *Account* → *API*. This is the only secret of the
  three.

## Setup steps

1. Sign in to the AvantLink dashboard at
   [https://classic.avantlink.com/](https://classic.avantlink.com/).

2. Open *Account* → *API*. Note the *Affiliate ID* shown on this page, and copy
   the 32-character *API Key* (the `auth_key`). Use *Regenerate* here only if
   you need a fresh key; regenerating invalidates the previous one.

3. Open *Account* → *Websites*. Note the *Website ID* beside the registered site
   you want to report on. If you have several sites, pick the one whose
   performance you want affiliate-mcp to read.

4. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **AvantLink** when prompted. Enter the affiliate ID, then the website ID,
   then paste the API key. The wizard validates the API key by running the
   `AssociationFeed` module against the affiliate and website IDs you entered.

## What success looks like

The wizard prints a confirmation line that the API key validated against the
`AssociationFeed` module, shows your affiliate and website identifiers, and
writes the three values to `~/.affiliate-mcp/.env` with file permissions
`0600`. From that point on, `affiliate-networks-mcp test avantlink` should
report `ok` for every AvantLink operation except `listClicks` (AvantLink does
not expose per-click data via the affiliate API).

## Common failures

### Failure: the wizard reports an authentication error when validating the key

The API key was copied with surrounding whitespace, was truncated, or has been
regenerated since you last copied it. Re-open *Account* → *API* and confirm the
key is the current 32-character value. Paste it into the wizard without any
leading or trailing spaces.

### Failure: the association feed comes back empty

This usually means the website ID does not match the affiliate account, or the
affiliate is not yet associated with any merchants on that website. Confirm the
*Website ID* under *Account* → *Websites* belongs to the same account as the
affiliate ID, and that you have joined at least one merchant programme.

### Failure: a tracking link is not generated for a merchant

`generateTrackingLink` calls the `CustomLink` module, which only produces a link
for a merchant the affiliate is associated with on the configured website.
Confirm the merchant appears in `affiliate_avantlink_list_programmes` with a
joined status before generating a link, and that you passed the numeric merchant
ID as `programmeId`.

## Known limitations

These mirror `known_limitations` in `network.json`:

- **Built from public documentation.** The adapter was written from AvantLink's
  public API docs and has not been verified against a live account. Field names
  and report shapes are provisional.
- **Amount unit assumption.** Monetary amounts are assumed to be decimal
  currency units (for example `12.50`), not minor units (cents). Confirm this
  against your own figures before relying on totals.
- **No per-click data.** AvantLink does not expose a stable per-click feed via
  the affiliate API; only aggregate click-through reports are available, so
  `listClicks` is unsupported and returns a clear not-implemented error rather
  than an empty list.

## Verifying

```
affiliate-networks-mcp test avantlink
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- avantlink`. The diagnostic engine's pass is the
verification contract.
