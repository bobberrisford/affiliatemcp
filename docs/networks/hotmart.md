# Setting up affiliate-mcp with Hotmart (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
Hotmart account. You will end up with two required values written to
`~/.affiliate-mcp/.env`: `HOTMART_CLIENT_ID` and `HOTMART_CLIENT_SECRET`. A
third value, `HOTMART_BASIC_TOKEN`, is optional.

No prior API experience is assumed. Hotmart uses 2-legged OAuth2
client-credentials authentication. The wizard handles the token exchange
automatically once you provide the Client ID and Secret.

## Prerequisites

- An active Hotmart account (creator/producer or affiliate). Sign in at
  [https://app.hotmart.com/](https://app.hotmart.com/).
- API access is self-serve: you create your own credentials under
  Tools, with no separate approval step.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** Hotmart has no public endpoint that lists the products you are
affiliated to together with their commission rates. `listProgrammes` and
`getProgramme` are therefore derived from the products that appear in your
Sales History: a product with no sales in the lookup window will not be listed,
and the commission rate is left unset (you can infer it from commission and
amount per transaction). `listClicks` and `generateTrackingLink` are not
supported (see Known limitations).

## Credentials needed

| Variable | Required | Description | Where to find it |
|----------|----------|-------------|-----------------|
| `HOTMART_CLIENT_ID` | Yes | OAuth2 Client ID | Hotmart → Tools → Developer Tools |
| `HOTMART_CLIENT_SECRET` | Yes | OAuth2 Client Secret | Same page as Client ID |
| `HOTMART_BASIC_TOKEN` | No | Precomputed `base64(Client ID:Client Secret)` | Same page, shown as the "Basic" token. The adapter computes this for you, so you can leave it blank. |

## Setup steps

1. Sign in to Hotmart at
   [https://app.hotmart.com/](https://app.hotmart.com/).

2. Open the **Tools** menu.

3. Select **Developer Tools** (this is the Hotmart API / Credentials area).

4. Create a set of credentials if you do not already have one. You should then
   see:
   - **Client ID** — an identifier string.
   - **Client Secret** — a longer secret string.
   - **Basic** — a precomputed Base64 token. This is optional for affiliate-mcp.

5. Copy the **Client ID** value and keep the page open for the next steps.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Hotmart** when prompted. The wizard will ask for:

   - **HOTMART_CLIENT_ID** — paste the value from step 5.
   - **HOTMART_CLIENT_SECRET** — copy from the Developer Tools page and paste
     here. The wizard validates both credentials live against the Hotmart
     OAuth2 token endpoint immediately after you enter the secret.
   - **HOTMART_BASIC_TOKEN** — optional; leave blank unless you prefer to paste
     the precomputed Basic value rather than the raw Client ID and Secret.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
HOTMART_CLIENT_ID=your-client-id-here
HOTMART_CLIENT_SECRET=your-client-secret-here
# HOTMART_BASIC_TOKEN is optional and is derived from the id and secret if omitted.
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on token exchange | Wrong Client ID or Secret | Re-copy both from Tools → Developer Tools. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential HOTMART_CLIENT_ID` | Client ID not set | Add `HOTMART_CLIENT_ID=<your id>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: Hotmart does not expose click-level data` | `listClicks` was called | Hotmart's public payments API does not return click data. There is no workaround via the API. |
| `not_implemented: Hotmart affiliate links (hotlinks)...` | `generateTrackingLink` was called | Hotlinks are issued per affiliation in the dashboard and cannot be constructed via the API. Copy the hotlink from your Hotmart dashboard instead. |
| `not_implemented: Hotmart product ... was not found` | `getProgramme` for a product with no recent sales | Programmes are derived from Sales History. Widen the window by calling `listTransactions` first, or pick a product that has sold recently. |
| Sales History returns fewer sales than expected | No `transaction_status` filter on the upstream API | The adapter sends the full documented status set, so all states should appear. If a state is still missing, confirm the sale falls within your date window. |

## Known limitations

- **listProgrammes / getProgramme**: Derived from the distinct products seen in
  Sales History, because Hotmart has no public self-serve endpoint that lists a
  creator/affiliate's products with commission rates. Products with no sales in
  the lookup window are not discoverable, and `commissionRate` is left unset.
- **listClicks**: Hotmart does not expose click-level data via the public
  payments API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: Hotmart affiliate links (hotlinks) are issued per
  affiliation in the dashboard and embed an opaque affiliate code that cannot be
  deterministically constructed or minted via the public API. The operation
  throws `NotImplementedError`.
- **Default status behaviour**: When no `transaction_status` filter is supplied,
  Hotmart returns only APPROVED and COMPLETE sales. The adapter sends the full
  documented status set so every state is retrieved.
- **Multi-role commissions**: A Sales History row can credit the account as
  PRODUCER, COPRODUCER or AFFILIATE. The adapter sums the commission line(s)
  attributed to the account; the per-role breakdown is preserved in
  `rawNetworkData`.
- **Token lifetime**: OAuth2 access tokens are valid for a limited period
  (Hotmart documents 24 hours). The adapter refreshes the token automatically,
  but cached tokens are lost on process restart.
- **Not verified against a live account**: This adapter was built from public
  Hotmart API documentation. Some field names and endpoint shapes have not been
  confirmed against a live API response. The `claim_status` is `experimental`
  until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test hotmart
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- hotmart`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your client identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes` → `supported: true` (derived from Sales History).
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
