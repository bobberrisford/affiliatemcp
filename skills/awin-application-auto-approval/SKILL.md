---
name: awin-application-auto-approval
description: |
  Use this skill when an agency operator wants to work through a brand's pending Awin publisher applications and approve or decline them in one assisted batch. The pending queue is read from the operator's own authenticated Awin session through Claude-in-Chrome, because Awin exposes no API that returns publisher application status. The approve or decline click is carried out in that same browser session, because Awin exposes no public approve/decline endpoint either. This flow works only on the new Awin UI (app.awin.com); Awin Classic (ui.awin.com) accounts are detected and stopped. Decisions follow the brand's recorded strategy only, and the whole batch runs against a single explicit human confirmation.
  Trigger on: "approve pending Awin publishers for Acme", "work through Acme's Awin application queue", "auto-approve Awin applicants for [brand]", "clear the Awin pending publishers for Acme".
---

# Operating instructions

You work through one brand's pending Awin publisher applications and carry out an
approve or decline for each, in an assisted batch. The pending queue is read from
the operator's own authenticated Awin session through Claude-in-Chrome, because
Awin exposes no API that returns application status. The approve or decline click
happens in that same browser session, because Awin gives no API for it either.
You decide approve, decline, or ask using only the brand's recorded advisory
strategy, you show the operator the full batch, and you execute only after one
explicit confirmation of the whole set.

This skill is assisted, not unattended. It never invents an approval rule and
never records a result the browser consumer did not observe at the verify
target. It works only on the new Awin UI (app.awin.com); if an account is on
Awin Classic (ui.awin.com), it stops and says so.

## Step 1 — resolve the brand

If the operator did not name a brand, ask which one. One brand per run.

Call `affiliate_resolve_brand`. If the operator named the network, pass
`{ network: "awin-advertiser" }`; otherwise call with no arguments and filter the
result to the named brand. The response is an array of
`{ brand, network, networkBrandId }`. Keep only the binding whose `network` is
`awin-advertiser` and whose `brand` matches.

If there is no `awin-advertiser` binding for the brand, say the brand is not
registered for Awin advertiser, suggest `affiliate_resolve_brand` with no
arguments to see what is, and stop.

## Step 2 — confirm readiness

Confirm the write actions are usable before reading anything else:

1. Call `affiliate_list_actions({ brand, network: "awin-advertiser", effect: "write" })`
   and check that `approvePublisher` and `declinePublisher` report `ready`.
2. Call `affiliate_run_diagnostic` for the brand's Awin advertiser binding to
   confirm live auth.

If readiness is `missing_credentials` or `unsupported`, or the diagnostic shows
auth is not working, report exactly what is missing and stop. Do not proceed to
read the queue or open a browser.

## Step 3 — resolve the account id

From the `affiliate_resolve_brand` result in Step 1, take the brand's
`networkBrandId` for `awin-advertiser`. This is the Awin advertiser accountId
(the advertiserId). You will use it to build the partnerships-page URL. One brand
per run, so there is exactly one advertiserId.

## Step 4 — open the queue in the browser and detect the UI generation

Navigate (Claude-in-Chrome) to
`https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`, using
`mcp__Claude_in_Chrome__navigate` with the resolved advertiserId.

Dismiss the "Welcome to your new Awin" modal if it is present. Handle the cookie
banner privacy-preservingly: choose Reject or decline non-essential cookies, not
Accept all.

Then check the final URL. If it has redirected to `ui.awin.com` (Awin Classic),
STOP and tell the operator: "this account is on Awin Classic; automated
publisher approval is not supported for it yet." Do not attempt a Classic flow.

## Step 5 — read the Pending partners section

On the new UI, read the "Pending partners" list using
`mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__get_page_text`, or
`mcp__Claude_in_Chrome__find`. For each pending applicant, capture: name,
publisher id, website, primary promotional type, primary sector, and the Pending
status. This is the queue.

If there are no pending partners, say so and stop.

## Step 6 — read the advisory strategy and build the decision set

Call `affiliate_get_client_strategy({ brand })`.

Treat `strategy` prose and `kpi.targets` as advisory context only. They shape
which applicants you propose to approve or decline; they never authorise a write.
If `kpi.parseErrors` is non-empty, report each malformed line verbatim and
exclude it from your reasoning. Never guess what a malformed line meant.

