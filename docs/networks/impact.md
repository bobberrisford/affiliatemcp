# Setting up affiliate-mcp with Impact (estimated 5–8 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your Impact publisher (Mediapartner) account. You will end up with two
values written to `~/.affiliate-mcp/.env`: `IMPACT_ACCOUNT_SID` and
`IMPACT_AUTH_TOKEN`.

No prior API experience is assumed. Impact uses HTTP Basic authentication;
the Account SID acts as the username and the Auth Token as the password.

## Prerequisites

- An approved Impact publisher (Mediapartner) account. Sign-in works at
  [https://app.impact.com/](https://app.impact.com/).
- API access on an Impact publisher account does not require a separate
  approval step. Both credentials are visible on the Settings → API
  screen as soon as the account is active.
- A terminal in which you can run `npx affiliate-mcp setup` once the
  steps below are complete.

If you can see your Mediapartner dashboard after signing in — including
the *Partnerships*, *Reports*, and *Settings* navigation items — you are
"approved" for the purposes of this guide.

## Steps

1. Sign in to the Impact Mediapartner portal at
   [https://app.impact.com/](https://app.impact.com/). Use the same
   credentials you use to read your performance reports.

   [SCREENSHOT: docs/networks/images/impact/1-signin.png]

2. Open *Settings*. The settings link is the gear icon in the bottom-left
   sidebar of the dashboard on the current UI; on the older UI it lives
   under your user-avatar menu in the top-right. Either route leads to
   the same place.

   [SCREENSHOT: docs/networks/images/impact/2-settings.png]

3. In the Settings sidebar, click *API*. The page title reads *Account
   SID and Auth Token*. Both credentials affiliate-mcp needs are on
   this single page.

   [SCREENSHOT: docs/networks/images/impact/3-api-page.png]

4. Copy the value shown in the *Account SID* field. It is an
   alphanumeric string. Copy it exactly as shown without trimming or
   reformatting; leading or trailing whitespace will cause validation
   to fail.

   [SCREENSHOT: docs/networks/images/impact/4-account-sid.png]

5. Click *Show* next to the *Auth Token* field and copy the value.
   Impact treats the auth token like a password: it remains visible
   on this screen but should be treated as a secret. (Some tenants
   show this as a *Show / Hide* toggle rather than a *Show* button —
   label exact to TBD by a human reviewer.)

   [SCREENSHOT: docs/networks/images/impact/5-auth-token.png]

6. Back in your terminal, run `npx affiliate-mcp setup` and select
   **Impact** when prompted. Paste the Account SID when the wizard
   asks for `IMPACT_ACCOUNT_SID`, then paste the Auth Token when it
   asks for `IMPACT_AUTH_TOKEN`. The wizard validates the pair by
   calling Impact's `/Mediapartners/{SID}/Campaigns` endpoint with a
   page size of one.

   [SCREENSHOT: docs/networks/images/impact/6-wizard-prompt.png]

## What success looks like

The wizard prints a confirmation line that the credential pair
validated against Impact's `/Campaigns` endpoint and writes the two
values to `~/.affiliate-mcp/.env` with file permissions `0600`. From
that point on, `affiliate-mcp test impact` should report `ok` for all
seven publisher operations. Impact is the only one of the four
supported networks that exposes click-level data on the public
publisher surface.

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the credentials

Either the Account SID or the Auth Token was copied incorrectly. Both
strings can be long; check that no trailing space, line break, or
ellipsis sneaked in during copy-paste. Re-open Settings → API in
Impact and copy the values fresh. If the credentials are rejected
again with a valid-looking SID, the Auth Token may have been rotated
by another user or by an automated rotation policy on your account —
in that case copy the current value displayed in the dashboard.

### Failure: the wizard reports `5xx` errors during validation

Impact's `/Actions` endpoint is documented to return intermittent 5xx
responses when the report engine is warm-loading, and the same
behaviour occasionally affects other endpoints. The setup wizard
retries up to three times; if all three attempts fail with 5xx,
wait a minute and re-run `npx affiliate-mcp setup`. If the failure
persists for more than ten minutes, check the Impact status page
before assuming the credentials are wrong.

### Failure: the `Settings → API` link is missing from the Settings sidebar

This usually means you are signed in to an Impact *brand* account
rather than a *Mediapartner* account. The two account types share a
login form but have different sidebars. Use the account-switcher in
the top-right of the dashboard to switch to your Mediapartner
account. If you only have a brand account, you will need a separate
Mediapartner signup before affiliate-mcp can read publisher data.
