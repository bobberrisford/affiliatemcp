# Setting up affiliate-mcp with Eduzz (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Aeduzz%22)

This guide walks you through the credentials affiliate-mcp needs to read your
Eduzz account. You will end up with three values written to
`~/.affiliate-mcp/.env`: `EDUZZ_EMAIL`, `EDUZZ_PUBLIC_KEY`, and `EDUZZ_API_KEY`.

No prior API experience is assumed. Eduzz uses a token-exchange scheme: your
email, PublicKey and APIKey are posted to the Eduzz token endpoint, which
returns a short-lived token used for subsequent calls. The wizard handles the
token exchange automatically once you provide the three values.

Eduzz is a Brazilian platform; the panel is in Portuguese and amounts are
normally denominated in BRL.

## Prerequisites

- An active Eduzz account (producer/affiliate). Sign in at the Eduzz panel.
- API access does not require a separate approval step. As long as your account
  is active, the PublicKey and APIKey are available in the panel.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `EDUZZ_EMAIL` | The email you log in to Eduzz with | Your account login |
| `EDUZZ_PUBLIC_KEY` | The account PublicKey | Eduzz panel → Ferramentas → API (or My Eduzz → Integrações → API) |
| `EDUZZ_API_KEY` | The account APIKey | Same page as the PublicKey |

## Setup steps

1. Log in to your Eduzz account.

2. Open the panel menu and go to **Ferramentas → API** (on the newer panel this
   is **My Eduzz → Integrações → API**).

3. On the API page you will see two values:
   - **PublicKey** — a long alphanumeric string.
   - **APIKey** — a second long alphanumeric string.

4. Keep this page open. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Eduzz** when prompted. The wizard will ask for:

   - **EDUZZ_EMAIL** — the email you log in to Eduzz with.
   - **EDUZZ_PUBLIC_KEY** — paste the PublicKey from step 3.
   - **EDUZZ_API_KEY** — paste the APIKey from step 3. The wizard validates all
     three values together against the Eduzz token endpoint
     (`https://api2.eduzz.com/credential/generate_token`) immediately after you
     enter the API key.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
EDUZZ_EMAIL=you@example.com
EDUZZ_PUBLIC_KEY=your-public-key-here
EDUZZ_API_KEY=your-api-key-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` (or 403) on token exchange | Wrong email, PublicKey or APIKey | Re-copy the PublicKey and APIKey from Ferramentas → API. Confirm `EDUZZ_EMAIL` is the account login. Watch for trailing spaces when pasting. |
| `auth_error: returned a response with no profile.token field` | Token endpoint reached but credentials rejected | Re-check all three values; the keys may have been rotated in the panel. |
| `config_error: Missing required credential EDUZZ_API_KEY` | API key not set | Add `EDUZZ_API_KEY=<your key>` to `~/.affiliate-mcp/.env` (or re-run setup). |
| `not_implemented: Eduzz does not expose click-level data` | `listClicks` called | Eduzz has no click-level API; this operation is unsupported. |
| `not_implemented: ... generated per product inside the panel` | `generateTrackingLink` called | Eduzz affiliate links are created per product inside the panel (Afiliados → Promover); there is no self-serve link API. |
| `network_api_error: non-JSON body` | Eduzz returned an HTML error page | Wait a few minutes and retry; check the Eduzz status page for outages. |
| Sales list is empty | Date range has no data | Try a wider date window. By default the adapter reads the last 30 days. |

## Known limitations

- **Not verified against a live account**: this adapter was built from public
  Eduzz API documentation. The `claim_status` is `experimental` until a live
  account test is completed.
- **Sales endpoint shape unconfirmed**: the sales listing route
  (`GET /sale/get_sale_list`) and its `date_start`/`date_end` window are
  documented on `https://api2.eduzz.com/`, but the exact query-parameter and
  response field names could not be confirmed against the live reference
  (the developer portal returns HTTP 403 to automated documentation fetches).
  Fields are read defensively and the verbatim payload is preserved in
  `rawNetworkData`.
- **listClicks**: Eduzz does not expose click-level data via its API. The
  operation throws `NotImplementedError`.
- **generateTrackingLink**: not implemented. Eduzz affiliate links are generated
  per product inside the panel (Afiliados → Promover); there is no documented
  self-serve link-construction API. The operation throws `NotImplementedError`.
- **Token lifetime**: the token returned by the exchange is short-lived
  (~15 minutes). The adapter refreshes it automatically, but cached tokens are
  lost on process restart.
- **Currency**: amounts are typically denominated in BRL. The currency is read
  from the payload where present and defaults to BRL otherwise.

## Verifying

```
affiliate-networks-mcp test eduzz
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- eduzz`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your account identity.
- `listProgrammes` → your Eduzz products, mapped to programmes.
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → totals derived from the sales in the window.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
