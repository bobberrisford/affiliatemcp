# Setting up affiliate-mcp with ValueCommerce (estimated 10 minutes)

This guide walks you through the credentials affiliate-mcp needs to read your
ValueCommerce affiliate (publisher) account. You will end up with two values
written to `~/.affiliate-mcp/.env`: `VALUE_COMMERCE_CLIENT_KEY` and
`VALUE_COMMERCE_CLIENT_SECRET`.

No prior API experience is assumed. ValueCommerce issues a "report API
authentication key" pair from the management console. The wizard joins and
Base64-encodes the pair to obtain a short-lived bearer token automatically once
you provide the key and secret.

## Prerequisites

- An active ValueCommerce affiliate-site account, signed in to the affiliate
  management console.
- The ability to issue the report API authentication key. The "API認証キーを
  発行する" (issue API auth key) button can only be clicked by the contract owner
  or a sub-contract owner. If you do not have that role, ask the account owner to
  issue the key for you. Once issued, the key can be read by users with other
  permissions.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** This adapter is built on the affiliate Order Report API, which is a
transaction report. ValueCommerce does not expose a self-serve programme or
merchant directory through this API, nor click-level data, nor tracking-link
generation. `listProgrammes`, `getProgramme`, `listClicks`, and
`generateTrackingLink` therefore report as not implemented. The supported
operations are `listTransactions`, `getEarningsSummary`, and `verifyAuth`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `VALUE_COMMERCE_CLIENT_KEY` | The report API authentication key (CLIENT_KEY) | Console → Settings (設定) → Report API auth key (レポートAPI認証キーの取得) |
| `VALUE_COMMERCE_CLIENT_SECRET` | The report API authentication secret (CLIENT_SECRET) | Same page as CLIENT_KEY |

## Setup steps

1. Sign in to the ValueCommerce affiliate management console.

2. Open **Tools (ツール) → Report API (レポートAPI)**.

3. On first use you will see the **issue API auth key** screen. Read and agree to
   the terms, then click **API認証キーを発行する** ("issue API auth key"). Only
   the contract owner or a sub-contract owner can click this button.

4. Open **Settings (設定) → Report API auth key (レポートAPI認証キーの取得)**. You
   should see two values:
   - **CLIENT_KEY** — your report API authentication key.
   - **CLIENT_SECRET** — your report API authentication secret.

5. Copy the **CLIENT_KEY** value and keep the page open for the next step.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **ValueCommerce** when prompted. The wizard will ask for:

   - **VALUE_COMMERCE_CLIENT_KEY** — paste the value from step 5.
   - **VALUE_COMMERCE_CLIENT_SECRET** — copy from the Report API auth key page and
     paste here. The wizard validates both values live against the ValueCommerce
     token endpoint immediately after you enter the secret.

You can also set credentials manually in `~/.affiliate-mcp/.env`:

```
VALUE_COMMERCE_CLIENT_KEY=your-client-key-here
VALUE_COMMERCE_CLIENT_SECRET=your-client-secret-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` on token acquisition | Wrong CLIENT_KEY or CLIENT_SECRET | Re-copy both from Settings → Report API auth key. Watch for trailing spaces or line breaks when pasting. |
| `auth_error: invalid_token` mid-session | The 30-minute token expired | The adapter refreshes automatically; if it persists, re-run setup to confirm the key pair is still valid. |
| `config_error: Missing required credential VALUE_COMMERCE_CLIENT_KEY` | CLIENT_KEY not set | Add `VALUE_COMMERCE_CLIENT_KEY=<your key>` to `~/.affiliate-mcp/.env`. |
| `rate_limit` / "locked" | Too many token requests in a 30-minute window | ValueCommerce locks the token endpoint after a burst of requests; wait 30 minutes and retry. |
| `not_implemented` on listProgrammes / listClicks / generateTrackingLink | A non-report operation was called | These are not exposed by the affiliate Order Report API. Use `listTransactions` and `getEarningsSummary`. |
| `network_api_error: could not be parsed as XML` | The report endpoint returned an unexpected body | Confirm the account is active and the date window is valid; retry after a few minutes. |
| Transactions list is empty | Date range has no conversions | Try a wider date window (the adapter defaults to the last 30 days). |

## Known limitations

- **listProgrammes / getProgramme**: ValueCommerce exposes no self-serve
  affiliate programme or merchant directory through the public report API. Both
  operations throw `NotImplementedError`.
- **listClicks**: Click-level data is not exposed by the affiliate Order Report
  API. The operation throws `NotImplementedError` rather than returning an empty
  list.
- **generateTrackingLink**: ValueCommerce tracking links (MyLink) are created in
  the console and are not derivable from the report API credentials. The
  operation throws `NotImplementedError`.
- **XML response format**: The affiliate Order Report API returns XML by default.
  The adapter parses it with a small built-in parser. The exact XML element names
  per transaction field are not confirmed from public documentation, so the
  adapter reads several candidate tag names defensively and preserves the verbatim
  XML on each transaction's `rawNetworkData`.
- **Token lifetime**: Access tokens are valid for 30 minutes. The adapter
  refreshes the token automatically, but cached tokens are lost on process
  restart.
- **Not verified against a live account**: This adapter was built from public
  ValueCommerce API documentation. Some field names and endpoint shapes
  (including the preferred report API version, v1/v2/v3) have not been confirmed
  against a live API response. The `claim_status` is `experimental` until a live
  account test is completed.

## Verifying

```
affiliate-networks-mcp test value-commerce
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- value-commerce`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your client identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `getEarningsSummary` → derived from the same transactions.
- `listProgrammes`, `getProgramme`, `listClicks`, `generateTrackingLink` →
  `supported: false` with the known-limitation note.
