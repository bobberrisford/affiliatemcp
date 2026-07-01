# Awin account-manager doing layer: automate and verify the agency AM job

> Status: proposal (planning). Owner decision required before the T4 write build
> (see "Decisions required"). Scope: Awin only, advertiser-side first.
> Front end: the desktop app. Doing and reasoning: Claude.

## The outcome

An agency account manager who runs brand programmes on Awin should get through
their day from one surface. The desktop app shows what needs attention, computed
locally with no model call and no tokens. One click hands the task to Claude with
the work pre-written. Claude reads the data, decides, carries out the action (by
API where Awin exposes one, by a guided Claude-in-Chrome handoff where it does
not), then verifies the result and records an honest audit line. Nothing is
claimed done until it has been checked.

Target cohort: the advertiser/agency AM managing one or many brand programmes,
recruiting and vetting publishers, validating transactions, watching
performance, and reporting to clients.

## How the pieces fit: surface, decide, do, verify

The division of labour is fixed and identical for every task:

1. **Surface (desktop app, local).** The cockpit calls Awin read operations
   through the core facade and folds them into attention flags. No model, no
   tokens, no writes. Each flag carries a "do this in Claude" button.
2. **Decide (Claude).** The button deep-links into Claude via
   `claude://claude.ai/new?q=...` (web fallback `https://claude.ai/new?q=...`)
   with a task-specific prompt. The user reviews it; it is never auto-submitted.
   Claude runs the Awin MCP tools to read and reason.
3. **Do (Claude).** Where Awin has a write API, Claude calls it and the server
   observes the outcome. Where Awin has none, the adapter emits a typed
   `BrowserHandoff`; a Claude-in-Chrome consumer skill carries it out against the
   user's own authenticated Awin session, honouring the shared constraint floor
   and confirm-before-submit.
4. **Verify (Claude).** The consumer revisits the handoff's `verify.url`, checks
   `verify.expect`, and reports back, closing the arc
   `handoff_emitted -> verified | verify_failed`.

The desktop app is the launcher and the proof-of-attention surface. It never
drives a browser and never interprets data. This keeps it a thin client of the
shared core.

## What already exists (the substrate is deeper than first assumed)

- **The Claude-in-Chrome consumer is already the standard pattern**, not a gap.
  Four skills drive it end to end today: `awin-application-auto-approval`,
  `awin-apply-to-programmes`, `partner-application-queue`, `partner-roster-audit`.
  They read the queue from the API, propose decisions from the recorded advisory
  strategy, take one explicit human confirmation (the Tier-3 gate), emit the
  handoff, drive `mcp__Claude_in_Chrome__*`, then verify and close the audit arc.
- **Awin advertiser reads (API), `claim_status: experimental`:** `listBrands`,
  `listTransactions`, `listMediaPartners`, `getProgrammePerformance`, synthetic
  `listProgrammes` (`src/networks/awin-advertiser/adapter.ts`). Read-only at
  v0.1; the client refuses non-GET.
- **Awin publisher reads (API), `claim_status: production`** with rich tools
  (commission groups, transaction queries and disputes, performance reports).
- **Write emitters (pure handoffs):** advertiser `approvePublisher`,
  `declinePublisher`; publisher `applyToProgramme`. Each with a constraint floor,
  `mutates`, and a structured `verify` block.
- **Emit and verify tool surface:** `propose_publisher_decision` +
  `report_publisher_decision_result` (advertiser); the publisher equivalents.
- **Audit vocabulary fixed** (`src/shared/audit.ts`): `handoff_emitted`,
  `verified`, `verify_failed`, plus the API-write events. `succeeded` for a
  handoff is already forbidden. Storage is stderr only today.
- **Constraint floor** (`src/shared/browser-handoff.ts`): payment/payout never
  touched, stop on login/MFA, no repeat of a completed mutation, summarise and
  confirm before submitting, never accept unseen terms.
