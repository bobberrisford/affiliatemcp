# Awin Live Testing Plan

Date: 2026-05-22

## Goal

Validate the Awin adapter against a real publisher account, then decide whether
the adapter can be promoted from `claim_status: partial` or needs code changes
for current Awin API behavior.

## Local Setup

Use the workspace-local config directory so credentials stay out of git and do
not depend on a global machine setup:

```sh
export AFFILIATE_MCP_CONFIG_DIR=/Users/othmanb/Desktop/affiliate/affiliatemcp/.affiliate-mcp
```

The local `.affiliate-mcp/.env` file is git-ignored and should contain:

```sh
AWIN_API_TOKEN=<redacted>
AWIN_PUBLISHER_ID=<numeric publisher id once known>
```

Do not commit this file. Product Feed and Proof of Purchase credentials are
not required for the current Awin PR because those surfaces intentionally
return actionable stubs.

## Current Finding

The Awin token supplied for testing does not behave like a generic invalid
token:

- `GET https://api.awin.com/publishers` without auth returns `401`.
- The same endpoint with a known fake UUID bearer token returns `401 invalid_token`.
- The same endpoint with the supplied token returns `404` with:

```json
{"error":"exception","description":"Not Found (404 NOT_FOUND)"}
```

The current publisher account discovery endpoint is `GET /accounts?type=publisher`.
That endpoint succeeds with the supplied token and returns publisher account
`2272397` (`Revenue Stack`). The adapter should use `/accounts?type=publisher`
for `verifyAuth` and `AWIN_PUBLISHER_ID` derivation.

Expanded read-only validation on 2026-05-22 also confirmed programmes,
programme details, commission groups, advertiser performance, empty creative
and campaign reports, empty recent transactions, Link Builder quota, and gated
stubs. Offers reached the documented singular endpoint
`POST /publisher/2272397/promotions` but Awin returned HTTP 500 for the
supplied account; the plural path returned 404, so the endpoint shape remains
documented with a live caveat in `docs/networks/awin/api-inventory.md`.

## Phase 1: Credential Classification

1. Confirm the credential source in the Awin UI.
   - Expected publisher bearer token source: `https://ui.awin.com/awin-api`.
   - A bearer token shown in Awin examples is JWT-like and usually begins with
     `eyJ...`.
   - A UUID-shaped key may belong to a different API surface, such as a
     feature-specific API key.

2. Get the numeric Awin publisher ID from the dashboard or `/accounts`.
   - The adapter requires `AWIN_PUBLISHER_ID` for programme, transaction, and
     link-generation calls.
   - If `/accounts?type=publisher` cannot derive it, set it manually.

3. Re-run direct auth checks.
   - `GET /accounts?type=publisher` with bearer auth.
   - `GET /publishers/{publisherId}/programmes?relationship=joined` with
     bearer auth.
   - `GET /publishers/{publisherId}/transactions/` with a narrow date window.

Acceptance criteria:

- The token can call at least one documented publisher read endpoint.
- We know whether `/accounts?type=publisher` can derive the publisher ID and
  whether the supplied credential can call publisher read endpoints.

## Phase 2: Existing Local Safety Checks

Run the mocked test suite before and after any adapter change:

```sh
npm test -- tests/networks/awin/adapter.test.ts
npm run typecheck
npm run lint
```

Acceptance criteria:

- Awin unit tests pass.
- TypeScript passes.
- Lint passes or produces only unrelated pre-existing issues.

## Phase 3: Minimal Live Awin Smoke Test

Once a usable token and publisher ID are configured:

```sh
AFFILIATE_MCP_CONFIG_DIR=/Users/othmanb/Desktop/affiliate/affiliatemcp/.affiliate-mcp npm run dev -- test awin
```

Expected result:

- `verifyAuth` succeeds or fails with a clearly documented endpoint-specific
  reason.
- `listProgrammes` succeeds with a small sample.
- `listTransactions` succeeds for a minimal/narrow date query.
- `getEarningsSummary` succeeds for the same narrow query.
- `listClicks` is reported as unsupported because Awin does not expose
  click-level data through the public publisher API.
- `generateTrackingLink` is marked supported without a live network call.

## Phase 4: Operation-Level Live Checks

After the smoke test, call each tool or adapter operation with explicit inputs:

1. `verifyAuth`
   - Confirms token validity and publisher identity.

2. `listProgrammes`
   - Test `limit: 1`.
   - Test joined programmes.
   - Test available programmes if the API supports the relationship filter for
     this account.

3. `getProgramme`
   - Use an advertiser ID returned by `listProgrammes`.

4. `listTransactions`
   - Test a recent 7-day range.
   - Test an empty range.
   - Test a range wider than 31 days to verify chunking.

5. `getEarningsSummary`
   - Compare totals against the same raw transactions fetched by
     `listTransactions`.

6. `generateTrackingLink`
   - Use the advertiser ID from a joined programme.
   - Confirm the generated URL includes the expected `awinmid`, `awinaffid`,
     and URL-encoded destination.

7. `listClicks`
   - Confirm it returns a `not_implemented` envelope, not an empty list.

## Phase 4b: Awin-Specific Public API Checks

The Awin reference implementation adds endpoint-specific tools beyond the
canonical seven operations. Exercise these read-only surfaces with fixture
tests first, then live calls where the account has relevant data:

1. `affiliate_awin_list_accounts`
   - Confirm `/accounts?type=publisher` returns the expected publisher account.

2. `affiliate_awin_get_programme_details`
   - Use an advertiser ID returned by `listProgrammes`.

3. `affiliate_awin_list_commission_groups`
   - Use the same joined advertiser ID.

4. `affiliate_awin_list_commission_sharing_rules`
   - Empty or forbidden responses can be acceptable for non-service-partner
     accounts; document the exact outcome.

5. `affiliate_awin_get_transactions_by_id`
   - Run only if `listTransactions` produced a sample transaction ID.

6. `affiliate_awin_list_transaction_queries`
   - Treat empty-but-200 as valid when there are no current enquiries.

7. `affiliate_awin_get_advertiser_performance`,
   `affiliate_awin_get_creative_performance`, and
   `affiliate_awin_get_campaign_performance`
   - Use a recent period, `region=GB` unless the account is tied to another
     region, and accept empty-but-200 as endpoint validation.

8. `affiliate_awin_list_offers`
   - Validate joined active offers first, then broader filters if useful.

9. `affiliate_awin_get_link_builder_quota`
   - Read-only; safe to run before link generation.

10. `affiliate_awin_generate_tracking_links`
    - Generate one non-shortened URL only when a joined advertiser ID is
      available. Do not run broad batch generation as a routine live test.

11. Product Feed and Proof of Purchase tools
    - Confirm they return actionable stubs.
    - Do not submit Proof of Purchase transactions.

## Phase 5: Regression And Documentation

If live testing uncovers API drift:

- Add or update mocked fixtures in `tests/fixtures/awin/`.
- Add regression tests in `tests/networks/awin/adapter.test.ts`.
- Patch only the Awin adapter/client/auth layer unless the behavior clearly
  applies to other networks.
- Update `docs/findings/awin.md`.
- Regenerate `REPORT.md` if claim status, limitations, or live findings change.

## Promotion Criteria

Promote Awin beyond `partial` only after:

- A real publisher account validates auth.
- At least `verifyAuth`, `listProgrammes`, `listTransactions`,
  `getEarningsSummary`, and `generateTrackingLink` are exercised live.
- Known unsupported behavior for `listClicks` is confirmed and documented.
- No credential values appear in logs, test output, docs, or git diff.
