# Example — "Apply to my Awin outdoor shortlist"

The publisher is set up on Awin (publisher side) with `AWIN_PUBLISHER_ID`
configured. They have an advisory `Strategy.md` focused on outdoor and cycling
retailers with a commission floor around 6%, and they ran
`brand-application-shortlist` first.

**User**: Apply to the top of my Awin outdoor shortlist — Summit Trail Co, PedalWorks and Crag & Co.

**Assistant**: I'll pull what's still joinable, surface each programme's terms for you to review, and only submit after you confirm the batch. Nothing is submitted until then.

Called `affiliate_awin_list_programmes({ status: "available" })` → all three still joinable (`relationship=notjoined`).

Called `affiliate_list_actions({ network: "awin", effect: "write" })` → `applyToProgramme` is `ready`. Diagnostic confirms live auth and `AWIN_PUBLISHER_ID` set.

Read each programme's **Terms** tab in your Awin session to build the review bundle below.

## Terms review — 3 programmes proposed

| Brand | Advertiser id | Action | Terms source | Material restrictions | Terms seen |
| --- | --- | --- | --- | --- | --- |
| Summit Trail Co | 412233 | Apply | Terms tab (full text shown) | No PPC on brand terms; no voucher/cashback | Yes |
| PedalWorks | 409871 | Apply | Terms tab (full text shown) | Content sites only; no sub-network | Yes |
| Crag & Co | 418090 | Apply | Terms tab (full text shown) | Standard; 30-day cookie | Yes |

One programme from the original shortlist, RideKit (416742), is **excluded**: its
Terms tab would not load, so its terms could not be shown. It is not in the batch.

### Confirmation

**Assistant**: Apply to these 3 Awin programmes — Summit Trail Co, PedalWorks, Crag & Co — and accept the displayed terms for each listed programme? RideKit is dropped (terms unavailable).

**User**: Yes, apply to those three.

## Execution

For each, in turn:

- **Summit Trail Co (412233)** — `affiliate_awin_propose_application({ brand: "Summit Trail Co", advertiserId: "412233", programmeName: "Summit Trail Co" })` → handoff emitted. Navigated to the programme-detail page, confirmed still Not Joined, terms matched the reviewed bundle, clicked Join Programme, submitted. Verify target (pending tab) shows pending → `affiliate_awin_report_application_result({ ..., verified: true })`.
- **PedalWorks (409871)** — applied; pending confirmed → `verified: true`.
- **Crag & Co (418090)** — at submit, Awin presented an extra brand-safety compliance checkbox not in the reviewed bundle. **Stopped and asked** rather than ticking an unseen consent. The operator reviewed it and confirmed separately, then it was submitted; pending confirmed → `verified: true`.

## Summary

- Applied and verified pending: Summit Trail Co (412233), PedalWorks (409871), Crag & Co (418090).
- Dropped before submit: RideKit (416742) — terms could not be shown.
- The applications ran in your own authenticated Awin session. Approval is now each advertiser's decision; check the Pending tab for status.
