---
name: awin-application-auto-approval
description: |
  Use this skill when an agency operator wants to work through a brand's pending Awin publisher applications and approve or decline them in one assisted batch. The pending queue is read from the Awin API; the approve or decline click is carried out in the operator's own authenticated Awin session through Claude-in-Chrome, because Awin exposes no public approve/decline endpoint. Decisions follow the brand's recorded strategy only, and the whole batch runs against a single explicit human confirmation.
  Trigger on: "approve pending Awin publishers for Acme", "work through Acme's Awin application queue", "auto-approve Awin applicants for [brand]", "clear the Awin pending publishers for Acme".
---

# Operating instructions

You work through one brand's pending Awin publisher applications and carry out an
approve or decline for each, in an assisted batch. The pending queue is the
verified source and is read from the Awin API. The approve or decline itself is a
click Awin gives no API for, so it happens in the operator's own authenticated
Awin session through Claude-in-Chrome. You decide approve, decline, or ask using
only the brand's recorded advisory strategy, you show the operator the full batch,
and you execute only after one explicit confirmation of the whole set.

This skill is assisted, not unattended. It never invents an approval rule and
never records a result the browser consumer did not observe at the verify
target.

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

## Step 3 — read the pending queue from the API

Read the queue from the API, never the dashboard:

Call `affiliate_awin-advertiser_list_media_partners({ brand })`, passing `brand`
exactly as it came back from `affiliate_resolve_brand`. Keep only the partners
whose `status` is `pending`.

State plainly that the API is the verified source of the queue and that the
browser is used later only for the approve or decline click Awin exposes no API
for. If the call fails, surface the verbatim envelope (network, operation,
message, httpStatus) and stop. Never treat a failure as an empty queue.

If the queue is genuinely empty, say there are no pending applications and stop.

## Step 4 — read the advisory strategy

Call `affiliate_get_client_strategy({ brand })`.

Treat `strategy` prose and `kpi.targets` as advisory context only. They shape
which applicants you propose to approve or decline; they never authorise a write.
If `kpi.parseErrors` is non-empty, report each malformed line verbatim and
exclude it from your reasoning. Never guess what a malformed line meant.

If no strategy is recorded, say so. You may still run, but every applicant the
strategy does not cover becomes an **ask** in Step 5.

## Step 5 — build the proposed decision set

For each pending applicant, decide approve, decline, or **ask**, using only the
recorded strategy:

- **Approve** when the recorded strategy clearly endorses this applicant's type,
  region, or promotion method.
- **Decline** when the recorded strategy clearly excludes it (for example a
  deprioritised partner type or a brand-safety rule it breaks).
- **Ask** when the strategy is silent, the applicant's type, region, or promotion
  method is not covered, or a KPI line that would have decided it failed to
  parse. Surface each ask with the reason it could not be decided.

Never invent an approval rule. Where the strategy does not speak, the answer is
ask, not a guessed approve or decline.

## Step 6 — show the batch and get one confirmation

Show the operator the full batch as a table: applicant name and id, the proposed
decision, and the strategy line that justifies it (or "needs your decision" for
an ask).

Resolve every **ask** with the operator first. Then get ONE explicit
confirmation of the whole set before any execution. This single confirmation is
the Tier-3 human gate that authorises the batch. Do not execute any decision
before it, and do not re-prompt per applicant after it.

## Step 7 — execute each confirmed decision

For each confirmed decision, in turn:

### 7a — emit the handoff

Call
`affiliate_awin-advertiser_propose_publisher_decision({ brand, programmeId, publisherId, publisherName, decision, declineReason? })`.
It returns an `ApiGapResponse` carrying a `BrowserHandoff` and records a
`handoff_emitted` audit line. Pass `declineReason` only for a decline the
operator gave a reason for.

### 7b — carry out the handoff in the browser

Drive Claude-in-Chrome to carry out the handoff, honouring
`browserFallback.constraints` exactly:

- Navigate ONLY to `browserFallback.startingUrl` using
  `mcp__Claude_in_Chrome__navigate`. Do not navigate anywhere else.
- Locate the named publisher row and confirm it is pending, using
  `mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__get_page_text`, or
  `mcp__Claude_in_Chrome__find`.
- Click approve or decline and, if `inputs.declineReason` is present, enter it,
  using `mcp__Claude_in_Chrome__computer` or `mcp__Claude_in_Chrome__form_input`.

Operate only on the named `publisherId`. Skip any row that is not in a pending
state; it may already be decided, and you must not repeat a completed mutation.
Stop and hand back to the operator on any login, MFA, or re-authentication
challenge. Never touch payment, payout, commission, or contract fields. Never
tick a consent or terms box the operator has not seen. If the approve or decline
control is missing, stop and report it.

### 7c — verify and close the arc

Revisit `browserFallback.verify.url` and check `browserFallback.verify.expect`
(the applicant should no longer be pending). Then record the observed outcome by
calling
`affiliate_awin-advertiser_report_publisher_decision_result({ brand, programmeId, publisherId, decision, verified, note? })`
with `verified: true` when the verify target showed the expected state, or
`verified: false` when it did not. This records `verified` or `verify_failed` and
closes the `handoff_emitted -> verified | verify_failed` arc. Never report a
result the verify target did not actually show.

## Step 8 — summarise

Summarise the run: how many were approved, declined, asked, and failed to verify,
each by applicant name and id. Remind the operator that the browser actions ran
in their own authenticated Awin session.

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
- The queue read is the API (the verified source). Execution is the browser, in
  the operator's own authenticated session.
- Never record a result the browser consumer did not observe at the verify
  target. Close each handoff only as `verified` or `verify_failed`, never as
  applied.
