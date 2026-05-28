# Tradedoubler advertiser adapter — findings

Built from public docs as of 2026-05-28; live verification pending credentials.

## Research method

This adapter was built by examining:

1. The official Tradedoubler developer portal at
   [https://dev.tradedoubler.com/](https://dev.tradedoubler.com/).
2. The Tradedoubler public API documentation repository at
   [https://github.com/tradedoubler/publicapi-docs](https://github.com/tradedoubler/publicapi-docs)
   (API Blueprint format, links to Apiary — apiary.io returned 403 to
   automated fetch during this research).
3. Community PHP wrapper at
   [https://github.com/jongotlin/TradedoublerReportsWrapper](https://github.com/jongotlin/TradedoublerReportsWrapper)
   — this is the primary source for the XML column names used in this
   adapter.
4. Community PHP API integration at
   [https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php](https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php)
   — corroborated the `key` (token) query-parameter auth scheme and the
   `pendingStatus` values (A = Approved, P = Pending, D = Declined).
5. XML mock data at
   [https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml](https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml)
   — used to infer programme response column names.

## Auth model

Tradedoubler's legacy reporting API authenticates via a `token=<value>`
query parameter (not a `Bearer` header). The token is a 40-character
hexadecimal SHA-1 string obtained from Account → Manage tokens, selecting
the **REPORTS** system.

A failed auth does **not** return a 4xx HTTP status. Instead, Tradedoubler
returns HTTP 200 with an HTML login page. The adapter detects this by
checking whether the response body begins with `<!doctype html` or `<html`.

## Report API endpoint

The reports endpoint is:

```
GET https://reports.tradedoubler.com/pan/aReport3Key.action
  ?token={TOKEN}
  &reportName={REPORT_NAME}
  &format=XML
  &columns={COMMA_SEPARATED_COLUMN_IDS}
  &organizationId={ORG_ID}
  [&startDate=DD.MM.YYYY&endDate=DD.MM.YYYY]
  [&programId={PROGRAM_ID}]
```

## Report names used

- `aAffiliateMyProgramsReport` — programme (brand) list for the account.
  Source: `TradedoublerReportsWrapper/Tradedoubler.php::getPrograms()`.
- `aAffiliateEventBreakdownReport` — conversion event breakdown by
  publisher. Source: same wrapper, `getTransactions()` method.

## Column names (TODO(verify))

**aAffiliateMyProgramsReport:**
- `programId` — Tradedoubler programme identifier
- `programName` — programme name (may also appear as `siteName`)
- `status` — A (active), P (pending), D (declined), S (suspended)
- `programTariffPercentage` — commission percentage
- `programTariffAmount` — flat commission amount
- `programTariffCurrency` — currency code

Source: XML mock at `denodell/tradedoubler/test/mock-data/advertisers.xml`
and `TradedoublerReportsWrapper`.

**aAffiliateEventBreakdownReport:**
- `timeOfEvent` — event date (format `d.m.Y` e.g. `01.05.2026`)
- `siteId` — publisher site ID
- `siteName` — publisher site name
- `pendingStatus` — A (approved), P (pending), D (declined)
- `orderValue` — gross order value
- `affiliateCommission` — commission paid to publisher
- `programId` — programme ID
- `eventName` — event type name (e.g. Sale, Lead)
- `currencyId` — currency code

Source: `TradedoublerReportsWrapper/Tradedoubler.php::getTransactions()`.

## Date format

Tradedoubler uses `d.m.Y` format for dates in API request parameters
(e.g. `01.05.2026`). Responses also use this format in the `timeOfEvent`
column. The adapter converts ISO dates from callers to this format and
parses API dates back to ISO.

Source: `TradedoublerReportsWrapper/Tradedoubler.php` — uses `Y-m-d` in
`strtotime` but the URL shows `format=XML` and the date params appear in
community wrappers as `d.m.y`.

## XML response format

Tradedoubler wraps report data in an XML matrix structure:

```xml
<report>
  <matrix>
    <columnDefs>
      <columnDef id="programId" label="Programme ID" dataType="INTEGER" />
      ...
    </columnDefs>
    <rows>
      <row>
        <col>12345</col>
        ...
      </row>
    </rows>
  </matrix>
</report>
```

Column values in `<col>` elements match the order of `<columnDef>`
elements in `<columnDefs>`. The adapter parses this via regex (not a full
XML parser, to avoid adding a dependency).

Source: inferred from `TradedoublerReportsWrapper` response parsing and
the `advertiserxml` fixture in community tools.

## Known gaps requiring live verification

1. **Exact column names** for `aAffiliateMyProgramsReport` — may use
   `siteName` instead of `programName` in some contexts.
2. **Exact status values** — confirmed A/P/D from community code but S
   (suspended) is inferred.
3. **Date format** — `d.m.Y` inferred; could be `d.m.y` (two-digit year)
   in some contexts. The adapter handles both.
4. **XML root element** — may be `<report>` or a different wrapper in some
   account configurations.
5. **Organization ID scope** — whether `organizationId` is required or
   optional for the programme report.
6. **Authentication failure code** — confirmed HTML-on-200 from community
   wrapper error detection, but the exact HTML content may vary.
7. **Newer management API** — the `connect.tradedoubler.com` REST
   management API (documented at `advertiserwip.docs.apiary.io`) is not
   used by this adapter because Apiary returned 403 during research.
   A future PR should switch to that surface if it provides richer JSON
   responses and a dedicated publishers endpoint.
