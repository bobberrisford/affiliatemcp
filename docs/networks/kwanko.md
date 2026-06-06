# Setting up affiliate-mcp with Kwanko (estimated 10 minutes)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Akwanko%22)

This guide walks you through the credential affiliate-mcp needs to read your
Kwanko publisher account. You will end up with one value written to
`~/.affiliate-mcp/.env`: `KWANKO_API_TOKEN`.

No prior API experience is assumed. Kwanko uses a single API token sent as a
bearer token; there is no separate client ID or secret and no token-exchange
step.

## Prerequisites

- An active Kwanko publisher account. Sign in to the platform at
  [https://platform.kwanko.com/](https://platform.kwanko.com/).
- API access does not require a separate approval step. The token is generated
  by you, in the platform, with no need to contact Kwanko.
- A terminal in which you can run `npx affiliate-networks-mcp setup` once the
  step below is complete.

**Note:** Kwanko's publisher API does not expose click-level data or a
link-generation endpoint, so `listClicks` and `generateTrackingLink` are not
available through the adapter. You can still use `listProgrammes`,
`getProgramme`, `listTransactions`, `getEarningsSummary`, and `verifyAuth`.

## Credentials needed

| Variable | Description | Where to find it |
|----------|-------------|-----------------|
| `KWANKO_API_TOKEN` | Your Kwanko Web Service API token (sent as a bearer token) | Kwanko platform → main menu → Features and API |

## Setup steps

1. Sign in to the Kwanko platform at
   [https://platform.kwanko.com/](https://platform.kwanko.com/).

2. Open the main menu and click **Features and API**.

3. Generate an API token (or copy the existing one). The token is the only
   credential the adapter needs.

4. Optionally, restrict the token by IP in the platform settings. If you do,
   make sure the host running affiliate-mcp is on the allowed list, or
   authenticated calls will fail.

5. In your terminal, run:

   ```
   npx affiliate-networks-mcp setup
   ```

   Select **Kwanko** when prompted. The wizard will ask for:

   - **KWANKO_API_TOKEN** — paste the token from step 3. The wizard validates
     it live against the Kwanko API immediately after you enter it.

You can also set the credential manually in `~/.affiliate-mcp/.env`:

```
KWANKO_API_TOKEN=your-api-token-here
```

## Common failures

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `auth_error: HTTP 401` or `HTTP 403` | Wrong, revoked, or IP-restricted token | Re-copy the token from Features and API. Watch for trailing spaces. If the token is IP-restricted, confirm this host is allowed. |
| `config_error: Missing required credential KWANKO_API_TOKEN` | Token not set | Add `KWANKO_API_TOKEN=<your token>` to `~/.affiliate-mcp/.env`. |
| `not_implemented: Kwanko does not expose click-level data` | `listClicks` called | Kwanko reports clicks only as an aggregate in the statistics endpoint; there is no per-click row API. |
| `not_implemented: Kwanko tracking links are issued per campaign and per site` | `generateTrackingLink` called | Generate the tracked link in the Kwanko platform; it cannot be built from the API token alone. |
| `network_api_error: non-JSON body` | Kwanko returned an HTML error page | Wait a few minutes and retry. |
| conversions list is empty | Date range has no data | Try a wider date window. The adapter defaults to the last 30 days when no window is given. |

## Known limitations

- **Not verified against a live account**: This adapter was built from public
  Kwanko API documentation. The exact endpoint paths, query-parameter names,
  and JSON field names have not been confirmed against a live API response, so
  field mapping is defensive. The `claim_status` is `experimental` until a live
  account test is completed.
- **listClicks**: Kwanko does not expose click-level data via the publisher
  API; clicks are only available as an aggregate in the statistics endpoint.
  The operation throws `NotImplementedError`.
- **generateTrackingLink**: Kwanko tracking links are issued per campaign and
  per site from the dashboard and cannot be constructed deterministically from
  the API token alone. The operation throws `NotImplementedError`.
- **IP-restricted tokens**: The token may optionally be IP-restricted in the
  platform settings. A token that works from one host can fail from another.

## Verifying

```
affiliate-networks-mcp test kwanko
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- kwanko`. On a successful run you should see:

- `verifyAuth` → `ok: true` with your token identity.
- `listProgrammes` → your campaigns (programmes).
- `listTransactions` → may return 0 records if your date window is empty.
- `listClicks`, `generateTrackingLink` → `supported: false` with the
  known-limitation note.
