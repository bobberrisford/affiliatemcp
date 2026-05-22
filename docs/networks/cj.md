# Setting up affiliate-mcp with CJ Affiliate (estimated 8–10 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your CJ Affiliate publisher account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `CJ_API_TOKEN` and `CJ_COMPANY_ID`.

No prior API experience is assumed. CJ refers to its API key as a
*Personal Access Token* (PAT); this is the same thing as an API token
elsewhere in this document.

## Prerequisites

- An approved CJ Affiliate publisher account. Sign-in works at
  [https://members.cj.com/](https://members.cj.com/).
- API access on a CJ publisher account does not require a separate
  approval step. As long as your publisher account is active, you can
  generate a Personal Access Token at any time.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

If you can see your publisher dashboard after signing in — including the
*Account*, *Advertisers*, and *Reports* navigation items — you are
"approved" for the purposes of this guide.

## Steps

1. Sign in to the CJ publisher portal at
   [https://members.cj.com/](https://members.cj.com/). Use the same
   credentials you use to read your performance reports.

   [SCREENSHOT: docs/networks/images/cj/1-signin.png]

2. Open the user-avatar menu in the top-right of the dashboard and click
   *Account*. (The label is sometimes shown as *My Account* on older
   tenants — label exact to TBD by a human reviewer.)

   [SCREENSHOT: docs/networks/images/cj/2-account-menu.png]

3. In the *Account* sidebar, open the *Personal Access Tokens* tab. On
   some tenants this is shown under a *Developer* sub-menu rather than
   directly in the sidebar; both routes lead to the same screen.

   [SCREENSHOT: docs/networks/images/cj/3-pat-tab.png]

4. Click *Create Token* (label may also show as *Generate New Token*
   on older tenants). Give the token a descriptive name such as
   `affiliate-mcp`. CJ shows the token value once and does not show it
   again, so copy it immediately to a secure location.

   [SCREENSHOT: docs/networks/images/cj/4-create-token.png]

5. Note your numeric *Company ID*. It appears at the top of the *Account*
   page and is also embedded in the URL of most dashboard pages. The
   setup wizard auto-derives this from the token in the next step, so
   you do not need to copy it by hand unless your token has access to
   more than one publisher company.

   [SCREENSHOT: docs/networks/images/cj/5-company-id.png]

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **CJ Affiliate** when prompted. Paste the Personal Access Token when
   the wizard asks for `CJ_API_TOKEN`. Press Enter to accept the
   auto-derived company ID when the wizard offers it.

   [SCREENSHOT: docs/networks/images/cj/6-wizard-prompt.png]

## What success looks like

The wizard prints a confirmation line that the token validated against
CJ's GraphQL `me` query, shows the publisher company name CJ associates
with the token, and writes the two values to `~/.affiliate-mcp/.env`
with file permissions `0600`. From that point on,
`affiliate-networks-mcp test cj` should report `ok` for all CJ operations except
`listClicks` (CJ does not expose click-level data on the modern GraphQL
surface — see `REPORT.md` for the full known-limitation note).

## Common failures

### Failure: the *Personal Access Tokens* tab is missing from the Account page

This usually means you are signed in to an advertiser account rather
than a publisher account. CJ uses the same login form for both. Confirm
you are in the publisher portal at `members.cj.com` rather than the
advertiser portal at `members.cj.com/advertiser`. If you only have
advertiser access, request publisher access from your CJ account
manager.

### Failure: the wizard reports `401 Unauthorized` when validating the token

The token was copied with surrounding whitespace, was truncated, or has
been revoked. Re-open the *Personal Access Tokens* tab in CJ and confirm
the token is still listed; if it is not, create a new one. Paste it
into the wizard without leading or trailing spaces. CJ tokens are long
opaque strings; do not include any surrounding quotation marks from the
dashboard if they are displayed.

### Failure: the wizard reports GraphQL errors mentioning "company" or "companyId"

This means the token validated but the `{ me { companyId } }` lookup
returned an unexpected shape — most often because the token is attached
to a publisher account that is in the process of being migrated or has
no primary company on record. Run the wizard again and, when prompted,
override the auto-derived company ID by typing the numeric value
visible at the top of your CJ publisher dashboard. The wizard accepts
the manual value and writes it to `~/.affiliate-mcp/.env`.
