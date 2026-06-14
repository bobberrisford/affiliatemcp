# Agency account-manager deliverables

This is a catalogue of the concrete, named deliverables an agency affiliate
account manager produces, organised by the artefact they hand to a client or
their own manager: the daily snapshot, the weekly report, the QBR, the publisher
performance review, the new business pitch, and so on. It doubles as a backlog
for brand/agency-side skills.

Every deliverable here is scoped to what the **read-only advertiser tools**
support today. Where an existing skill already covers a deliverable it is tagged
SHIPPED; the rest are net-new and buildable now. The point of listing the daily,
weekly, monthly, and quarterly reports separately is that they are the same
underlying performance pull at different altitude and cadence, and an account
manager ships each as a distinct, separately-scheduled artefact.

## What the tools support today

The agency AM persona is served by advertiser-side adapters, which are
**read-only**. Each exposes four data operations plus auth:

- `list_programmes` — the brand's programme or programmes; often one synthetic row per advertiser account.
- `list_transactions` — conversions with status (pending, approved, reversed, paid), sale amount, commission, age, and reversal reason.
- `list_media_partners` — the publisher roster with status (active, pending, inactive).
- `get_programme_performance` — per-publisher, per-period clicks, conversions, gross sale, commission, and status.
- `verify_auth` — credential check.

Meta tools sit alongside the per-network tools: `affiliate_resolve_brand` maps a
logical brand slug to the right network credentials, `affiliate_list_networks`
enumerates configured networks, and `affiliate_run_diagnostic` checks health.
The `will-it-track` skill runs a live tracking check on an affiliate URL.

Out of reach today, so no deliverable below depends on them: approving or
declining transactions, editing commissions or programmes, recruiting or
messaging publishers, and the `get_earnings_summary`, `list_clicks`, and
`get_programme` operations on the advertiser side (all unimplemented). A
deliverable may surface a queue for the AM to action in the network dashboard;
it cannot perform the write itself.

## Recurring performance reports (the cadence stack)

### 1. Daily snapshot — NET-NEW, schedulable
The internal "what happened yesterday" pulse, usually for the AM or their team
rather than the client.
- Triggers: "Give me Acme's numbers for yesterday.", "Daily snapshot for Acme."
- Tools: `get_programme_performance` over a one-day window, plus `list_transactions` for fresh conversions.

### 2. Weekly report — NET-NEW, schedulable
The highest-frequency client-facing artefact: this week against last week, top
movers, and anything that needs a heads-up.
- Triggers: "Acme's weekly report.", "How did Acme do this week vs last?"
- Tools: `get_programme_performance` over the current and prior week, plus `list_media_partners` for partner context.

### 3. Monthly report — NET-NEW
The month-close view: revenue, status split, commission, top partners, and the
month-over-month delta.
- Triggers: "Acme's month-end report.", "Close out Acme for May."
- Tools: `get_programme_performance` over the current and prior month, plus `list_transactions` for the status breakdown.

### 4. Quarterly Business Review (QBR) — NET-NEW
The set-piece deliverable: quarter trend, partner mix, wins, risks, a written
narrative, and the quarter-over-quarter comparison.
- Triggers: "Prepare Acme's QBR.", "Build the Q2 review for Acme."
- Tools: multi-period `get_programme_performance`, `list_media_partners` for the partner mix, and synthesised commentary.

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

### 8. Client attention list — NET-NEW
A triage of which clients need a look, by last activity and simple health flags,
across the whole book. Complements the rollup's totals with a "where to spend my
time" view.
- Triggers: "Which clients need a look this week?", "Who in the book is slipping?"
- Tools: per-brand `get_programme_performance` and `list_transactions`, compared against each brand's prior period.

## Partner-focused deliverables

### 9. Publisher performance review — NET-NEW
A deep dive on one publisher, typically as prep for a call: clicks, conversions,
EPC, commission, and trend across the brand or brands they run.
- Triggers: "Review [publisher] for Acme.", "Prep me for the call with [publisher]."
- Tools: `get_programme_performance` filtered to a single `publisherId` over several periods.

### 10. Top-partner scorecard / league table — NET-NEW
Partners ranked by revenue and conversion for one brand.
- Triggers: "Acme's top 10 publishers.", "Who's driving Acme's revenue?"
- Tools: `get_programme_performance` grouped by publisher.

### 11. Roster audit and dormant / reactivation list — NET-NEW
The roster split by status, plus active partners with no recent activity to chase.
- Triggers: "Who's gone quiet on Acme?", "Acme's partner roster health."
- Tools: `list_media_partners` cross-referenced with recent `get_programme_performance`. Output is a read-only worklist; the outreach itself happens outside the tool.

### 12. Application / onboarding queue — NET-NEW
The list of partner applications waiting on a decision.
- Triggers: "Which partner applications are pending on Acme?"
- Tools: `list_media_partners` filtered to pending status.

## Commission and validation

### 13. Validation queue report — NET-NEW
Pending transactions awaiting review, bucketed by age.
- Triggers: "What's waiting to be validated on Acme?", "Acme's pending queue."
- Tools: `list_transactions` filtered to pending status. The report surfaces the queue; the AM approves or declines in the dashboard.

### 14. Reversal / decline report — NET-NEW
Why commissions were declined, grouped by reason and by publisher.
- Triggers: "Why are Acme's commissions being declined?", "Acme's reversals this month."
- Tools: `list_transactions` filtered to reversed status, with the verbatim reversal reason.

### 15. Commission liability / payout snapshot — NET-NEW
What the brand owes this period, by status.
- Triggers: "Acme's commission liability this month?", "What's Acme due to pay out?"
- Tools: `list_transactions` summed by status over a window.

## Growth and new business

### 16. Programme health check / audit — NET-NEW
A one-off diagnostic across every available data operation for an existing or
newly-won brand, useful at handover or kick-off.
- Triggers: "Audit Acme's programme.", "Health-check the Acme account."
- Tools: `list_programmes`, `get_programme_performance`, `list_media_partners`, `list_transactions`, and a `will-it-track` link check.

### 17. New business pitch — NET-NEW
Track-record evidence built from the agency's own book, aggregate results and
case-study numbers, to win a prospect. Note the limit: the agency holds no
credentials for the prospect's own programme, so this deliverable proves what
the agency has achieved elsewhere rather than analysing the prospect's current
data.
- Triggers: "Build a pitch using our results.", "Pull case-study numbers for a new business deck."
- Tools: portfolio-wide `get_programme_performance` across the brands the agency already manages.

### 18. Link / tracking audit (brand framing) — PARTIAL
A check that a brand's tracking links still fire correctly.
- Triggers: "Are Acme's tracking links healthy?"
- Tools: `will-it-track`. The existing [`audit-affiliate-links`](../../skills/audit-affiliate-links) skill is publisher-leaning; a brand-side framing is net-new.

## Recommended first skills to build

- **Weekly report (#2)** — the highest-frequency client artefact; building it well covers the daily and monthly variants too.
- **Quarterly Business Review (#4)** — the highest-value ritual and the one AMs most want help drafting.
- **Publisher performance review (#9)** — the call-prep workhorse, run before every partner conversation.
- **Reversal / decline report (#14)** — the recurring firefight, and a clear read-only win that surfaces a problem the AM then resolves in the dashboard.
