# Tradedoubler advertiser adapter — findings

Built from public docs as of 2026-05-28; live verification pending credentials.

## Research method

This adapter was built by examining:

1. The official Tradedoubler developer portal at
   [https://dev.tradedoubler.com/](https://dev.tradedoubler.com/).
2. The Tradedoubler public API documentation repository at
   [https://github.com/tradedoubler/publicapi-docs](https://github.com/tradedoubler/publicapi-docs)
   (API Blueprint format, links to Apiary — apiary.io returned 403 to
   automated fetch during research).
3. Community PHP wrapper at
   [https://github.com/jongotlin/TradedoublerReportsWrapper](https://github.com/jongotlin/TradedoublerReportsWrapper)
   — **primary source** for column names, URL templates, date format, and
   XML parsing approach. Denormalizer.php uses SimpleXML property access
   (`$row->programId`, `$row->siteName` etc.) confirming named-element format.
4. Community PHP API integration at
   [https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php](https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php)
   — corroborated the `key=` query-parameter auth scheme, `pendingStatus`
   values (A/P/D), and added "Access Denied" auth-failure detection.
5. XML mock data at
   [https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml](https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml)
   — confirmed XML format: `<columns>` section with named elements as column
   descriptors; `<row>` children are named elements (not positional `<col>`).

---

## Hardening pass 2026-05-28

### TODO items resolved

| Item | Outcome | Source |
|------|---------|--------|
| Auth parameter name (`token` vs `key`) | **CORRECTED** — legacy reports API uses `key=`, not `token=`. Modern REST APIs (conversions, claims) use `token=`, but `aReport3Key.action` uses `key=`. | jongotlin/TradedoublerReportsWrapper Tradedoubler.php (`key=%s` in URL template) |
| XML response structure (`<columnDefs>/<col>` vs named elements) | **CORRECTED** — Real format uses `<columns>` section with named column descriptors; `<row>` children are named elements (`<programId>12345</programId>`), not positional `<col>`. Rewritten `parseXmlMatrix` and updated fixtures. | denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php (SimpleXML property access) |
| Column-list URL format (comma-separated vs repeated params) | **CORRECTED** — API uses `&columns=x&columns=y&columns=z` (repeated). `buildTokenUrl` now expands comma-separated strings into repeated params. | jongotlin Tradedoubler.php URL template |
| Date format for API requests | **CONFIRMED+CORRECTED** — jongotlin uses `Y-m-d` (YYYY-MM-DD). Changed `toTdDateStr` from `dd.mm.YYYY` to `YYYY-MM-DD`. | jongotlin Tradedoubler.php (`$from->format('Y-m-d')`) |
| Date format in API responses (`timeOfEvent`) | **CONFIRMED** — `d.m.Y` (e.g. `01.05.2026`). The adapter's `parseTdDate` already handles this plus `d.m.y` 2-digit fallback. | denodell/tradedoubler advertisers.xml sample data |
| `aAffiliateMyProgramsReport` column names | **CONFIRMED** — `programId`, `programName`, `status`, `programTariffPercentage`, `programTariffAmount`, `programTariffCurrency`. Also confirmed `siteName` is a publisher column, not a programme column. | denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php |
| `aAffiliateEventBreakdownReport` column names | **CONFIRMED** — `programId`, `timeOfEvent`, `siteId`, `siteName`, `pendingStatus`, `orderValue`, `affiliateCommission`, `eventName`, `currencyId`. The full column list also includes: `timeOfVisit`, `timeInSession`, `lastModified`, `epi1`, `epi2`, `graphicalElementName`, `productName`, `productNrOf`, `productValue`, `voucher_code`, `deviceType`, `leadNR`, `orderNR`, `pendingReason`. | jongotlin Tradedoubler.php column list |
| `pendingStatus` values (A/P/D) | **CONFIRMED** — A = approved/confirmed, P = pending/open, D = declined/cancelled. | wp-plugins/affiliate-power tradedoubler.php |
| Programme status values (A/P/D/S) | **CONFIRMED** A/P/D from community; S (suspended) from denodell XML mock but not in affiliate-power. Kept as handled. | denodell/tradedoubler advertisers.xml; affiliate-power tradedoubler.php |
| HTML auth-failure detection | **CONFIRMED+IMPROVED** — login page HTML detection confirmed. Also added `"Access Denied"` string check, which affiliate-power uses as its auth-failure detector for CSV responses. | wp-plugins/affiliate-power tradedoubler.php (`strpos($str_report, 'Access Denied')`) |
| Click columns in event breakdown report | **CONFIRMED ABSENT** — The `aAffiliateEventBreakdownReport` is conversion-level only. No click column exists. `listClicks` correctly throws `NotImplementedError`. | jongotlin Tradedoubler.php column list (no click field) |
| `apiEnabled` flag on `DiscoveredBrand` | **CONFIRMED ABSENT** — No API-enabled column exists in `aAffiliateMyProgramsReport`. All returned programmes are assumed API-accessible. Hard-coded `true` is correct. | jongotlin getPrograms column list |
| `organizationId` requirement | **CONFIRMED REQUIRED** — `organizationId` is required for `aAffiliateEventBreakdownReport` (jongotlin uses `organizationId=%s`). For `aAffiliateMyProgramsReport` jongotlin does not pass it explicitly, but affiliate-power uses `affiliateId=` instead. The adapter passes it for both. | jongotlin Tradedoubler.php; wp-plugins/affiliate-power tradedoubler.php |
| XML root element nesting | **CONFIRMED** — Root is `<report name="..." time="...">`, containing `<matrix rowcount="N">`, containing `<columns>` and `<rows>`. For `aAffiliateMyProgramsReport` the data is in the second matrix (`matrix[1]` in SimpleXML indexing). | denodell/tradedoubler advertisers.xml |

### Operations: implement / keep stubbed review

| Operation | Decision | Reason |
|-----------|----------|--------|
| `listTransactions` | **KEEP BLOCKED** | No dedicated transaction-listing report exists in the public API surface. The event breakdown (`aAffiliateEventBreakdownReport`) provides conversion data but it is already surfaced via `getProgrammePerformance`. Mapping the same report to `Transaction[]` would duplicate that surface. Blocked pending: access to `connect.tradedoubler.com` management REST API (see below). |
| `getEarningsSummary` | **KEEP BLOCKED** | No aggregate earnings report with a summary envelope exists in the legacy reports API. Would require the management REST API. |
| `listClicks` | **KEEP BLOCKED** | No click-level data is available in `aAffiliateEventBreakdownReport`. A separate clicks report may exist but is not documented in any community source examined. |
| `getProgramme` (single) | **KEEP BLOCKED** | The `aAffiliateMyProgramsReport` always returns all programmes. Per-programme lookup is correctly directed to `listProgrammes` with client-side filter. |
| `generateTrackingLink` | **KEEP BLOCKED** | Publisher-side operation only; not available on the advertiser surface. |

---

## Auth model

Tradedoubler's legacy reporting API authenticates via a **`key=<value>`**
query parameter (not `Bearer` header and not `token=`). The token is a
40-character hexadecimal SHA-1 string obtained from Account → Manage tokens,
selecting the **REPORTS** system.

A failed auth does **not** return a 4xx HTTP status. Tradedoubler returns
HTTP 200 with either an HTML login page or an "Access Denied" body. The
adapter detects both:
- Response body starts with `<!doctype html` or `<html` → HTML login page
- Response body contains `"Access Denied"` → access denied response

Sources:
- jongotlin/TradedoublerReportsWrapper (uses `key=%s` in URL)
- wp-plugins/affiliate-power (uses `key=`, checks `strpos($str_report, 'Access Denied')`)

Note: modern Tradedoubler REST APIs (Conversions API, Claims API at
`dev.tradedoubler.com`) use `token=`. The legacy reports endpoint
(`aReport3Key.action`) uses `key=`. These are distinct auth surfaces.

---

## Report API endpoint

```
GET http://reports.tradedoubler.com/pan/aReport3Key.action
  ?reportName={REPORT_NAME}
  &columns={COL1}&columns={COL2}...   ← repeated, not comma-separated
  &format=XML
  &key={TOKEN}
  &organizationId={ORG_ID}
  [&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD]
  [&programId={PROGRAM_ID}]
  [&event_id=0&pending_status=1]
```

The adapter uses HTTPS (`reports.tradedoubler.com`). The community wrappers
use HTTP, but HTTPS works on the same host.

---

## Column names (confirmed)

**aAffiliateMyProgramsReport:**
- `programId` — programme identifier (integer)
- `programName` — programme name (string)
- `status` — A (active/joined), P (pending), D (declined), S (suspended)
- `programTariffPercentage` — commission rate percentage
- `programTariffAmount` — flat commission amount
- `programTariffCurrency` — currency code

Also present but not requested by this adapter:
- `affiliateId` — publisher identifier
- `applicationDate` — application date

Source: jongotlin getPrograms URL + denodell advertisers.xml

**aAffiliateEventBreakdownReport:**
- `timeOfEvent` — event date (d.m.Y format in responses)
- `siteId` — publisher site identifier
- `siteName` — publisher site name
- `pendingStatus` — A (approved), P (pending), D (declined/cancelled)
- `orderValue` — gross order value
- `affiliateCommission` — commission to publisher
- `programId` — programme identifier
- `eventName` — event type ("Sale", "Lead", etc.)
- `currencyId` — currency code

Additional columns available (not requested):
- `timeOfVisit`, `timeInSession`, `lastModified`
- `epi1`, `epi2` — extra parameters
- `graphicalElementName`, `productName`, `productNrOf`, `productValue`
- `open_product_feeds_id`, `open_product_feeds_name`, `voucher_code`
- `deviceType`, `os`, `browser`, `vendor`, `device`
- `leadNR`, `orderNR`, `pendingReason`
- `link`

Source: jongotlin Tradedoubler.php getTransactions column list

---

## XML response format (confirmed)

```xml
<report name="aAffiliateMyProgramsReport" time="2026-05-28 12:00">
  <matrix rowcount="N">
    <columns>
      <programId type="integer">Programme ID</programId>
      <programName type="string">Programme Name</programName>
      ...
    </columns>
    <rows>
      <row>
        <programId>12345</programId>
        <programName>Acme UK</programName>
        ...
      </row>
    </rows>
  </matrix>
</report>
```

Key points:
- Column-definitions section is `<columns>`, NOT `<columnDefs>`
- Row cells are **named elements** (e.g. `<programId>12345</programId>`),
  NOT positional `<col>` elements
- For `aAffiliateMyProgramsReport`, data is in the second matrix (`matrix[1]`)
  in some account configurations (the first matrix may be an empty summary)

Source: denodell/tradedoubler advertisers.xml; jongotlin Denormalizer.php

---

## Date format

- **Request parameters** (`startDate`, `endDate`): `YYYY-MM-DD`
  (e.g. `2026-05-01`). Confirmed from jongotlin `$from->format('Y-m-d')`.
- **Response data** (`timeOfEvent` etc.): `d.m.Y` (e.g. `01.05.2026`).
  Confirmed from denodell advertisers.xml sample data.

The adapter's `toTdDateStr` uses YYYY-MM-DD for requests; `parseTdDate`
handles both d.m.Y and d.m.y (two-digit year) in responses.

---

## Remaining gaps requiring live verification

1. **organizationId for aAffiliateMyProgramsReport** — jongotlin does not
   include `organizationId` for the programmes report. The adapter passes it
   regardless, which should be harmless but could cause errors on some account
   configurations. Requires a live account to verify.
   Credential needed: `TRADEDOUBLER_ADV_ORGANIZATION_ID` + `TRADEDOUBLER_ADV_TOKEN`.

2. **matrix[1] vs matrix[0]** — the denodell XML has two `<matrix>` elements;
   jongotlin Denormalizer uses `$xml->matrix[1]->rows->row` for programmes.
   The adapter's regex-based parser extracts all `<row>` elements globally,
   which may return rows from both matrices. Live verification needed.
   Credential needed: any live account.

3. **Exact "Access Denied" string** — affiliate-power checks for `"Access Denied"`.
   Variations like `"access denied"` or `"Access denied"` may occur.
   The adapter's `isHtmlResponse` does a case-sensitive check.
   Credential needed: deliberately invalid token on a live account.

4. **Management REST API** (`connect.tradedoubler.com`) — documented at
   `advertiserwip.docs.apiary.io` but returned 403 during automated research.
   This surface may enable `listTransactions`, `getEarningsSummary`, and richer
   programme metadata. Unblocking requires manual review of the Apiary docs
   with a live Tradedoubler advertiser account.
   Credential needed: live account with management API access.

5. **S (suspended) programme status** — present in the denodell mock data XML
   but absent from affiliate-power's status mapping. May not occur in all
   account types.
   Credential needed: any live account with a suspended programme.
