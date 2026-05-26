# Setting up affiliate-mcp with Impact (advertiser side) (estimated 8 minutes)

This guide walks you through the credentials affiliate-mcp needs to read
your Impact **brand / advertiser** account — i.e. the side of Impact
that runs a programme other publishers promote, not the publisher side
that earns commissions on someone else's programme.

You will end up with two values written to `~/.affiliate-mcp/.env`:
`IMPACT_ADVERTISER_ACCOUNT_SID` and `IMPACT_ADVERTISER_AUTH_TOKEN`.

Impact uses HTTP Basic authentication; the Account SID is the username
and the Auth Token is the password. The adapter is **read-only**: the
HTTP client refuses any non-GET method client-side, and we strongly
recommend pairing that with Impact's read-only credential tier on the
server side.

## Prerequisites

- An approved Impact **brand** or **agency** account (sign-in at
  [https://app.impact.com/](https://app.impact.com/) — pick the brand or
  agency portal once you are signed in; the two share a login form but
  not a sidebar).
- API access on an Impact brand or agency account does not require a
  separate approval step. Both credentials are visible on the
  Settings → API screen as soon as the account is active.
- A terminal in which you can run `npx affiliate-networks-mcp setup`.

## Agency passthrough vs brand-direct

Impact offers two credential tiers and the adapter auto-detects which
you provided:

- **Agency passthrough (preferred for agencies).** You paste the
  Agency SID. A single credential addresses every brand in your
  portfolio. The adapter discovers them via
  `GET /Agencies/{AgencySID}/Advertisers`. All subsequent API calls go
  through the agency prefix, e.g.
  `/Agencies/{AgencySID}/Advertisers/{BrandSID}/Campaigns`.

- **Brand-direct.** You paste the Advertiser SID. One credential, one
  brand. The adapter returns a single synthetic entry from
  `listBrands()`. API calls go through `/Advertisers/{BrandSID}/...`.

The adapter probes `GET /Agencies/{SID}` once at first contact to
decide which tier you provided. A 2xx response means agency tier; a 404
or 403 means brand-direct. A 401 means the credentials are wrong.

## Steps

1. Sign in to Impact at [https://app.impact.com/](https://app.impact.com/).
   Pick the brand portal (or the agency portal, if you are an agency).

   [SCREENSHOT: docs/networks/images/impact-advertiser/1-signin.png]

2. Open *Settings* (gear icon in the sidebar) → *API*. The page title
   reads *Account SID and Auth Token*. Both credentials are on this
   page.

   [SCREENSHOT: docs/networks/images/impact-advertiser/2-api-page.png]

3. **Recommended:** create a *read-only* token on this page. Click
   *Create new API token* → role: *Read-only*. This adapter ships with
   a client-side guard that refuses any non-GET request, but a
   read-only token gives you defence in depth at Impact's side too.

   [SCREENSHOT: docs/networks/images/impact-advertiser/3-readonly-token.png]

4. Copy the *Account SID* exactly as shown. For an agency, this is the
   Agency SID; for a single brand, the Advertiser SID. The wizard's
   description prompt explains which to paste; you do not need to know
   in advance — the adapter auto-detects.

   [SCREENSHOT: docs/networks/images/impact-advertiser/4-account-sid.png]

5. Copy the *Auth Token* value (click *Show* if it is masked). Treat
   it as a password.

   [SCREENSHOT: docs/networks/images/impact-advertiser/5-auth-token.png]

6. Back in your terminal, run `npx affiliate-networks-mcp setup` and
   select **Impact (advertiser)** when prompted. Paste the Account SID
   when the wizard asks for `IMPACT_ADVERTISER_ACCOUNT_SID`, then paste
   the Auth Token when it asks for `IMPACT_ADVERTISER_AUTH_TOKEN`. The
   wizard probes `GET /Agencies/{SID}` to detect the credential tier
   and prints the result inline.

   [SCREENSHOT: docs/networks/images/impact-advertiser/6-wizard-prompt.png]

7. If the credentials are agency-tier the wizard runs the brand-
   discovery sub-flow: it lists every advertiser the agency credential
   can address, defaults each apiEnabled brand to ticked, and prompts
   you for the local slug to bind each one to under `brands.json`.
   If `listBrands` fails (network down, schema drift) or comes back
   empty, the wizard explains what happened and drops into a manual-
   entry sub-flow that asks for a local slug + Advertiser SID + display
   name and writes each entry to `brands.json` for you. The same
   manual path is also offered if you prefer it — see the CJ
   advertiser guide (`docs/networks/cj-advertiser.md`) for the
   wizard-driven manual workflow.

## What success looks like

The wizard prints `Token verified. Credential tier detected:
agency-passthrough` (or `brand-direct`) and writes the two values to
`~/.affiliate-mcp/.env` with file permissions `0600`. For agency creds,
the brand-discovery sub-flow then writes a `brands.json` entry per
selected advertiser. From that point on, `affiliate-networks-mcp test
impact-advertiser` should report `ok` for every supported operation,
and advertiser-side tools take a `brand` argument that the dispatcher
resolves to the right Advertiser SID under the hood.

## Common failures

### Failure: the wizard reports `401 Unauthorized` when validating the credentials

Either the Account SID or the Auth Token was copied incorrectly. Both
strings can be long; check that no trailing space, line break, or
ellipsis sneaked in during copy-paste. Re-open Settings → API in
Impact and copy the values fresh.

### Failure: the wizard reports tier as `brand-direct` when you expected `agency-passthrough`

You almost certainly pasted an Advertiser SID instead of an Agency SID.
Sign in to the agency portal (not the brand portal) and copy the SID
from Settings → API there. The agency portal and brand portal each
show their own SID on this screen and the SIDs are distinct.

### Failure: the adapter refuses a write operation

This is by design. The Impact advertiser adapter is read-only at
v0.1. If you need to approve commissions, change rates, or perform any
other mutation, do it via the Impact dashboard for now. A future PR
will lift the read-only guard explicitly; until then any non-GET call
fails fast with a `config_error` envelope and no network round-trip.
