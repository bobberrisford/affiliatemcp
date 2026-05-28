# Findings: Everflow (Publisher / Affiliate side)

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Summary

Everflow maps onto the canonical adapter contract for all seven publisher operations. Unlike Awin and CJ, Everflow **does** expose click-level data via the affiliate API (click stream endpoint), so `listClicks` is implemented rather than throwing `NotImplementedError`.

The adapter ships at `claim_status: experimental` — all ops are implemented and unit-tested against fixture data, but the adapter has not been exercised against a live publisher account. Endpoint shapes marked `// TODO(verify)` should be confirmed when live credentials are available.

## Key verification gap: affiliate API keys are admin-generated

Everflow affiliate API keys cannot be self-issued by the affiliate. They must be created by the **network admin** under Manage Affiliate → API tab. This was confirmed via the Everflow developer documentation and help centre:

> "Affiliate users cannot create keys themselves and must rely on a network user to create the key and hand it over."

This is a meaningful friction point: the setup wizard will stall until the user has obtained a key from their network admin. The `known_limitations` and `setupRequiresApproval: true` fields document this explicitly.

## Auth model

Everflow uses a custom header `X-Eflow-API-Key: <key>` rather than the standard `Authorization: Bearer ...` header. This is set in `buildHeaders()` in `client.ts` and declared as `auth_model: "custom"` in `network.json`.

The API key is scoped to a single affiliate account by the network admin. No derivation of a secondary credential (like Awin's publisher ID) is possible or needed — the key already identifies the account.

## Endpoint map (verified from public documentation)

| Endpoint | Method | Status |
|---|---|---|
| `/v1/affiliates/alloffers` | GET | Used for `listProgrammes` and `verifyAuth`. Confirmed via docs. |
| `/v1/affiliates/offers/{offerId}` | GET | Used for `getProgramme`. Confirmed via docs. |
| `/v1/affiliates/reporting/conversions` | POST | Used for `listTransactions`. Response fields confirmed. |
| `/v1/affiliates/reporting/clicks/stream` | POST | Used for `listClicks`. 14-day cap confirmed via docs. |
| `/v1/affiliates/offers/{offerId}/url/{urlId}` | GET | Used for `generateTrackingLink`. urlId=0 confirmed via docs. |

## Documentation URLs used

- Affiliate API overview: <https://developers.everflow.io/docs/affiliate/>
- Offers endpoint: <https://developers.everflow.io/docs/affiliate/offers/>
- Raw conversions report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/>
- Raw clicks report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_clicks/>
- Raw clicks stream: <https://developers.everflow.io/api-reference/post-affiliatesreportingclicksstream>
- Authentication: <https://developers.everflow.io/docs/user-guide/authentication/>
- API key management: <https://developers.everflow.io/docs/partner/api_keys/>
- Partner API keys helpdesk: <https://helpdesk.everflow.io/customer/partner-api-keys-api-documents>

## TODO(verify) fields requiring live validation

These fields carry `// TODO(verify)` annotations in the adapter and should be confirmed against a live Everflow account:

| Field | Location | Uncertainty |
|---|---|---|
| `currency_id` → ISO code | `toProgramme()` | Everflow exposes a numeric `currency_id`; mapping to ISO code requires a lookup not documented publicly. |
| `conversion_date` format | `computeAgeDays()` | Docs show `"YYYY-MM-DD HH:mm:SS"` but field exact name and format unconfirmed. |
| `relationship.status` values | `mapProgrammeStatus()` | The exact string values (approved, pending, declined, etc.) are inferred from docs and context. |
| `timezone_id: 67` | `listTransactions()`, `listClicks()` | Assumed to be UTC; Everflow's timezone ID table not publicly documented. |
| Response field `url` vs `tracking_url` | `generateTrackingLink()` | Docs suggest the field is `url`; a `tracking_url` fallback is also tried. |
| Offer-level filter structure | `listTransactions()`, `listClicks()` | The `query.filters` body structure is inferred from examples; exact field names may vary. |
| `dateApproved` field | `toTransaction()` | Everflow may not expose a separate approval date on conversions; currently set to `conversion_date` for approved conversions. |

## Click stream chunking

Everflow's `/v1/affiliates/reporting/clicks/stream` endpoint caps at 14 days per call. The adapter mirrors Awin's `chunkDateRange` helper to split wider windows into ≤14-day slices, making the cap transparent to callers.

## Status normalisation

### Offer / programme status (from `relationship.status` + `offer_status`)

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` / `active` / `joined` | `joined` | Affiliate approved for the offer. |
| `pending` / `under_review` | `pending` | Application awaiting approval. |
| `rejected` / `declined` | `declined` | Application rejected. |
| `paused` / `inactive` | `suspended` | Offer or relationship paused. |
| `public` / `require_approval` (no relationship) | `available` | Offer visible but not yet applied for. |
| anything else | `unknown` | Never invent a status. |

### Conversion / transaction status

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` | `approved` | Commission approved for payment. |
| `pending` | `pending` | Awaiting approval. |
| `rejected` / `reversed` / `declined` | `reversed` | Commission cancelled; `reversalReason` from `error_message`. |
| anything else | `other` | Future-proof default. |

## Future work

- **Live validation**: bump `claim_status` from `experimental` to `partial` after confirming endpoint shapes against a real affiliate account.
- **Currency mapping**: implement a `currency_id → ISO code` lookup table once the Everflow ID scheme is confirmed.
- **Multi-URL tracking links**: the adapter hardcodes `urlId=0` (the default URL). Future versions could expose a `urlId` parameter via `programmeId` encoding or a separate input field.
- **Pagination**: `listProgrammes` currently fetches only the first page. Cursor-based pagination support would allow fetching all offers for large catalogues.
- **Timezone configuration**: expose `timezone_id` as a configurable credential or query parameter, defaulting to UTC.
