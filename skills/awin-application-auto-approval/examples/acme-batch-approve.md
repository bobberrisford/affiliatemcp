# Example — "Work through Acme's Awin application queue"

Acme is bound to Awin (advertiser-side) via `brands.json`, with a recorded
strategy. Today is 2026-06-23.

**User**: Work through Acme's Awin application queue and approve the ones that fit our strategy.

**Assistant**: I will read the pending queue from your own Awin session in the
browser, propose a decision for each applicant from Acme's recorded strategy, and
show you the full batch before anything runs. The approve or decline clicks
happen in that same Awin session. Awin gives no API for application status or for
the approve/decline click, so both are browser steps.

Called `affiliate_resolve_brand({ network: "awin-advertiser" })` and filtered to
`acme` →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_list_actions({ brand: "acme", network: "awin-advertiser", effect: "write" })`
→ `approvePublisher` and `declinePublisher` both `ready`.

Called `affiliate_run_diagnostic({ network: "awin-advertiser" })` → live auth OK.

The advertiser accountId is `100001`. Made `100001` the active account first via
the account switcher (Awin ran an OIDC redirect to re-establish the session),
then navigated Claude-in-Chrome to
`https://app.awin.com/en/awin/advertiser/100001/partnerships/all`. Declined
non-essential cookies, closed the "Welcome to your new Awin" modal, and closed a
feedback-survey popup. The final URL stayed on `app.awin.com`, so this is the new
Awin UI, not Awin Classic.

Read the "Pending partners" section → 4 applicants, capturing name, publisher id,
website, primary promotional type, and primary sector for each.

Vetted each applicant's website in the browser before deciding:

- FitnessGearReviews: genuine editorial fitness-gear review site, active, UK.
- HomeOfficeHub: content site on home-office setups, active, UK. Dashboard label
  said "Clothing", but the site is travel-and-lifestyle editorial; trusted the
  vetting over the label.
- DealFinderUK: coupon/voucher site.
- GlobalCashbackPro: labelled "Finance" in the dashboard, but the site is a
  cashback sub-network, region not stated.

Called `affiliate_get_client_strategy({ brand: "acme" })` → premium content
partners preferred, no coupon or incentive sites, UK traffic only.
`kpi.parseErrors` is empty.

## Acme — proposed batch (Awin)

| Applicant | Id | Proposed | Justification |
| --- | --- | --- | --- |
| FitnessGearReviews | 557214 | approve | premium content partner, UK |
| HomeOfficeHub | 557219 | approve | content partner, UK (vetting overrode "Clothing" label) |
| DealFinderUK | 557210 | decline | coupon site, excluded by strategy |
| GlobalCashbackPro | 557223 | ask | sub-network/cashback per vetting, region not stated, needs your decision |

Three are clear from the strategy and the vetting. GlobalCashbackPro is an ask:
the vetting showed it is a cashback sub-network and the strategy does not cover
its region. How do you want to handle it?

**User**: Decline GlobalCashbackPro too. Go ahead with all four.

**Assistant**: Confirmed: approve FitnessGearReviews and HomeOfficeHub, decline
DealFinderUK and GlobalCashbackPro. This one confirmation authorises the whole
batch.

For each, in turn: called
`affiliate_awin-advertiser_propose_publisher_decision({ ... })` to get the
handoff (records `handoff_emitted`), drove Claude-in-Chrome to the handoff's
`startingUrl` (the partnerships page), confirmed the row was under Pending
partners, and clicked the green tick or red cross on that row only. For
DealFinderUK, the decline panel required a reason: selected "Website doesn't
align with our brand or audience" from the fixed list and submitted "Decline
partner". Then revisited the partnerships page and called
`affiliate_awin-advertiser_report_publisher_decision_result({ ..., verified: true })`.

GlobalCashbackPro's row was already gone from Pending partners when I reached it,
so I skipped the click and recorded `verified: false` with a note.

## Summary

- Approved (2): FitnessGearReviews (557214), HomeOfficeHub (557219).
- Declined (1): DealFinderUK (557210), reason "Website doesn't align with our
  brand or audience".
- Failed to verify (1): GlobalCashbackPro (557223), no longer pending on arrival,
  not actioned by this run.

The queue read and the browser actions all ran in your own authenticated Awin
session.
