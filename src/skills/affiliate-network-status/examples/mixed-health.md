# Example — mixed health across two networks

A publisher with Awin and CJ configured. CJ's token was rotated yesterday and not updated.

**User**: are all my networks responding?

**Assistant**: Running `affiliate_run_diagnostic`...

## Summary

| Network | Status | Auth | Ops failing unexpectedly | p95 latency |
| --- | --- | --- | --- | --- |
| Awin | OK | OK | none | 980 ms |
| CJ Affiliate | FAILING | FAIL | all (auth-blocked) | n/a |

## Recommendations

- **CJ Affiliate — FAILING.** `verifyAuth` returned `{ httpStatus: 401, networkErrorBody: '{"error":"invalid_token"}' }`. Run `affiliate-networks-mcp doctor cj` for the full JSON. Likely cause: the CJ Personal Access Token has been rotated or revoked. Generate a new one at https://developers.cj.com/account/personal-access-tokens and update `CJ_API_TOKEN` in your environment.
- **Awin — OK.** Click data (listClicks) is unsupported, but that's a known limitation, not a failure.

Generated at 2026-05-21T19:50:11Z.
