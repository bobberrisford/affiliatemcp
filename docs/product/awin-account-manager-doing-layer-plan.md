# Awin account-manager doing layer: automate and verify the agency AM job

> Status: proposal (planning). Owner decision required before implementation
> (see "Decisions required"). Scope: Awin only, advertiser-side first.
> Front end: the desktop app. Doing and reasoning: Claude.

## The outcome

An agency account manager who runs brand programmes on Awin should be able to
get through their day from one surface. The desktop app shows what needs
attention, computed locally with no model call and no tokens. One click hands
the task to Claude with the work pre-written. Claude reads the data, decides,
carries out the action (by API where Awin exposes one, by a guided browser
handoff where it does not), then verifies the result and records an honest audit
line. Nothing is claimed done until it has been checked.

The target cohort is the advertiser/agency AM: managing one or many brand
programmes, recruiting and vetting publishers, validating transactions, watching
performance, and reporting to clients.

## How the pieces fit: surface, decide, do, verify

The division of labour is fixed and the same for every task:

1. **Surface (desktop app, local).** The cockpit calls Awin read operations
   through the core facade and folds them into attention flags. No model, no
   tokens, no writes. Each flag carries a "do this in Claude" button.
2. **Decide (Claude).** The button deep-links into Claude via
   `claude://claude.ai/new?q=...` (web fallback `https://claude.ai/new?q=...`)
   with a task-specific prompt. The user reviews the prompt; it is never
   auto-submitted. Claude runs the Awin MCP tools to read and reason.
3. **Do (Claude).** Where Awin has a write API, Claude calls it and the server
   observes the outcome. Where Awin has no write API, the adapter emits a typed
   `BrowserHandoff`; a Claude-in-Chrome consumer carries it out against the
   user's own authenticated Awin session, honouring the shared constraint floor
   and confirm-before-submit.
4. **Verify (Claude).** The consumer revisits the handoff's `verify.url`, checks
   `verify.expect`, and reports back, closing the audit arc
   `handoff_emitted -> verified | verify_failed`. API writes close with
   `write_verified` after a re-read.

The desktop app is the launcher and the proof-of-attention surface. It never
drives a browser and never interprets data. All doing and all reasoning live in
Claude. This keeps the app a thin client of the shared core.

## What already exists (the substrate)

This plan is mostly wiring, not green-field. Confirmed in the codebase today:

- **Awin advertiser reads (API-backed), `claim_status: experimental`:**
  `listBrands`, `listTransactions`, `listMediaPartners`,
  `getProgrammePerformance`, and a synthetic `listProgrammes`
  (`src/networks/awin-advertiser/adapter.ts`). Read-only at v0.1; the client
  refuses non-GET.
- **Awin publisher reads (API-backed), `claim_status: production`:**
  `listProgrammes`, `getProgramme`, `listTransactions`, `getEarningsSummary`,
  deterministic `generateTrackingLink`, plus rich tools including commission
  groups, transaction queries and disputes, and performance reports
  (`src/networks/awin/`).
- **Write emitters (pure browser-handoff functions, no network call):**
  advertiser `approvePublisher` and `declinePublisher`
  (`src/networks/awin-advertiser/actions.ts`); publisher `applyToProgramme`
  (`src/networks/awin/actions.ts`). Each carries a constraint floor, `mutates`,
  and a structured `verify` block.
- **Emit and verify tool surface:**
  `affiliate_awin-advertiser_propose_publisher_decision` and
  `affiliate_awin-advertiser_report_publisher_decision_result`; the publisher
  equivalents `propose_application` and `report_application_result`.
- **Audit vocabulary, fixed before its consumers exist** (`src/shared/audit.ts`):
  `handoff_emitted`, `verified`, `verify_failed`, `write_dispatched`,
  `write_verified`, `write_unknown`, `write_denied`, `write_rejected`. The rule
  that `succeeded` is never recorded for a handoff is already enforced. Storage
  is stderr only today; a persistent store can sit behind `recordActionAudit`
  later.
- **Constraint floor** (`src/shared/browser-handoff.ts`): payment/payout never
  touched, stop on login/MFA, no repeat of a completed mutation, summarise and
  confirm before submitting, never accept unseen terms.
- **Desktop facade reads** (`src/core/facade.ts`): `listConfiguredNetworks`,
  `getEarnings`, `listTransactions`, `getProgrammePerformance`, all returning
  `DataResult<T>` over IPC; `computeCockpit` for local attention flags.
- **Cockpit flags already scaffolded** (`src/core/cockpit.ts`):
  `unpaid_over_threshold`, `wow_swing`, `pending_applications`, `health`.
