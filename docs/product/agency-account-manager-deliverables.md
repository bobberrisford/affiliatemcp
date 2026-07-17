# Agency account-manager deliverables

> Status: active product backlog. Accepted decisions and shipped behaviour take
> precedence. Confirm the required operations against each configured
> advertiser adapter before running or implementing a deliverable.

This is a catalogue of the concrete, named deliverables an agency affiliate
account manager produces, organised by the artefact they hand to a client or
their own manager: the daily snapshot, the weekly report, the QBR, the publisher
performance review, the new business pitch, and so on. It doubles as a backlog
for brand/agency-side skills.

Every deliverable here is scoped to the **read-oriented advertiser tools**.
Adapter capabilities vary, so a workflow must check support and report gaps
rather than assuming every network exposes every operation.

Tags:

- **SHIPPED**: covered by an existing skill.
- **EXTEND**: should be an output profile or focused extension of a shipped
  skill, not a new top-level skill.
- **NET-NEW**: a distinct workflow that may justify a new skill.
- **PARTIAL**: useful only on adapters with the required capability or with a
  manual step.

The daily, weekly, monthly, and quarterly reports remain separately named
deliverables because account managers ship them separately. They should share
one reporting workflow because they use the same underlying performance pull.
Do not create one skill per cadence.

## What the tools support today

The agency AM persona is served by advertiser-side adapters. The common
read-oriented surface includes:

- `list_programmes` — the brand's programme or programmes; often one synthetic row per advertiser account.
- `list_transactions` — conversions with status (pending, approved, reversed, paid), sale amount, commission, age, and reversal reason.
- `list_media_partners` — the publisher roster with status (active, pending, inactive).
- `get_programme_performance` — per-publisher, per-period clicks, conversions, gross sale, commission, and status.
- `verify_auth` — credential check.

Meta tools sit alongside the per-network tools: `affiliate_resolve_brand` maps a
logical brand slug to the right network credentials, `affiliate_list_networks`
enumerates configured networks, and `affiliate_run_diagnostic` checks health.

This is not a uniform guarantee. For example, Tradedoubler advertiser does not
implement `list_transactions`, and PartnerStack advertiser does implement
`get_earnings_summary`. Several adapters report unavailable click metrics as
zero in performance rows, so a workflow must consult capabilities and known
limitations before interpreting zero clicks as observed zero activity.

The accepted action-authority decision governs advertiser writes. Most
deliverables below are read-only reports or proposals. A deliverable may
surface a queue for the AM to action in the network dashboard; it must not
imply that a write is available unless the relevant write contract and
approval gate are implemented.

The client-strategy stack now provides advisory local context through
`affiliate_get_client_strategy`, `affiliate_set_client_strategy`,
`affiliate_list_client_strategies`, the `client-onboarding` skill, and
strategy-aware reporting skills. Reports may judge results against a client's
recorded strategy and KPIs. Strategy and KPIs never authorise writes.

## Recurring performance reports (the cadence stack)

### 1. Daily snapshot — EXTEND, schedulable
The internal "what happened yesterday" pulse, usually for the AM or their team
rather than the client.
- Triggers: "Give me Acme's numbers for yesterday.", "Daily snapshot for Acme."
- Tools: `get_programme_performance` over a one-day window, plus
  `list_transactions` for fresh conversions where supported.
- Delivery shape: a concise output profile of `programme-performance-report`.

### 2. Weekly report — EXTEND, schedulable
The highest-frequency client-facing artefact: this week against last week, top
movers, and anything that needs a heads-up.
- Triggers: "Acme's weekly report.", "How did Acme do this week vs last?"
- Tools: `get_programme_performance` over the current and prior week, plus `list_media_partners` for partner context.
- Delivery shape: a concise client-note profile of `programme-performance-report`.

### 3. Monthly report — EXTEND
The month-close view: revenue, status split, commission, top partners, and the
month-over-month delta.
- Triggers: "Acme's month-end report.", "Close out Acme for May."
- Tools: `get_programme_performance` over the current and prior month, plus
  `list_transactions` for the status breakdown where supported.
- Delivery shape: a month-close profile of `programme-performance-report`.

### 4. Quarterly Business Review (QBR) — EXTEND
The set-piece deliverable: quarter trend, partner mix, wins, risks, a written
narrative, and the quarter-over-quarter comparison.
- Triggers: "Prepare Acme's QBR.", "Build the Q2 review for Acme."
- Tools: multi-period `get_programme_performance`, `list_media_partners` for the partner mix, and synthesised commentary.
- Delivery shape: a presentation-oriented profile of
  `programme-performance-report`, enriched by advisory client strategy and
  KPIs when a plan is recorded.

### 5. Single-brand performance report (ad hoc) — SHIPPED
The general-purpose "how is this brand doing" report. The cadence reports above
specialise it for a fixed window and audience.
- Triggers: "How is Acme doing this quarter?"
- Covered by [`programme-performance-report`](../../skills/programme-performance-report).

## Portfolio and book-level

### 6. Portfolio rollup — SHIPPED
A single headline view across every brand and network in the book.
- Triggers: "How's the whole book this week?"
- Covered by [`agency-portfolio-rollup`](../../skills/agency-portfolio-rollup).

### 7. Anomaly alert — SHIPPED, schedulable
A week-over-week scan for revenue drops, reversal spikes, top-10 dropouts, and
dead programmes.
- Triggers: "Anything weird in the affiliate data this week?"
- Covered by [`programme-anomaly-watch`](../../skills/programme-anomaly-watch).

