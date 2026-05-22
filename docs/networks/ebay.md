# Setting up affiliate-mcp with eBay Partner Network (estimated 10-15 minutes)

This guide walks you through the credentials affiliate-mcp needs to talk to
your eBay Partner Network (EPN) publisher account. You will end up with three
values written to `~/.affiliate-mcp/.env`: `EBAY_CLIENT_ID`,
`EBAY_CLIENT_SECRET`, and `EBAY_CAMPAIGN_ID`.

No prior API experience is assumed. eBay's developer portal and the EPN
dashboard are two separate sites; you will visit both.

## Prerequisites

- An approved eBay Partner Network publisher account. You can sign up at
  [https://partnernetwork.ebay.com/](https://partnernetwork.ebay.com/);
  approval typically takes a few working days.
- A developer account at
  [https://developer.ebay.com/](https://developer.ebay.com/). You can use
  the same eBay sign-in for both sites.
- Your developer application must be **enrolled in the Partner Network**.
  Enrolment is a one-time step on the eBay developer portal and typically
  takes 1-3 working days to complete after you submit the application. If
  your application is still pending review, the OAuth token exchange will
  fail; the wizard will surface the eBay error message verbatim.

If you can sign in to the EPN dashboard at
[https://partnernetwork.ebay.com/](https://partnernetwork.ebay.com/) and see
at least one campaign listed, your publisher account is good.

## Steps

1. Sign in to the eBay developer portal at
   [https://developer.ebay.com/](https://developer.ebay.com/) and open
   *My Account → Application Keys*.

   [SCREENSHOT: docs/networks/images/ebay/1-developer-portal-keys.png]

2. If you have no Production keys yet, click *Create a keyset* and select
   *Production*. If a Production set already exists, you can reuse it.
   eBay shows three values: *App ID (Client ID)*, *Dev ID*, and *Cert ID
   (Client Secret)*. You will need the App ID and the Cert ID.

   [SCREENSHOT: docs/networks/images/ebay/2-production-keyset.png]

3. Confirm your application is enrolled in the Partner Network. From the
   same *Application Keys* screen, follow the *Compliance / API
   Subscriptions* link and verify that *Partner Network* shows as
   *Enrolled* (or equivalent). If it shows *Pending* or is missing,
   submit the enrolment request and wait for approval before continuing.

   [SCREENSHOT: docs/networks/images/ebay/3-api-subscriptions.png]

4. Sign in to the EPN dashboard at
   [https://partnernetwork.ebay.com/](https://partnernetwork.ebay.com/)
   and open *Campaigns*. Note the numeric *Campaign ID* of the campaign
   you want this client to attribute clicks to.

   [SCREENSHOT: docs/networks/images/ebay/4-epn-campaign-id.png]

   The campaign ID is the value in the *Campaign ID* column, not the
   campaign name. If you have no campaigns yet, create one (the campaign
   creation form asks for a name, a default landing URL, and a
   marketplace).

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **eBay Partner Network** when prompted.

   [SCREENSHOT: docs/networks/images/ebay/5-wizard-prompt.png]
   - Paste your *App ID* when the wizard asks for `EBAY_CLIENT_ID`.
   - Paste your *Cert ID* when the wizard asks for `EBAY_CLIENT_SECRET`.
     The wizard exchanges these for an OAuth2 access token to confirm
     the credentials work.
   - Enter your numeric *Campaign ID* when the wizard asks for
     `EBAY_CAMPAIGN_ID`.

## What success looks like

The wizard prints a confirmation line that the credentials exchanged for an
access token, and writes the three values to `~/.affiliate-mcp/.env` with
file permissions `0600`. From that point on, `affiliate-networks-mcp test ebay`
should report `ok` for all seven publisher operations, with the caveat that
new transactions take approximately 24-48 hours to appear in EPN's
reporting endpoints — a fresh account's `listTransactions` call may return
an empty list even after clicks have been recorded.

## A note on the eBay model

EPN is structurally different from Awin, CJ, Impact, and Rakuten: there is
only one advertiser (eBay itself) and the concept that corresponds to "a
programme" on every other network is an EPN **campaign**. In this adapter:

- "Programme" means EPN campaign.
- The `programmeId` argument to `listTransactions`,
  `generateTrackingLink`, and the `affiliate_ebay_*` tools is an EPN
  campaign ID, not a merchant ID.

This is documented in `REPORT.md` under the eBay row's known-limitations
column.

## Optional environment overrides

The adapter reads a handful of optional environment variables documented in
`.env.example`. The defaults work for UK publishers using production eBay;
the overrides exist for tenants who need them.

- `EBAY_MARKETPLACE_ID` — sets the `X-EBAY-C-MARKETPLACE-ID` header on
  every request. Defaults to `EBAY_GB`. US publishers should set
  `EBAY_US`; see the eBay developer docs for the full marketplace list.
- `EBAY_OAUTH_SCOPE` — overrides the default OAuth scope used for the
  token exchange. The default
  (`https://api.ebay.com/oauth/api_scope`) is the lowest-privilege
  scope that grants the EPN reporting + tracking endpoints.
- `EBAY_ROTATION_ID` — the rover rotation segment used in tracking-link
  construction. The default (`711-53200-19255-0`) is the documented
  EPN default; set this only if EPN gave you a different rotation.
- `EBAY_BASE_URL` — point at `https://api.sandbox.ebay.com` to exercise
  the adapter against eBay's sandbox.
- `EBAY_TOKEN_URL` — overrides the OAuth token endpoint (matches
  `EBAY_BASE_URL`'s sandbox use case).

## Common failures

### Failure: the wizard reports `401 invalid_client`

The App ID and the Cert ID came from different key sets, or one of the
values was copied with surrounding whitespace. Re-open
[https://developer.ebay.com/my/keys](https://developer.ebay.com/my/keys),
confirm both values come from the same *Production* row, and paste them
into the wizard without leading or trailing spaces.

### Failure: the wizard reports a token exchange error mentioning `not enrolled` or `application not approved`

Your developer application is not yet enrolled in the Partner Network.
Visit the *API Subscriptions* tab in the developer portal and submit the
enrolment request. The typical turnaround is 1-3 working days. The error
message from eBay is surfaced verbatim by affiliate-mcp; you can paste it
into eBay's developer support form if the wait runs long.

### Failure: `listTransactions` returns an empty list on a fresh account

EPN's transaction reporting is delayed approximately 24-48 hours. A user
who has just configured the wizard and made a test click will not see the
click in `listTransactions` until the next reporting cycle. This is a
property of the eBay API, not a bug in affiliate-mcp; the empty list is
the correct answer at that moment.

### Failure: the wizard rejects the campaign ID with "must be a positive integer"

You pasted the campaign name rather than the numeric ID. Re-open
*Campaigns* in the EPN dashboard and copy the value from the *Campaign ID*
column.
