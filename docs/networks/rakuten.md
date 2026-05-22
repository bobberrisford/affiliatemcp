# Setting up affiliate-mcp with Rakuten Advertising (estimated 10–15 minutes, plus approval wait)

This guide walks you through the credentials affiliate-mcp needs to read
your Rakuten Advertising publisher account. You will end up with three
values written to `~/.affiliate-mcp/.env`: `RAKUTEN_CLIENT_ID`,
`RAKUTEN_CLIENT_SECRET`, and `RAKUTEN_SID`.

No prior API experience is assumed. Rakuten uses OAuth2 client credentials,
which means the wizard exchanges your client ID and secret for a
short-lived access token at run time; you do not need to manage tokens
by hand.

## Prerequisites

- An approved Rakuten Advertising publisher account. Sign-in works at
  [https://rakutenadvertising.com/](https://rakutenadvertising.com/) →
  *Publisher* view.
- **API access on Rakuten requires a separate approval step.** A
  freshly-created publisher account does not have the *API Credentials*
  tab visible. The Publisher Solutions team must explicitly grant
  API access; documented turnaround is 3–7 business days, and the
  orchestrator's working estimate is 5 business days.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once
  Rakuten has provisioned the credentials.

"Approved" for the purposes of this guide means that when you open
*Account* in the Rakuten publisher dashboard, you can see an
*API Credentials* tab in the sidebar. If you do not see that tab,
your account does not yet have API access and you should request it
before continuing (see step 1 below).

## Steps

1. Sign in to the Rakuten Advertising publisher portal at
   [https://rakutenadvertising.com/](https://rakutenadvertising.com/)
   and switch to the *Publisher* view if you have access to more than
   one account type. If the *API Credentials* tab is not yet visible
   under *Account*, contact Rakuten Publisher Solutions and request
   API access; typical turnaround is around 5 business days.

   [SCREENSHOT: docs/networks/images/rakuten/1-publisher-view.png]

2. Once API access has been granted, open *Account* in the publisher
   dashboard and click the *API Credentials* tab. (Label exact to TBD
   by a human reviewer; some tenants show this as *API Access*.)

   [SCREENSHOT: docs/networks/images/rakuten/2-api-credentials-tab.png]

3. If a credential pair is not already listed, click *Generate
   Credentials* to create one. Rakuten shows the *Client Secret* in
   full only once at generation time, so copy both the *Client ID*
   and the *Client Secret* immediately to a secure location.

   [SCREENSHOT: docs/networks/images/rakuten/3-generate-credentials.png]

4. Open the *Sites* tab in the same *Account* area. Each publisher
   site has its own numeric *Site ID* (SID). Note the SID for the
   site you want affiliate-mcp to attribute traffic to. A single
   OAuth2 client may have access to more than one site, so the SID
   is required — affiliate-mcp cannot derive it from the credential
   pair.

   [SCREENSHOT: docs/networks/images/rakuten/4-sites-sid.png]

5. Back in your terminal, run `npx affiliate-networks-mcp setup` and select
   **Rakuten Advertising** when prompted. Paste the *Client ID* when
   the wizard asks for `RAKUTEN_CLIENT_ID`, the *Client Secret* when
   it asks for `RAKUTEN_CLIENT_SECRET`, and the numeric Site ID when
   it asks for `RAKUTEN_SID`.

   [SCREENSHOT: docs/networks/images/rakuten/5-wizard-prompt.png]

6. If the wizard reports a `404` when validating the token endpoint,
   set `RAKUTEN_TOKEN_URL=https://api.rakutenmarketing.com/token` in
   `~/.affiliate-mcp/.env` and re-run setup. Some tenants are
   provisioned against `api.rakutenmarketing.com` rather than the
   default `api.linksynergy.com`; the override flag is documented in
   `src/networks/rakuten/auth.ts`.

   [SCREENSHOT: docs/networks/images/rakuten/6-token-host-override.png]

## What success looks like

The wizard prints a confirmation line that an OAuth2 access token was
successfully exchanged at Rakuten's `/token` endpoint and writes the
three values to `~/.affiliate-mcp/.env` with file permissions `0600`.
From that point on, `affiliate-networks-mcp test rakuten` should report `ok`
for all Rakuten operations except `listClicks`. Click-level reporting
is gated by Rakuten as a paid tier and is unavailable on accounts
that have not been upgraded; see `REPORT.md` for the full
known-limitation note.

## Common failures

### Failure: the *API Credentials* tab does not appear under Account

API access is not yet provisioned on the account. Rakuten requires
the Publisher Solutions team to enable API access explicitly; this
is not a UI bug. Contact Rakuten Publisher Solutions through the
support form in the dashboard and request API access. Documented
turnaround is 3–7 business days. While you wait, the rest of
affiliate-mcp will work normally with the other configured networks.

### Failure: the wizard reports `404` when exchanging the token

Your tenant is provisioned against a different token host than the
default. Set `RAKUTEN_TOKEN_URL=https://api.rakutenmarketing.com/token`
in `~/.affiliate-mcp/.env` and re-run `npx affiliate-networks-mcp setup`. Both
`api.linksynergy.com` and `api.rakutenmarketing.com` are valid
Rakuten token hosts; the adapter defaults to `linksynergy.com` and
accepts the environment-variable override for the other.

### Failure: the wizard reports `401 Unauthorized` from the token endpoint

The Client ID or Client Secret was copied incorrectly. The Client
Secret is shown in full only at credential-generation time, so if
you no longer have a copy you will need to regenerate the credential
pair from the *API Credentials* tab — note that regenerating
invalidates the previous secret. After generating fresh credentials,
re-run `npx affiliate-networks-mcp setup` and paste the new values.
