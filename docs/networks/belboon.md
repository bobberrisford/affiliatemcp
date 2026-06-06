# Belboon adapter

Belboon runs on the Ingenious Technologies platform. The publisher API is the
"export file" interface: each request authenticates with two values baked into
the URL and returns a CSV (also XLS/XML) file, not a JSON REST response. This
adapter requests the CSV variant and parses it into rows.

Claim status: experimental. The adapter is implemented from public API
documentation and has not yet been validated against a live account. The export
URL shape is verified from public sources, but the exact export column names are
dashboard-gated and unverified; the transformers read several candidate column
names defensively and preserve the raw CSV row on `rawNetworkData`.

## Prerequisites

- A Belboon publisher (partner) account.
- Export/API access enabled on the account. There is no separate approval step
  for export access on an active publisher account.

## Credentials needed

- `BELBOON_MAGIC_KEY` (required) — your Belboon API "Magic Key", a UUID. It is
  the first path segment of every export URL. Find it in the dashboard under
  Settings → API (some accounts show it under Tools → Webservices).
- `BELBOON_USER_ID` (required) — your numeric partner/user id. It is baked into
  every export file name (`adm-conversionexport_123.csv` → `123`). Find it in
  the dashboard under Account, or read it from the numeric segment of an export
  download link.
- `BELBOON_EXPORT_HOST` (optional) — overrides the per-tenant export host. Set
  it only if your export download links use a host other than the default
  `export.net.belboon.com`. Not a secret.

There is no refresh flow: both required values are long-lived secrets read from
the dashboard. If the Magic Key is compromised, rotate it from the same screen
and update `BELBOON_MAGIC_KEY`.

## Setup steps

1. Sign in at https://www.belboon.com/.
2. Open Settings → API and copy the Magic Key into `BELBOON_MAGIC_KEY`.
3. Open Account and copy your numeric partner id into `BELBOON_USER_ID` (or read
   it from the numeric segment of an export download link).
4. Leave `BELBOON_EXPORT_HOST` blank unless your export links use a different
   host.

## Common failures

1. **Bad or rotated Magic Key** — the export request returns a 4xx. The adapter
   surfaces it as an `auth_error` envelope carrying the verbatim response body.
   Confirm the key under Settings → API; it may have been rotated.
2. **User id does not match the account that owns the key** — the export request
   fails even though the key looks valid. Confirm the numeric id under Account
   belongs to the same account as the Magic Key.
3. **Non-default export host** — download links served from another Ingenious
   subdomain cause requests against the default host to fail. Set
   `BELBOON_EXPORT_HOST` to the host shown in your own export download links.

## Known limitations

- The adapter is built from public API documentation and is not yet verified
  against a live account.
- Belboon exposes only aggregated daily stats, not click-level events, via the
  publisher export API. `listClicks` is unsupported and throws.
- Monetary amounts are assumed to be major currency units (for example euros),
  as the export interface does not document a minor-unit encoding. Verify
  against a live account.
- The export API serves CSV/XLS/XML (no JSON), and the exact export column names
  are dashboard-gated and unverified. The transformers read candidate column
  names defensively and preserve the raw row on `rawNetworkData`.
- `getProgramme` selects from the merchant export by id (no per-programme
  endpoint exists). `generateTrackingLink` builds the deep-link deterministically
  from the documented URL shape; the host and exact path are unverified against a
  live account.

## Verifying

```
affiliate-networks-mcp test belboon
```

The CLI runs the live diagnostic — the same engine as
`npm run validate:network -- belboon`. The diagnostic engine's pass is the
verification contract.