### 8. Client attention list — EXTEND
A triage of which clients need a look, by last activity and simple health flags,
across the whole book. Complements the rollup's totals with a "where to spend my
time" view.
- Triggers: "Which clients need a look this week?", "Who in the book is slipping?"
- Tools: per-brand `get_programme_performance`, compared against each brand's
  prior period, with `list_transactions` detail where supported.
- Boundary: extend the shipped `agency-portfolio-rollup` needs-attention
  subsection or `programme-anomaly-watch`; do not create a separate skill for
  this view.

## Partner-focused deliverables

### 9. Publisher performance review — NET-NEW
A deep dive on one publisher, typically as prep for a call: clicks, conversions,
EPC, commission, and trend across the brand or brands they run.
- Triggers: "Review [publisher] for Acme.", "Prep me for the call with [publisher]."
- Tools: `get_programme_performance` filtered to a single `publisherId` over several periods.
- Boundary: distinct from the all-publisher performance report because the
  user outcome is call preparation for one named partner.

### 10. Top-partner scorecard / league table — SHIPPED
Partners ranked by revenue and conversion for one brand.
- Triggers: "Acme's top 10 publishers.", "Who's driving Acme's revenue?"
- Tools: `get_programme_performance` grouped by publisher.
- Covered by the top-10 publisher section in
  [`programme-performance-report`](../../skills/programme-performance-report).

### 11. Roster audit and dormant / reactivation list — SHIPPED
The roster split by status, plus active partners with no recent activity to chase.
- Triggers: "Who's gone quiet on Acme?", "Acme's partner roster health."
- Tools: `list_media_partners` cross-referenced with recent `get_programme_performance`. Output is a read-only worklist; the outreach itself happens outside the tool.
- Covered by [`partner-roster-audit`](../../skills/partner-roster-audit). Drafting
  the re-engagement messages from its worklist is
  [`partner-outreach`](../../skills/partner-outreach) (drafts only; never sends).

### 12. Application / onboarding queue — SHIPPED
The list of partner applications waiting on a decision.
- Triggers: "Which partner applications are pending on Acme?"
- Tools: `list_media_partners` filtered to pending status.
- Capability note: partner status coverage varies by adapter; unsupported or
  inferred status must be reported.
- Covered by [`partner-application-queue`](../../skills/partner-application-queue).

## Commission and validation

### 13. Validation queue report — PARTIAL
Pending transactions awaiting review, bucketed by age.
- Triggers: "What's waiting to be validated on Acme?", "Acme's pending queue."
- Tools: `list_transactions` filtered to pending status. The report surfaces the queue; the AM approves or declines in the dashboard.
- Capability note: unavailable where the advertiser adapter does not implement
  `list_transactions`.

### 14. Reversal / decline report — PARTIAL
Why commissions were declined, grouped by reason and by publisher.
- Triggers: "Why are Acme's commissions being declined?", "Acme's reversals this month."
- Tools: `list_transactions` filtered to reversed status, with the verbatim reversal reason.
- Capability note: requires `list_transactions`; reversal-reason coverage
  varies and missing reasons must remain unspecified rather than guessed.

### 15. Commission liability / payout snapshot — PARTIAL
What the brand owes this period, by status.
- Triggers: "Acme's commission liability this month?", "What's Acme due to pay out?"
- Tools: `list_transactions` summed by status over a window.
- Capability note: requires `list_transactions`; report per currency and never
  imply that the result authorises a payout.

## Growth and new business

### 16. Programme health check / audit — SHIPPED
A one-off diagnostic across every available data operation for an existing or
newly-won brand, useful at handover or kick-off.
- Triggers: "Audit Acme's programme.", "Health-check the Acme account."
- Tools: every supported read operation, plus a clearly labelled manual
  tracking-link check where needed. Do not cite an unshipped tracking-check
  skill.
- Covered by [`programme-health-check`](../../skills/programme-health-check),
  which points at the shipped `audit-affiliate-links` skill for live link
  verification rather than implying it ran the check itself.

### 17. New business pitch — PARTIAL
Track-record evidence built from the agency's own book, aggregate results and
case-study numbers, to win a prospect. Note the limit: the agency holds no
credentials for the prospect's own programme, so this deliverable proves what
the agency has achieved elsewhere rather than analysing the prospect's current
data.
- Triggers: "Build a pitch using our results.", "Pull case-study numbers for a new business deck."
- Tools: portfolio-wide `get_programme_performance` across the brands the agency already manages.
- Boundary: client results may be confidential. Require explicit operator
  confirmation of which results may be used, prefer aggregated or anonymised
  evidence, and never expose a client's identity or figures by default.

### 18. Link / tracking audit (brand framing) — PARTIAL
A check that a brand's tracking links still fire correctly.
- Triggers: "Are Acme's tracking links healthy?"
- Tools: the existing [`audit-affiliate-links`](../../skills/audit-affiliate-links)
  skill is publisher-leaning. A brand-side framing and any live tracking-check
  operation remain unshipped.

## Recommended next work

1. **Consolidate the cadence stack (#1–#4)** by extending
   `programme-performance-report` with concise daily, weekly-client-note,
   month-close, and QBR output profiles. Keep this one coherent reporting
   workflow rather than four skills.
2. **Publisher performance review (#9)** as the first genuinely distinct
   net-new skill: one named partner, designed for call preparation.
3. **Reversal / decline report (#14)** as a capability-aware skill or focused
   extension: a recurring read-only investigation, available only where
   `list_transactions` and reversal fields support it.
4. **Programme health check (#16)** after defining its capability-aware output
   and manual tracking-check boundary.

Do not start additional skill PRs from this backlog until the active item
merges. Keep each candidate tied to one distinct user outcome and prefer
extending a shipped workflow when the tool calls and reasoning steps are the
same.