- **The front-end to Claude seam** (`desktop/main.js`, `desktop/preload.js`):
  `openClaudePrompt(text)` builds `claude://claude.ai/new?q=...`, reviewed not
  auto-sent, 14k character cap, web fallback. The data locker and cockpit
  screens already use it.

## The gap (what is actually missing)

1. **The consumer.** Nothing drives Claude-in-Chrome to execute a
   `BrowserHandoff`. Today every handoff degrades to guided manual steps the
   user follows by hand. This is the single highest-value missing piece.
2. **The verify loop, exercised.** The report-back tools exist but nothing
   automatically revisits `verify.url` and records `verified` / `verify_failed`.
   Verification is what converts an emitted plan into trustworthy done-ness.
3. **Awin-specific cockpit population.** The flag kinds exist; the advertiser-AM
   flags (pending publishers, ageing pending transactions, performance swings
   per brand) need to be computed and wired to the right Claude prompts.
4. **Transaction validation has no emitter.** Approving or declining pending
   sales in the validation queue is a top AM task with no Awin write API and no
   handoff builder yet.
5. **Unverified advertiser URLs.** The pending-publishers queue URL in the
   approve/decline emitters is `TODO(verify)` against a live Accelerate or
   Advanced tenant.
6. **No persistent audit store or consent caps.** Deliberately deferred; needed
   before unattended or batched writes.

## The top AM tasks, ranked, with the build picture

Ranked by frequency times pain times safety-of-automating, against what already
exists. Channel is chosen per task by whether Awin exposes a write API, not by
preference.

| # | Task | Frequency | Read channel | Do channel | Build status |
|---|------|-----------|--------------|------------|--------------|
| T1 | Approve/decline pending publisher applications | Daily/weekly, high volume | UI queue only (no API list) | Browser handoff (emitters exist) | Needs consumer + verify + cockpit flag |
| T2 | Monitor programme performance, spot anomalies | Daily | `getProgrammePerformance` (API) | Read + Claude analysis | Needs cockpit swing flag + prompt |
| T3 | Reconcile commissions: pending, ageing, reversed | Ongoing | `listTransactions` (API) | Read + Claude analysis | Mostly assembly (locker + cockpit) |
| T4 | Validate pending transactions (approve/decline sales) | Weekly/monthly, high volume | `listTransactions(status=pending)` (API) | Browser handoff (no emitter yet) | New emitter + careful gating |
| T5 | Client reporting and QBR prep | Weekly to quarterly | Reads (API) | Claude skills (exist) | Assembly + "prep report" button |
| T6 | Publisher outreach and relationship management | Ongoing | `listMediaPartners`, performance (API) | Draft in Claude now; send later | Drafting only; sending out of scope for now |
| T7 | Commission/terms/bonus/tenancy changes | Occasional, high risk | n/a | Excluded | Keep human; constraint floor forbids |

### Per-task detail

**T1 Publisher applications.** Awin exposes no API to list or decide
applications. The AM sees the pending queue in the dashboard. Plan: cockpit
`pending_applications` flag (count per brand) links into Claude; Claude reads
`listMediaPartners` to give context, then for each decision emits
`approvePublisher` / `declinePublisher`; the consumer carries it out with
confirm-before-submit and verifies against the pending-queue URL. Note the
constraint floor stops the flow if approval would require setting commission or
contract terms, which is correct: terms are a human decision.

**T2 Performance monitoring.** `getProgrammePerformance` returns a pre-built
per-publisher report (impressions, clicks, conversions, commission, sale value).
Plan: cockpit `wow_swing` flag per brand; the button hands Claude a prompt to
explain the swing, name the publishers behind it, and propose next steps. Read
only, zero mutation risk, high daily value.

**T3 Commission reconciliation.** `listTransactions` carries status
(`pending`, `approved`, `reversed`, `paid`), age, and `declineReason`. Plan:
cockpit `unpaid_over_threshold` and ageing flags; the locker exports the rows;
Claude interprets and drafts any follow-up. Read only.

**T4 Transaction validation.** Awin advertisers validate pending sales, often on
a schedule, and Awin has no public write endpoint for it. Plan: a new
`validateTransaction` (approve/decline) browser-handoff emitter mirroring the
publisher-decision emitter, batch-aware so a verified set of pending sales can be
confirmed in one reviewed summary. This is money-adjacent, so it inherits write
authority tier 3, the confirm-before-submit floor, and per-decision verify, and
should wait for the persistent audit store and consent caps.

**T5 Client reporting and QBR.** The skills already exist
(`programme-performance-report`, `agency-portfolio-rollup`). Plan: a cockpit
"prep client report" button per brand that hands Claude the brand, the period,
and the skill to run. Reads plus Claude assembly.

