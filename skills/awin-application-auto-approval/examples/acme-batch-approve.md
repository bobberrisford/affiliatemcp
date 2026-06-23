# Example — "Work through Acme's Awin application queue"

Acme is bound to Awin (advertiser-side) via `brands.json`, with a recorded
strategy. Today is 2026-06-23.

**User**: Work through Acme's Awin application queue and approve the ones that fit our strategy.

**Assistant**: I will read the pending queue from the Awin API, propose a
decision for each applicant from Acme's recorded strategy, and show you the full
batch before anything runs. The approve or decline clicks happen in your own
Awin session.

Called `affiliate_resolve_brand({ network: "awin-advertiser" })` and filtered to
`acme` →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_list_actions({ brand: "acme", network: "awin-advertiser", effect: "write" })`
→ `approvePublisher` and `declinePublisher` both `ready`.

Called `affiliate_run_diagnostic({ network: "awin-advertiser" })` → live auth OK.

Called `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })` and
filtered to `status: "pending"` → 4 applicants. The API is the verified source of
this queue; the browser is used later only for the click Awin gives no API for.

Called `affiliate_get_client_strategy({ brand: "acme" })` → premium content
partners preferred, no coupon or incentive sites, UK traffic only.
`kpi.parseErrors` is empty.

## Acme — proposed batch (Awin)

| Applicant | Id | Proposed | Justification |
| --- | --- | --- | --- |
| FitnessGearReviews | 557214 | approve | premium content partner, UK |
| HomeOfficeHub | 557219 | approve | content partner, UK |
| DealFinderUK | 557210 | decline | coupon site, excluded by strategy |
| GlobalCashbackPro | 557223 | ask | cashback model, region not stated — needs your decision |

Three are clear from the strategy. GlobalCashbackPro is an ask: the strategy
does not cover its region and cashback is not listed either way. How do you want
to handle it?

**User**: Decline GlobalCashbackPro too. Go ahead with all four.

**Assistant**: Confirmed: approve FitnessGearReviews and HomeOfficeHub, decline
DealFinderUK and GlobalCashbackPro. This one confirmation authorises the whole
batch.

For each, in turn: called
`affiliate_awin-advertiser_propose_publisher_decision({ ... })` to get the
handoff (records `handoff_emitted`), drove Claude-in-Chrome to the handoff's
`startingUrl`, confirmed the row was pending, clicked the decision, then revisited
`verify.url` and called
`affiliate_awin-advertiser_report_publisher_decision_result({ ..., verified: true })`.

GlobalCashbackPro's row was already gone from the pending queue when I reached it,
so I skipped the click and recorded `verified: false` with a note.

## Summary

- Approved (2): FitnessGearReviews (557214), HomeOfficeHub (557219).
- Declined (1): DealFinderUK (557210).
- Failed to verify (1): GlobalCashbackPro (557223) — no longer pending on arrival,
  not actioned by this run.

All browser actions ran in your own authenticated Awin session.