- **Desktop facade reads + cockpit** (`src/core/facade.ts`, `src/core/cockpit.ts`):
  `getEarnings`, `listTransactions`, `getProgrammePerformance`,
  `listConfiguredNetworks`, `computeCockpit`; flag kinds `unpaid_over_threshold`,
  `wow_swing`, `pending_applications`, `health`.
- **The front-end to Claude seam** (`desktop/main.js`, `desktop/preload.js`):
  `openClaudePrompt(text)` builds `claude://claude.ai/new?q=...`, reviewed not
  auto-sent, 14k cap, web fallback. Cockpit and locker already use it.
- **Task skills already authored:** `programme-performance-report`,
  `programme-anomaly-watch`, `publisher-performance-review`,
  `programme-health-check`, `chase-unpaid-commissions`,
  `programme-reversal-report`, `agency-portfolio-rollup`, `client-onboarding`,
  `partner-outreach`, `partner-roster-audit`.

## The task decisions (this pass)

| # | Task | Decision | Do channel | Status |
|---|------|----------|------------|--------|
| T1 | Approve/decline pending publisher applications | Confirmed working; verify + promote | Browser handoff | Built end to end (`awin-application-auto-approval`); needs live-tenant verification |
| T2 | Monitor performance, spot anomalies | Do | API read + Claude | Skills exist; wire cockpit + prompt |
| T3 | Commission reconciliation | Do | API read + Claude | Skills exist; wire cockpit + locker |
| T4 | Fraud review then validate/decline transactions | Build (new) | Read + new browser handoff | New: fraud-signal skill + `validateTransaction` emitter + consumer + gates |
| T5 | Client reporting and QBR prep | Do | API + Claude skills | Skills exist; wire "prep report" button |
| T6 | Publisher recruitment | Do | Read + draft + browser handoff | Drafting exists (`partner-outreach`); discovery + invite are gaps |
| T7 | Commission/terms/bonus/tenancy changes | Excluded | n/a | Human-only; constraint floor forbids |

### T1 Publisher applications — confirmed working, needs verification not build

The full assisted loop already ships in `awin-application-auto-approval`: resolve
brand, check `affiliate_list_actions` readiness, read the pending queue from the
API (never the dashboard), propose approve/decline/ask from the recorded
strategy, take one batch confirmation, then per decision emit the handoff, drive
Claude-in-Chrome, verify against the pending-queue URL, and record
`verified`/`verify_failed`.

What remains is not build, it is proof and hardening:
- Verify the advertiser pending-queue URL against a live Accelerate/Advanced
  tenant. It is still `TODO(verify)` in the emitter.
- Promote the advertiser adapter reads from `experimental` after a live
  acceptance test.
- Confirm the `mcp__Claude_in_Chrome__*` tool suite is present in the target
  client, and that the tenant is on a supported Awin plan.

### T2 Performance monitoring — do

`getProgrammePerformance` returns a pre-built per-publisher report. Skills exist
(`programme-performance-report`, `programme-anomaly-watch`,
`publisher-performance-review`). Work: cockpit `wow_swing` flag per brand wired
to a prompt that explains the swing, names the publishers behind it, and proposes
next steps. Read only, zero mutation risk.

### T3 Commission reconciliation — do

`listTransactions` carries status, age, and `declineReason`. Skills exist
(`chase-unpaid-commissions`, `programme-reversal-report`). Work: cockpit
`unpaid_over_threshold` and ageing flags, locker export of the rows, and a prompt
that hands Claude the reconciliation and any follow-up drafting. Read only.

### T4 Fraud review then validate/decline — the one real new build

Awin makes advertisers validate pending sales, and exposes no public write
endpoint for it. Rob's framing: find likely-fraudulent transactions first, then
plan the validate/decline. The workflow:

