# Setting up affiliate-mcp with Commission Factory (estimated 10 minutes)

This guide walks you through the credential affiliate-mcp needs to read your
Commission Factory publisher (affiliate) account. You will end up with one value
written to `~/.affiliate-mcp/.env`: `COMMISSION_FACTORY_API_KEY`.

No prior API experience is assumed. Commission Factory authenticates with a
single API key passed as a query parameter; there is no OAuth flow and no token
exchange to manage.

Commission Factory is an APAC-focused network (part of the Awin Group, but a
separate API). Transaction amounts are reported in each transaction's own
currency, commonly AUD; the adapter reads the currency from each record rather
than assuming one.

## Prerequisites

- An active Commission Factory affiliate account. Sign in at
  [https://app.commissionfactory.com/](https://app.commissionfactory.com/).
- API access does not require a separate approval step. As long as your account
  is active, you can generate an API key yourself under your profile.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

## Credentials needed

### `COMMISSION_FACTORY_API_KEY`

Your Commission Factory API key. It authenticates every request as the `apiKey`
query parameter.

To generate it:

1. Log in to the Commission Factory dashboard at
   [https://app.commissionfactory.com/](https://app.commissionfactory.com/).
2. Open your user profile menu (top-right) and go to **Account Settings**.
3. Select the **API** section.
4. **Generate** an API key (or copy the existing one).
5. Copy the key. Treat it as a secret; it grants read access to your account
   data.

## Setup steps

1. Generate and copy your API key as described above.

2. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Commission Factory** when prompted. The wizard will ask for:

   - **COMMISSION_FACTORY_API_KEY** — paste the value from the step above. The
     wizard validates it live against the Commission Factory API immediately, so
     you learn at once if the key is wrong.

You can also set the credential manually in `~/.affiliate-mcp/.env`:

```
COMMISSION_FACTORY_API_KEY=your-api-key-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` or `HTTP 403` | Wrong, revoked, or mistyped API key | Re-copy the key from Account Settings → API. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential COMMISSION_FACTORY_API_KEY` | Key not set | Add `COMMISSION_FACTORY_API_KEY=<your key>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: ... click-level data` | `listClicks` called | Commission Factory's Affiliate API does not expose click-level data. |
| `network_api_error: ... returned no TrackingUrl` | `generateTrackingLink` called for a merchant you have not joined | Deep links are merchant-specific. Confirm the programme is joined and approved in the dashboard. |
| `network_api_error: non-JSON body` | Commission Factory returned an HTML error page | Wait a few minutes and retry; check the Commission Factory status channels. |
| Transactions list is empty | Date range has no data | Try a wider date window. The default window is the last 30 days. |

## Known limitations

- **Authentication model**: Commission Factory uses a single API key passed as
  the `apiKey` query parameter, not a bearer header. The adapter's `auth_model`
  is `custom`.
- **listClicks**: Commission Factory does not expose click-level data via the
  public Affiliate API. The operation throws `NotImplementedError`.
- **generateTrackingLink**: not a destination-only deterministic construction.
  The adapter reads the joined merchant's `TrackingUrl`
  (`https://t.cfjump.com/0/b/{id}`) via `GET /Affiliate/Merchants/{id}` and
  appends `?Url={encoded}`. It requires the merchant to be joined and reachable;
  for a merchant you have not joined it returns a network error.
- **Transaction pagination**: pagination parameters for `GET
  /Affiliate/Transactions` are not documented publicly. The adapter passes the
  full date window in a single call. A live account test is required to confirm
  there is no server-side cap on the returned set.
- **Status enum**: the adapter prefers the current `Status2` field
  (`TransactionStatus2`: Pending, Confirmed, Declined, Void, Paid) and reads the
  deprecated `Status` field only as a fallback.
- **Not verified against a live account**: this adapter was built from public
  Commission Factory API documentation. Some field names and endpoint shapes
  have not been confirmed against a live API response. The `claim_status` is
  `experimental` until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test commission-factory
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- commission-factory`. On a successful run you should
see:

- `verifyAuth` → `ok: true` with a redacted key fingerprint as the identity.
- `listProgrammes` → may return 0 records if you have joined no merchants.
- `listTransactions` → may return 0 records if your date window is empty.
- `listClicks` → `supported: false` with the known-limitation note.
- `generateTrackingLink` → `supported: true` (recorded without a live probe; it
  needs a concrete merchant Id).
