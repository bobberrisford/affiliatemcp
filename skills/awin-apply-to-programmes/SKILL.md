---
name: awin-apply-to-programmes
description: |
  Use this skill when a publisher or agency wants to actually apply to a batch of Awin brand programmes they have not yet joined. The joinable set is read from the Awin API; applying is a click Awin exposes no API for, so it is carried out in the operator's own authenticated Awin session through Claude-in-Chrome. For every programme the skill surfaces the advertiser's terms for review, lets the operator drop rows, and submits only after one explicit batch confirmation that stands as informed acceptance of the terms shown.
  Trigger on: "apply to these Awin brands", "join these Awin programmes for me", "submit my Awin applications", "apply to my Awin shortlist", "join [brand] on Awin".
---

# Operating instructions

You take a set of Awin programmes the publisher has not yet joined and apply to
each, in an assisted batch. The joinable set is read from the Awin API. The
application itself is a click Awin gives no API for, so it happens in the
operator's own authenticated Awin session through Claude-in-Chrome. For every
programme you surface the advertiser's terms, let the operator review and drop
rows, and submit only after one explicit confirmation of the whole batch. That
single confirmation is the operator's informed acceptance of the terms you
showed, and nothing else.

This skill is assisted, not unattended. It never accepts terms the operator has
not seen, never invents a programme or a term, and never records a result the
browser consumer did not observe at the verify target. If a programme's terms
cannot be shown, or anything unexpected appears at submit time, it stops on that
programme and hands back rather than guessing.

This is the doing half of the Awin publisher-application workflow. To discover
and rank which brands to apply to first, use `brand-application-shortlist`; bring
its shortlist here to apply.

## Step 1 — read the joinable programmes from the API

Read the joinable set from the API, never the dashboard:

Call `affiliate_awin_list_programmes({ status: "available" })`. On the Awin
publisher adapter this maps to Awin's `relationship=notjoined`, so it returns
programmes the publisher can apply to but has not joined. Each row is a
`Programme` with `id` (the advertiser id), `name`, `commissionRate`,
`categories`, and `currency`.

State plainly that the API is the verified source of what is joinable and that
the browser is used later only for the application click Awin exposes no API for.
If the call fails, surface the verbatim envelope (network, operation, message,
httpStatus) and stop. Never treat a failure as an empty set.

If the operator already has a shortlist (for example from
`brand-application-shortlist`), keep only its programmes that still appear in this
joinable set. Drop any that are no longer joinable and say which, so you never try
to apply to something already joined, pending, or rejected.

## Step 2 — confirm readiness

Confirm the action is usable before opening a browser:

1. Call `affiliate_list_actions({ network: "awin", effect: "write" })` and check
   that `applyToProgramme` reports `ready`.