1. **Signal (read, API).** Pull pending and recently validated transactions:
   `affiliate_awin-advertiser_list_transactions({ brand, status: "pending" })`.
   Each row carries id, sale amount, commission, currency, publisher,
   `clickDate`, `transactionDate`, `validationDate`, `ageDays`, `declineReason`,
   landing `url`, `merchantKey`.
2. **Score (Claude, deterministic heuristics plus reasoning).** Surface
   suspected-fraud signals an AM checks before validating, each with its evidence
   and a confidence:
   - velocity spike: a publisher's pending count or value far above its own
     baseline (compare to a prior window via `get_programme_performance`);
   - order-value outliers well above the programme's normal basket;
   - implausible click-to-convert timing (near-zero, or a missing click),
     the classic cookie-stuffing/direct-linking tell;
   - duplicate clusters: repeated identical amounts or the same landing URL in a
     burst;
   - risky publisher history: a high historical reversal rate (reuse
     `programme-reversal-report`) on the same partner;
   - a new or unknown publisher driving sudden volume.
   Honesty rule, inherited from `programme-reversal-report`: never assert fraud
   from a single label or signal. Mark items "suspected" with the evidence, and
   default to **hold/ask** when uncertain. The human decides.
3. **Confirm (human, Tier-3).** Show two groups: the suspected set with evidence
   and a recommended decline/hold, and the clean set eligible for bulk validate.
   Resolve every ask, then take one explicit confirmation of the whole batch.
4. **Do (browser handoff, NEW).** Add a `validateTransaction` emitter
   (approve/decline a pending sale), batch-aware, mirroring the publisher-decision
   emitter: a constant Awin validation-queue URL, per-transaction non-secret
   inputs, the constraint floor (never touch payment or terms, stop on MFA, do
   not re-decide a settled transaction, confirm before submit), `mutates: true`,
   and a `verify` block that revisits the transaction and confirms the new
   status. A consumer skill drives Claude-in-Chrome per confirmed decision.
5. **Verify + audit.** Revisit the verify target, confirm approved/declined,
   record `verified`/`verify_failed`. Money-adjacent, so this waits on the
   persistent audit store and per-day consent caps.

T4 is the only task needing new domain code and a risk-based review: a new write
action (action-authority tier 3), a fraud-signal skill, a consumer skill, and the
audit-store/consent-cap dependency. The read-only fraud scan (steps 1 to 3) can
ship first with zero write risk.

### T5 Client reporting and QBR — do

Skills exist (`programme-performance-report`, `agency-portfolio-rollup`,
`client-onboarding`). Work: a cockpit "prep client report" button per brand that
hands Claude the brand, period, and skill to run. Reads plus Claude assembly.

### T6 Publisher recruitment — do

Renamed from outreach to recruitment. Drafting already exists: `partner-outreach`
writes recruitment and re-engagement copy grounded in real numbers and the
recorded strategy, and never sends. Supporting skills: `partner-roster-audit`
(dormant worklist), `publisher-performance-review` (partner numbers). Two gaps:
- **Discovery of prospects on the advertiser side.** `brand-application-shortlist`
  is publisher-side (brands to join). The advertiser analogue, finding publishers
  worth recruiting, has no directory read in the adapter; candidates come from
  performance gaps, roster audit, and operator-supplied context for now.
- **The recruit/invite action.** Awin has no comms or invite API, so an actual
  in-dashboard invite is a future browser handoff. For this pass, recruitment is
  discover-plus-draft; sending stays the operator's action, as the skill states.

### T7 Terms and commission changes — excluded

The constraint floor forbids changing commission, payout, or contract terms, and
these are high-regret. They remain a human action in the dashboard.

## Phasing and dependency order

**Phase 0: verify and decide (docs and discovery).**
- Verify the Awin advertiser pending-queue URL (T1) and, for T4, the
  validation-queue URL, against a live Accelerate/Advanced tenant. Replace the
  `TODO(verify)` constants.
