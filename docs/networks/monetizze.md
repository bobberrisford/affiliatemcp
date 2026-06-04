# Setting up affiliate-mcp with Monetizze (estimated 5 minutes)

This guide walks you through the credential affiliate-mcp needs to read your
Monetizze account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `MONETIZZE_API_KEY`.

No prior API experience is assumed. Monetizze uses a single API access key
(a "chave de acesso"). The adapter exchanges that key for a short-lived token
behind the scenes; you only ever supply the key.

This adapter was built from public Monetizze API documentation and has not yet
been verified against a live account. The `claim_status` is `experimental`.

## Prerequisites

- An active Monetizze account. Sign in at
  [https://app.monetizze.com.br/](https://app.monetizze.com.br/).
- The ability to create an API access key in the panel (see the steps below).
  No separate approval step is required.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  steps below are complete.

**Note:** The Monetizze API used here is a sale and commission reporting API.
Product/programme listing (`listProgrammes`, `getProgramme`), click data
(`listClicks`), and tracking-link generation (`generateTrackingLink`) are not
available through the confirmed public API, so those operations report
`NotImplementedError`. You can still use `listTransactions`,
`getEarningsSummary`, and `verifyAuth`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|------------------|
| `MONETIZZE_API_KEY` | Monetizze API access key (chave de acesso) | Monetizze panel: **Menu > Ferramentas > API** |

## Setup steps

1. Sign in to the Monetizze panel at
   [https://app.monetizze.com.br/](https://app.monetizze.com.br/).

2. Open the **Menu** in the top navigation.

3. Go to **Ferramentas** (Tools).

4. Select **API**.

5. Create a new access key and copy the value shown. Keep it private: it grants
   read access to your account data.

6. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Monetizze** when prompted. The wizard will ask for:

   - **MONETIZZE_API_KEY** — paste the value from step 5. The wizard validates
     the key live against the Monetizze token endpoint immediately after you
     enter it.

You can also set the credential manually in `~/.affiliate-mcp/.env`:

```
MONETIZZE_API_KEY=your-access-key-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `auth_error: HTTP 403` with body `Credenciais de API não fornecidas` | Missing or wrong access key | Recreate the key at Menu > Ferramentas > API and re-copy it. Watch for trailing spaces or line breaks when pasting. |
| `config_error: Missing required credential MONETIZZE_API_KEY` | Key not set | Add `MONETIZZE_API_KEY=<your key>` to `~/.affiliate-mcp/.env`, or run the setup wizard. |
| `not_implemented: Monetizze product/programme listing is not implemented` | `listProgrammes` / `getProgramme` called | No public product-listing endpoint could be confirmed. Use `listTransactions` to see sales (each sale names its product). |
| `not_implemented: Monetizze does not expose click-level data` | `listClicks` called | The Monetizze API does not expose clicks. |
| `network_api_error: non-JSON body` | Monetizze returned an HTML error page | Wait a few minutes and retry; check the Monetizze status channels for outages. |
| `vendas` array is empty | Date range has no data | Try a wider date window via `from` / `to`. |

## Known limitations

- **listProgrammes / getProgramme**: No public product-listing endpoint path or
  response shape could be confirmed (the interactive apidoc at
  `https://api.monetizze.com.br/2.1/apidoc/` is JavaScript-rendered and refused
  automated fetches). Both operations throw `NotImplementedError` rather than
  calling an unconfirmed endpoint.
- **listClicks**: The Monetizze API does not expose click-level data. The
  operation throws `NotImplementedError`.
- **generateTrackingLink**: Monetizze affiliate links are generated inside the
  panel (per product, after affiliation is approved). There is no documented,
  deterministic public endpoint to construct them, so the operation throws
  `NotImplementedError`.
- **listTransactions filters**: The advanced-filter query parameter names (date
  window, status) could not be confirmed against the live interactive docs. The
  adapter sends `dataInicio` / `dataFim` and also filters client-side as a
  safeguard, so results are correct even if the server ignores the parameters.
- **Authentication**: Uses a two-step token exchange (the `x_consumer_key`
  header obtains a token, then the `token` header authenticates data calls). The
  token-response field name and token lifetime are unconfirmed, so the adapter
  reads the token field defensively and uses a conservative in-memory cache.
- **Not verified against a live account**: This adapter was built from public
  Monetizze API documentation. Some field names and endpoint shapes have not
  been confirmed against a live API response. The `claim_status` is
  `experimental` until a live account test is completed.

## Verifying

```
affiliate-networks-mcp test monetizze
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- monetizze`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your account identity.
- `listTransactions` → may return 0 records if your date window is empty.
- `listProgrammes`, `getProgramme`, `listClicks`, `generateTrackingLink` →
  `supported: false` with the known-limitation note.