2. Call `affiliate_run_diagnostic` for the Awin publisher binding to confirm live
   auth and that `AWIN_PUBLISHER_ID` is configured (the application URLs are
   scoped to the operator's own publisher account).

If readiness is `missing_credentials` or `unsupported`, or the diagnostic shows
auth is not working, report exactly what is missing (most often a missing
`AWIN_PUBLISHER_ID`) and stop. Do not read further or open a browser.

## Step 3 — read the advisory strategy

A publisher applies across many brands, so discover what strategy context exists
before reading any single one:

1. Call `affiliate_list_client_strategies` (no arguments) to list the brands that
   have a recorded strategy or KPI file (`slug`, `hasStrategy`, `hasKpi`).
2. For a proposed programme whose brand matches a recorded `slug`, read it with
   `affiliate_get_client_strategy({ brand: <slug> })`.

Treat `strategy` prose and `kpi.targets` as advisory context only. They shape
which programmes you propose and in what order; they never authorise an
application. If `kpi.parseErrors` is non-empty, report each malformed line
verbatim and exclude it. Never guess what a malformed line meant. Where no
strategy is recorded for a brand, say so and rank that programme on its data
alone.

## Step 4 — propose the application set

Produce a single ranked list of the programmes you propose to apply to, ranked on
the signals the data supports: strategy fit first, then stated commission, then
category relevance, then currency fit. Compare like with like (never a flat fee
against a percentage); where a rate is missing say "rate not stated" rather than
scoring it zero. Do not fabricate metrics the API did not return.

This is a proposal, not a commitment. The operator can drop any row before
anything is submitted.

## Step 5 — build the itemised terms-review bundle

Before any application is submitted, build a review bundle for the proposed set.
For each programme, open its programme-detail page in Claude-in-Chrome and read
its terms so the operator can make an informed decision:

- Navigate to the programme-detail page for the advertiser using
  `mcp__Claude_in_Chrome__navigate`, then read the **Terms** tab with
  `mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__get_page_text`, or
  `mcp__Claude_in_Chrome__find`.
- Record, for each programme: brand/programme name and advertiser id; the
  application action to be taken; the **terms source** the operator can inspect
  (the displayed terms text, or the exact dashboard section/link Awin presents);
  a short digest of material restrictions (PPC, voucher/coupon, content,
  sub-network, cashback/loyalty, geography, disclosure, or promotional-method
  rules); and a clear **"terms seen"** status.

Where a programme's terms cannot be retrieved, displayed, or linked, mark it
**terms unavailable** and exclude it from the batch — you will not apply to a
programme whose terms you could not show. Stop and hand back on any login, MFA,
or re-authentication challenge.

## Step 6 — show the bundle and get one informed confirmation

Show the operator the full bundle as a table: brand/programme name and id, the
proposed action, the terms source, the restriction digest, and the "terms seen"
status. Let the operator remove any programme after seeing its terms; a single
surprising restriction can make one otherwise attractive programme unacceptable.

Then get ONE explicit confirmation of the remaining set, worded so the consent is
unambiguous, for example: "Apply to these N Awin programmes and accept the
displayed terms for each listed programme." That single confirmation is the
Tier-3 human gate and the operator's informed acceptance of the terms shown, for
this final batch only. Do not submit anything before it, and do not re-prompt per
programme after it. It is not permission to accept terms for any programme that
was hidden, summarised without a source, added after confirmation, or changed
between review and submission.

## Step 7 — apply to each confirmed programme

For each confirmed programme, in turn:

### 7a — emit the handoff

Call
`affiliate_awin_propose_application({ brand, advertiserId, programmeName, promotionMethodSummary? })`,
passing the programme's advertiser id and name and a short promotion-method
summary if the operator gave one. `brand` is a free display label, not a binding.
It returns an `ApiGapResponse` carrying a `BrowserHandoff` and records a
`handoff_emitted` audit line. It performs no network write.

### 7b — carry out the application in the browser

Drive Claude-in-Chrome to carry out the handoff, honouring
`browserFallback.constraints` exactly:

- Navigate ONLY to `browserFallback.startingUrl` (the programme-detail page for
  this advertiser) using `mcp__Claude_in_Chrome__navigate`. Do not navigate
  anywhere else.
- Confirm the programme relationship is still joinable. If it now reads joined,
  pending, or rejected, stop and skip it — do not repeat a mutation that already
  appears done.
- Confirm the terms presented at submit match the bundle the operator approved.
  If they differ, or Awin presents a special term, an extra compliance checkbox,
  a legal certification, a payment or payout change, or a form answer not in the
  approved bundle, **stop on this programme and ask the operator**. Do not fold a
  new condition into the existing batch confirmation.
- Apply only to the named `advertiserId`. Click "Join Programme" and complete the
  application using `mcp__Claude_in_Chrome__computer` or
  `mcp__Claude_in_Chrome__form_input`. If the form needs an answer the inputs do
  not supply (for example a free-text promotional-methods justification beyond
  the supplied summary), stop and hand back rather than inventing one.
- Never accept a terms or consent box the operator has not seen. Never touch
  payment, payout, or commission fields. Never negotiate or alter the programme's
  commercial terms. Stop and hand back on any login, MFA, or re-authentication
  challenge.

### 7c — verify and close the arc

Revisit `browserFallback.verify.url` (the pending-applications list) and check
`browserFallback.verify.expect`. Then record the observed outcome by calling
`affiliate_awin_report_application_result({ brand, advertiserId, programmeName, verified, note? })`
with `verified: true` when the programme now reads pending or joined, or
`verified: false` when it does not. This records `verified` or `verify_failed`
and closes the `handoff_emitted -> verified | verify_failed` arc. Never report a
result the verify target did not actually show; never record an application as
applied or succeeded.

## Step 8 — summarise

Summarise the run: how many programmes were applied to, dropped after terms
review, skipped as no longer joinable, stopped for unexpected terms, and failed
to verify, each by brand and advertiser id. Remind the operator that the browser
actions ran in their own authenticated Awin session and that approval is now the
advertiser's decision.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Assisted batch application, not unattended. A human reviews the terms, drops
  rows, and confirms the whole set.
- The single batch confirmation is the only authority to submit. It is the
  Tier-3 human gate and the informed acceptance of the terms shown; nothing runs
  before it.
- Never accept terms the operator has not seen. Where terms cannot be shown, the
  programme is excluded. Where terms change between review and submission, or a
  new condition appears, stop and ask.
- Strategy and KPI files are advisory. They shape which programmes you propose;
  they never authorise an application.
- The joinable read is the API (the verified source). Application is the browser,
  in the operator's own authenticated session.
- Apply only to the named advertiser. Skip a programme that is no longer
  joinable; never repeat a completed application.
- Never invent programmes, terms, or form answers. An unreadable joinable set is
  a surfaced failure, not zero programmes.
- Never record a result the browser consumer did not observe at the verify
  target. Close each handoff only as `verified` or `verify_failed`, never as
  applied.