For each pending applicant, decide approve, decline, or **ask**, using ONLY the
recorded strategy. The captured promotional type, sector, and website are the
main signals to match against the strategy:

- **Approve** when the recorded strategy clearly endorses this applicant's
  promotional type, sector, or website.
- **Decline** when the recorded strategy clearly excludes it (for example a
  deprioritised promotional type or a brand-safety rule it breaks).
- **Ask** when the strategy is silent, the applicant's promotional type, sector,
  or website is not covered, or a KPI line that would have decided it failed to
  parse. Surface each ask with the reason it could not be decided.

Never invent an approval rule. Where the strategy does not speak, the answer is
ask, not a guessed approve or decline. If no strategy is recorded, say so; you
may still run, but every applicant becomes an **ask**.

## Step 7 — show the batch, resolve asks, get one confirmation

Show the operator the full batch as a table: applicant name and id, the proposed
decision, and the strategy line that justifies it (or "needs your decision" for
an ask).

Resolve every **ask** with the operator first. Then get ONE explicit
confirmation of the whole set before any execution. This single confirmation is
the Tier-3 human gate that authorises the batch. Do not execute any decision
before it, and do not re-prompt per applicant after it.

## Step 8 — execute each confirmed decision

For each confirmed decision, in turn:

### 8a — emit the handoff

Call
`affiliate_awin-advertiser_propose_publisher_decision({ brand, programmeId, publisherId, publisherName, decision, declineReason? })`.
It records a `handoff_emitted` audit line and returns an `ApiGapResponse`
carrying a `BrowserHandoff` whose `startingUrl` is the partnerships page. Pass
`declineReason` only for a decline the operator gave a reason for.

### 8b — carry out the handoff in the browser

Drive Claude-in-Chrome to carry out the handoff, honouring the handoff
constraints exactly. On the named publisher's Pending row ONLY, click the green
tick to approve or the red cross to decline, using
`mcp__Claude_in_Chrome__computer` or `mcp__Claude_in_Chrome__form_input`; if
`inputs.declineReason` is present, enter it.

Operate only on the named `publisherId`. Skip any row that is not in a pending
state; it may already be decided, and you must not repeat a completed mutation.
Stop and hand back to the operator on any login, MFA, or re-authentication
challenge. Never touch payment, payout, commission, or contract fields. Never
tick a consent or terms box the operator has not seen. If you were redirected to
`ui.awin.com` (Awin Classic) at any point, stop.

### 8c — verify and close the arc

Revisit the partnerships page and confirm the publisher no longer appears under
"Pending partners". Then record the observed outcome by calling
`affiliate_awin-advertiser_report_publisher_decision_result({ brand, programmeId, publisherId, decision, verified, note? })`
with `verified: true` when the row was gone from Pending partners, or
`verified: false` when it was not. This records `verified` or `verify_failed` and
closes the `handoff_emitted -> verified | verify_failed` arc. Never report a
result the verify target did not actually show.

## Step 9 — summarise

Summarise the run: how many were approved, declined, asked, and failed to verify,
each by applicant name and id. Remind the operator that the queue read and the
browser actions both ran in their own authenticated Awin session.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Assisted batch approve, not unattended. A human resolves every ask and confirms
  the whole set.
- The single batch confirmation is the only authority to execute. It is the
  Tier-3 human gate; nothing runs before it.
- Strategy is advisory. It shapes the proposed decisions; it never authorises a
  write.
- Ask when the strategy is silent. Never invent an approval rule and never guess
  a decision the strategy did not support.
- Never invent applicants or pad the queue. An unreadable queue is a surfaced
  failure, not zero pending.
- One brand per run, Awin advertiser only.
- Both the queue read and the execution are browser actions on the new Awin UI,
  carried out in the operator's own authenticated session. Awin exposes no API
  for application status and none for approve/decline.
- New Awin UI (app.awin.com) only. Awin Classic (ui.awin.com) accounts are not
  supported: detect the redirect and stop.
- Never record a result the browser consumer did not observe at the verify
  target. Close each handoff only as `verified` or `verify_failed`, never as
  applied.
