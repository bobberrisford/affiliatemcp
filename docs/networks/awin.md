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

   [SCREENSHOT: docs/networks/images/awin/1-signin.png]

2. Open your user menu in the top-right corner of the dashboard and click
   *Account*. (On older dashboard versions this item may be labelled
   *My Account*; both lead to the same screen.)

   [SCREENSHOT: docs/networks/images/awin/2-account-menu.png]

3. On the *Account* page, open the *API credentials* tab. The tab is
   usually in the left-hand sidebar of the account page. (Some publishers
   see this as *API access* — label exact to TBD by a human reviewer.)

   [SCREENSHOT: docs/networks/images/awin/3-api-credentials-tab.png]

4. Click *Generate new token* to create a long-lived OAuth2 token. Awin
   shows the token value on screen once; copy it immediately to a secure
   location before leaving the page.

   [SCREENSHOT: docs/networks/images/awin/4-generate-token.png]

5. Note your numeric *Publisher ID* — it is shown at the top of the same
   *Account* page (and also in the URL of most dashboard pages). You can
   skip writing this down: the setup wizard auto-derives it from the token
   in the next step and offers it back to you for confirmation.

   [SCREENSHOT: docs/networks/images/awin/5-publisher-id.png]

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select **Awin**
   when prompted. Paste the API token when the wizard asks for
   `AWIN_API_TOKEN`. Press Enter to accept the auto-derived publisher ID
   when the wizard offers it (or override it if your token has access to
   multiple publisher accounts and the wrong one was picked).

   [SCREENSHOT: docs/networks/images/awin/6-wizard-prompt.png]

## What success looks like

The wizard prints a confirmation line that the token validated against the
`/publishers` endpoint, shows the human-readable name of your publisher
account, and writes the two values to `~/.affiliate-mcp/.env` with file
permissions `0600`. From that point on, `affiliate-networks-mcp test awin` should
report `ok` for all Awin operations except `listClicks` (Awin does not
expose click-level data via the public publisher API — see `REPORT.md` for
the full known-limitation note).

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