**T6 Outreach.** Drafting messages in Claude is safe and useful now. Actually
sending through the Awin dashboard is a brittle browser handoff and is out of
scope until the consumer and verify loop are proven on T1.

**T7 Terms and commission changes.** Explicitly excluded. The constraint floor
forbids changing commission, payout, or contract terms, and these are
high-regret. They stay a human action in the dashboard.

## Phasing and dependency order

Each phase is independently coherent and shippable. Land in order.

**Phase 0: decision and verification (docs and discovery).**
- Confirm scope and channel choices with the maintainer (see "Decisions
  required").
- Verify the advertiser pending-queue URL and the publisher pending-applications
  URL against a live Accelerate/Advanced tenant. Replace the `TODO(verify)`
  constants.
- Write the consumer decision record: how the Claude-in-Chrome consumer reads a
  `BrowserHandoff`, enforces the floor, confirms before submit, and reports back.
  This is the risk-based review item flagged in the browser-handoff contract.

**Phase 1: read surface for the AM (no new write risk).**
- Populate cockpit flags for the advertiser side: `pending_applications`,
  `wow_swing`, `unpaid_over_threshold`, `health`, per configured brand.
- Wire each flag to a task-specific Claude prompt via `openClaudePrompt`.
- Extend the locker to advertiser brands (it already calls the facade reads).
- Acceptance: against a real Awin advertiser account, every flag computes
  correctly and each button opens Claude with the right brand and period.

**Phase 2: the consumer and the verify loop (the doing layer).**
- Build the general Claude-in-Chrome consumer skill: read `BrowserHandoff`,
  enforce the constraint floor, summarise and confirm, drive the user's session,
  revisit `verify.url`, and call the report-back tool to record
  `verified` / `verify_failed`.
- Prove it on T1 (approve/decline publisher) end to end, since those emitters
  already exist.
- Acceptance: a real pending publisher is approved through the loop and the
  audit trail shows `handoff_emitted` then `verified`, never `succeeded`. A
  decline is verified the same way. A login/MFA challenge cleanly stops and
  hands back.

**Phase 3: transaction validation (new emitter, gated).**
- Add the `validateTransaction` emitter (batch-aware) and its tool surface.
- Add the persistent audit store and per-day consent caps before enabling it.
- Acceptance: a reviewed set of pending sales is validated through the consumer
  with one confirmation, each decision individually verified, and the day's cap
  enforced.

**Phase 4: reporting and outreach assembly.**
- Cockpit "prep client report" and "draft outreach" buttons wired to the
  existing skills.
- Acceptance: a QBR draft and an outreach draft are produced from real data with
  no manual data wrangling.

## Decisions required from the maintainer

1. **Consumer surface.** Commit to Claude-in-Chrome as the primary driver for
   Awin handoffs. It rides the user's authenticated session, so it solves
   login and MFA for free and adds no credential-storage surface. The emitters
   and verify contract stay driver-agnostic, so the consumer is swappable later.
2. **Transaction validation as a new write.** Approve T4's new emitter and its
   tier-3 treatment, or defer it. It is money-adjacent and needs the audit store
   and consent caps first.
3. **Audit persistence and consent caps.** Approve building the persistent store
   behind `recordActionAudit` and per-day caps, which T4 depends on.
4. **Advertiser plan gating.** Awin's advertiser API is limited to Accelerate
   and Advanced plans and capped at 20 calls per minute per user. Confirm the
   target tenants are on a supported plan and accept the cockpit's rate budget.
5. **Promotion gate.** The advertiser adapter is `experimental`. Confirm the
   live acceptance test that would promote the reads consumed here.

## Deliberately excluded

- The desktop app driving a browser. It stays the surface and the launcher; the
  consumer is a Claude skill.
- Commission, payout, terms, bonus, and tenancy changes. Human-only.
- Sending outreach through the dashboard, until the consumer and verify loop are
  proven on T1.
- Any model call or data interpretation inside the app shell. Analysis is
  Claude's job.

## Risks

- **Selector and DOM brittleness** in the consumer. Mitigation: bounded `hints`
  per action maintained beside each emitter; the consumer stays general.
- **Unverified URLs** would point the operator at the wrong page. Mitigation:
  verify against a live tenant in Phase 0 before any consumer work.
- **Rate limit** (20/min) can stall a multi-brand cockpit. Mitigation: the
  client already token-buckets; stagger cockpit reads and cache aggressively.
- **Single-consumer dependency.** Mitigation: invest in emitter coverage and
  verify semantics, which are durable; keep the consumer thin and replaceable.

## The one metric that proves value

Share of emitted mutating handoffs that reach `verified`. If users abandon at
the confirm step, the prompt or the summary is wrong. If they reach `verified`,
the loop has measurably removed dashboard work. This number decides when to widen
the task set beyond T1.
