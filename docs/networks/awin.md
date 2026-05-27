# Setting up affiliate-mcp with Awin (estimated 5–8 minutes)

This guide walks you through the credentials affiliate-mcp needs in order to
talk to your Awin publisher account. You will end up with two values written
to `~/.affiliate-mcp/.env`: `AWIN_API_TOKEN` and `AWIN_PUBLISHER_ID`.

No prior API experience is assumed. Where a step refers to a button or menu
label, the exact wording from the Awin dashboard is shown in italics; label
wording can change between dashboard refreshes, so the layout is described
alongside.

## Prerequisites

- An approved Awin publisher account. If you can sign in at
  [https://ui.awin.com/](https://ui.awin.com/) and see your publisher
  dashboard, you have what you need.
- API access on an Awin publisher account does not require a separate
  approval step. As long as your publisher account itself is active, you can
  generate an API token on demand.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the steps
  below are complete.

If you can see your publisher dashboard after signing in — including the
*Performance*, *Programmes*, and *Account* navigation items — you are
"approved" for the purposes of this guide.

## Steps

1. Sign in to the Awin publisher dashboard at
   [https://ui.awin.com/](https://ui.awin.com/). Use the same credentials
   you use to read your performance reports.

2. Open your user menu in the top-right corner of the dashboard and click
   *Account*. (On older dashboard versions this item may be labelled
   *My Account*; both lead to the same screen.)

3. On the *Account* page, open the *API credentials* tab. The tab is
   usually in the left-hand sidebar of the account page. (Some publishers
   see this as *API access* — label exact to TBD by a human reviewer.)

4. Click *Generate new token* to create a long-lived OAuth2 token. Awin
   shows the token value on screen once; copy it immediately to a secure
   location before leaving the page.

5. Note your numeric *Publisher ID* — it is shown at the top of the same
   *Account* page (and also in the URL of most dashboard pages). You can
   skip writing this down: the setup wizard auto-derives it from the token
   in the next step and offers it back to you for confirmation.

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select **Awin**
   when prompted. Paste the API token when the wizard asks for
   `AWIN_API_TOKEN`. Press Enter to accept the auto-derived publisher ID
   when the wizard offers it (or override it if your token has access to
   multiple publisher accounts and the wrong one was picked).

## What success looks like

The wizard prints a confirmation line that the token validated against the
`/accounts?type=publisher` endpoint, shows the human-readable name of your publisher
account, and writes the two values to `~/.affiliate-mcp/.env` with file
permissions `0600`. From that point on, `affiliate-networks-mcp test awin` should
report `ok` for all Awin operations except `listClicks` (Awin does not
expose click-level data via the public publisher API — see `REPORT.md` for
the full known-limitation note).

## Awin reference implementation

Awin is the repo's reference implementation for AI-native affiliate data. In
addition to the canonical cross-network tools, Awin exposes network-specific
tools for accounts, programme details, commission groups, commission-sharing
rules, transaction-by-ID lookup, transaction queries, advertiser/creative/
campaign reports, Link Builder, Offers, and actionable gated stubs.

See the endpoint-by-endpoint inventory:
[`docs/networks/awin/api-inventory.md`](./awin/api-inventory.md).

### Environment variables

- `AWIN_API_TOKEN` — the bearer token from Awin's API credentials screen.
- `AWIN_PUBLISHER_ID` — derived from `GET /accounts?type=publisher` by setup,
  or set manually when the token can access multiple publisher accounts.
- `AWIN_PRODUCT_FEED_API_KEY` — not used by this PR yet. Product Feed list and
  download tools return actionable stubs until separate feed-key and
  large-file handling are implemented.
- `AWIN_PROOF_OF_PURCHASE_API_KEY` — not used by this PR yet. Proof of Purchase
  is activation-gated and write-capable, so the tool documents requirements
  and does not submit live orders.

### Read-only live tests

Use the ignored workspace-local config file for live validation:

```sh
AFFILIATE_MCP_CONFIG_DIR=/Users/othmanb/Desktop/affiliate/affiliatemcp/.affiliate-mcp npm run dev -- test awin
```

For the Awin-specific endpoint set, validate only read endpoints unless a
maintainer explicitly approves a write test. Empty-but-200 responses count as
successful endpoint validation when the account has no data for the period.

Recommended live checks:

- Accounts: list publisher accounts and confirm the derived publisher ID.
- Programmes: list joined programmes, then fetch details and commission groups
  for one joined advertiser.
- Transactions: list a recent narrow window, then fetch by ID if a sample row
  exists.
- Reports: advertiser, creative, and campaign performance for a recent period.
- Offers: retrieve joined active offers with pagination.
- Link Builder: check quota, then generate one non-shortened long URL only
  for a joined advertiser.

Do not submit Proof of Purchase transactions during routine validation.

### Link Builder behaviour

The canonical `affiliate_awin_generate_tracking_link` tool still constructs
the stable `awin1.com/cread.php` long URL locally. The Awin-specific
`affiliate_awin_generate_tracking_links` tool calls Awin's official Link
Builder API when you want Awin to validate deeplink support, return per-request
errors, or generate batches up to Awin's documented limit of 100 requests.

## Common failures

### Failure: the *API credentials* tab is missing from the Account page

This usually means you are signed in to an advertiser account rather than
a publisher account. Awin uses the same login form for both. Switch to the
publisher view from the account-type selector in the top-right of the
dashboard. If you only have advertiser access, you will need a separate
publisher signup at [https://www.awin.com/gb/publishers](https://www.awin.com/gb/publishers).

### Failure: the wizard reports `401 Unauthorized` when validating the token

The token was copied with surrounding whitespace, was truncated, or has
been revoked. Re-open the *API credentials* tab in Awin and confirm the
token is still listed; if it is not, generate a new one. Paste it into
the wizard without any leading or trailing spaces. The token is a
long opaque string; do not include the surrounding quotes from the Awin
UI if any are shown.

### Failure: the wizard derives the wrong publisher ID

This happens when an API token has access to more than one publisher
account and Awin returns them in an order that does not match your
expectations. Override the auto-derived value at the wizard's confirmation
prompt by typing the numeric publisher ID you can see at the top of your
publisher dashboard. You can re-run `npx affiliate-networks-mcp setup` at any time
to change the stored value.
