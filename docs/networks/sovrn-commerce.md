# Sovrn Commerce

Sovrn Commerce (formerly VigLink) is a link-monetisation platform that automatically converts outbound links on a publisher's site into affiliate links. The platform handles merchant programme relationships centrally — publishers do not need to apply to individual merchant programmes.

**Status:** `experimental` — response field names confirmed from public documentation (developer.sovrn.com) but not yet verified against a live account. See `docs/findings/sovrn-commerce.md` for details.

---

## Prerequisites

- A Sovrn Commerce publisher account at [platform.sovrn.com](https://platform.sovrn.com/).
- At least one site registered in your Sovrn Commerce dashboard (Settings → Sites).
- A Secret key generated for your account (see below). Note: a Secret key is separate from the per-site API key.

Sovrn Commerce does not require individual merchant programme approvals for basic link monetisation — access is granted at the account level.

---

## Credentials needed

### SOVRN_SECRET_KEY

The Secret key authenticates all reporting API calls. It is account-wide (not per-site) and must be kept server-side — never embed it in page JavaScript.

**Where to find it:**
1. Log in at [platform.sovrn.com](https://platform.sovrn.com/).
2. Click **Settings** in the left navigation panel.
3. Locate your site in the sites table.
4. Click the **Key** icon (lock icon) in the Actions column for your site.
5. If a Secret key has not been generated yet, click **Generate Secret Key**.
6. Copy the Secret key value shown.

The same Secret key works for all sites in your account. Store it in `~/.affiliate-mcp/.env` as:

```
SOVRN_SECRET_KEY=your_secret_key_here
```

### SOVRN_API_KEY

The site API key is used when constructing affiliate tracking links via `redirect.viglink.com`. Each site has its own API key.

**Where to find it:**
1. Log in at [platform.sovrn.com](https://platform.sovrn.com/).
2. Click **Settings** in the left navigation panel.
3. Locate your site in the sites table.
4. Click the **Key** icon in the Actions column.
5. The API key is the shorter alphanumeric value shown (distinct from the Secret key).

Store it in `~/.affiliate-mcp/.env` as:

```
SOVRN_API_KEY=your_api_key_here
```

---

## Setup steps

Run the interactive setup wizard:

```
affiliate-networks-mcp setup sovrn-commerce
```

The wizard will prompt for `SOVRN_SECRET_KEY` first (and validate it live against the reporting API), then `SOVRN_API_KEY`.

Alternatively, set the env vars manually in `~/.affiliate-mcp/.env`:

```
SOVRN_SECRET_KEY=your_secret_key_here
SOVRN_API_KEY=your_api_key_here
```

---

## Common failures

### `HTTP 401` on any reporting call
The Secret key is missing, invalid, or copied with leading/trailing whitespace. Return to Settings → Key icon → check that the Secret key shown matches `SOVRN_SECRET_KEY` in your config.

### `HTTP 403` on any reporting call
A Secret key has not yet been generated for your account. Click "Generate Secret Key" in the dashboard (Settings → Key icon → Generate Secret Key).

### Tracking link does not track
The `SOVRN_API_KEY` may be from the wrong site, or may have leading/trailing whitespace. The `key=` parameter in `redirect.viglink.com` URLs must match the site API key exactly.

### `listProgrammes` returns an empty list
The reporting API returns only merchants you have sent traffic to in the queried date window (default: last 7 days). If you have not sent traffic recently, the list will be empty. No error is raised — this is expected behaviour from Sovrn Commerce's API design.

### Wide date windows are slow
The transactions endpoint accepts one day per API call and has a rate limit of 1 request per 60 seconds. A 30-day window makes 30 sequential requests and may take up to 30 minutes. Use `from` and `to` parameters to scope queries to the narrowest window that meets your needs.

---

## Known limitations

- Adapter built from public API documentation; response field names confirmed from developer.sovrn.com but not yet verified against a live account.
- The `/v1/reports/transactions` endpoint accepts one `clickDate` per call (rate limit: **1 request per 60 seconds**); wide date windows require many sequential calls.
- The `/v1/reports/merchants` endpoint also accepts one `clickDate` per call (rate limit: 1 request per 10 seconds).
- Click-level data is not exposed as a distinct click-stream API; `listClicks` is unsupported.
- Merchant (programme) listing uses `/v1/reports/merchants`, which returns aggregated data for merchants with activity on the given date — not a full catalogue. All returned merchants have status `joined`.
- `getProgramme` is derived from `/v1/reports/merchants` filtered client-side; no single-merchant lookup endpoint exists in the public API.
- Sovrn Commerce `/v1/reports/transactions` does not include a status field; all transactions are mapped to canonical status `'other'`.
- No currency field is present in the transactions or merchants response; currency defaults to `'USD'`.

---

## Verifying the integration

```
affiliate-networks-mcp test sovrn-commerce
```

This runs `capabilitiesCheck`, which probes each supported operation with a minimal query. Expected output:

```
listProgrammes      OK   (n=...)
listTransactions    OK   (n=...)
getEarningsSummary  OK
verifyAuth          OK
listClicks          FAIL (expected: Sovrn Commerce does not expose individual click events)
generateTrackingLink OK  (deterministic; no live probe)
getProgramme        OK  (requires a known merchant id)
```

---

## API reference

- Developer centre: [developer.sovrn.com](https://developer.sovrn.com/)
- Implementation guide: [knowledge.sovrn.com](https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis)
- Legacy VigLink developer guide: [support.viglink.com](https://support.viglink.com/hc/en-us/articles/216688298-VigLink-Developer-Guide)