- Write the T4 action-authority decision record: the new `validateTransaction`
  write, its tier, the persistent audit store, and per-day consent caps.

**Phase 1: the read surface (no new write risk).**
- Populate advertiser cockpit flags per configured brand: `pending_applications`
  (T1), `wow_swing` (T2), `unpaid_over_threshold` and ageing (T3), plus a
  suspected-fraud count (T4 read-only scan) and a "prep report" entry (T5).
- Wire each flag to its task-specific Claude prompt via `openClaudePrompt`.
- Extend the locker to advertiser brands.
- Acceptance: against a real Awin advertiser account, every flag computes and
  each button opens Claude with the right brand and period.

**Phase 2: T1 live acceptance.**
- Run the `awin-application-auto-approval` loop against a real pending applicant.
- Acceptance: an approve and a decline each close as `verified`, never
  `succeeded`; an MFA challenge cleanly stops and hands back. Promote the
  advertiser reads from `experimental`.

**Phase 3: T4 fraud scan (read-only half).**
- Ship the fraud-signal skill: pull pending transactions, score with the
  heuristics above, output the suspected and clean groups with evidence. No
  writes.
- Acceptance: on real data the scan flags plausible cases with traceable
  evidence and holds the uncertain ones.

**Phase 4: T4 validate/decline (the write half, gated).**
- Add the `validateTransaction` emitter and tool surface, the consumer skill, the
  persistent audit store, and per-day consent caps.
- Acceptance: a reviewed batch is validated/declined through the consumer with one
  confirmation, each decision individually verified, and the day's cap enforced.

**Phase 5: T6 recruitment doing (optional).**
- Advertiser-side prospect discovery and, if wanted, an in-dashboard invite
  handoff. Until then, recruitment is discover-plus-draft.

Phases 1 and 2 can run alongside Phase 3, which carries no write risk. Only
Phase 4 needs the maintainer's risk decision first.

## Decisions required from the maintainer

1. **T4 as a new write.** Approve the `validateTransaction` emitter and its
   tier-3 treatment, or keep T4 read-only (fraud scan that hands the AM a
   decline list to action by hand). Recommended: ship the read-only scan first
   regardless, decide the write after seeing it.
2. **Audit persistence and consent caps.** Approve building the persistent store
   behind `recordActionAudit` and per-day caps, which the T4 write depends on.
3. **Advertiser plan gating.** Confirm target tenants are on Awin Accelerate or
   Advanced (the advertiser API is gated) and accept the 20-calls-per-minute
   budget for the cockpit.
4. **Promotion gate.** Confirm the live acceptance test that promotes the
   advertiser reads from `experimental`.

## Deliberately excluded

- The desktop app driving a browser. It stays the surface and launcher; the
  consumer is a Claude skill.
- Commission, payout, terms, bonus, and tenancy changes (T7). Human-only.
- Sending recruitment messages through the dashboard, until the discover-plus-
  draft flow is proven and an invite handoff is deliberately added.
- Any model call or data interpretation inside the app shell.

## Risks

- **Selector and DOM brittleness** in the consumers. Mitigation: bounded `hints`
  per action beside each emitter; the consumer stays general.
- **Unverified URLs** misdirect the operator. Mitigation: verify against a live
  tenant in Phase 0 before relying on T1 or building T4's write.
- **False fraud positives** could decline legitimate commission. Mitigation: the
  suspected/clean split, evidence per flag, default-to-hold, and the mandatory
  human confirmation before any decline.
- **Rate limit** (20/min) can stall a multi-brand cockpit. Mitigation: the client
  already token-buckets; stagger reads and cache aggressively.

## The one metric that proves value

Share of emitted mutating handoffs that reach `verified`. If users abandon at the
confirm step, the prompt or the summary is wrong. If they reach `verified`, the
loop has measurably removed dashboard work. For T4, track the decline
false-positive rate as the safety counterpart.
