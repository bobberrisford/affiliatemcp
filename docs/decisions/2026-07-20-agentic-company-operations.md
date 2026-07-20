# Prepare-and-approve agentic company operations

- **Date:** 2026-07-20
- **Status:** Proposed (2026-07-20). Awaiting Rob's deliberate acceptance. The
  operating model below (prepare-and-approve, all four functions, one daily
  brief) reflects Rob's answers given in-session on 2026-07-20; this record
  captures those answers as a reviewable decision, it does not pre-authorise the
  implementation PRs.
- **Affects:** the repo-local coding-agent workflow layer (`.claude/skills/`,
  and its Codex mirror `.agents/skills/`), a new operations trail (`ops/`), the
  scheduled-routine surface used to run recurring agentic work (the same
  mechanism behind the existing `weekly-hosted-plg-launch` routine), and the
  outbound channels the operator connects (LinkedIn via Buffer, a support inbox
  via Gmail, GitHub issues and pull requests). It does not affect the product's
  runtime, the MCP tool surface, the adapter contract, or any hosted service
  code.
- **Builds on:** [`2026-06-26-rob-led-delivery-system.md`](./2026-06-26-rob-led-delivery-system.md)
  (accepted; agents may implement, validate, review, push, and recommend, but
  must not merge, post, or send without Rob's explicit instruction; this record
  extends that same authority boundary from code delivery to company
  operations), [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
  (accepted; the custody posture the operations layer must not weaken), and
  [`2026-06-13-privacy-first-telemetry.md`](./2026-06-13-privacy-first-telemetry.md)
  (accepted; the privacy contract the operations layer must not exceed).
- **Relates to:** `docs/product/hosted-plg-workstream.md` (the weekly launch
  loop this generalises), `docs/product/solo-50k-revenue-plan.md` (the no-sales,
  no-support-desk operating model this implements: "the product must acquire,
  convert, onboard, support, and retain customers without the operator in the
  loop"), and `docs/product/phase-0-go-live-checklist.md` (the precedent that
  account creation, secret custody, and publishing stay with Rob).

## User outcome

The operator runs the company by reading one daily brief and approving prepared
work, instead of doing the acquisition, onboarding, marketing, and support work
by hand. Every outward-facing action arrives as a ready-to-send draft; the
operator's only recurring job is to read feedback, approve what is right, and
decide what changes. Prospects, customers, and contributors get timely,
grounded, on-brand responses without the single operator being a bottleneck.

## Review request

- Mode: `decision`
- Decision required: accept the prepare-and-approve operations model, its scope
  (orchestration spine plus marketing, customer service, and onboarding loops),
  and its authority boundary (nothing sends, posts, or merges without one
  explicit approval), so the dependent implementation PRs may begin.
- Reviewer focus: the authority boundary and its enforcement; that the model
  weakens no custody or privacy contract; that "find users" stays within the
  accepted organic motion; and the conditions under which any channel could
  later be promoted to auto-send.

## Context

`affiliate-mcp` is operated by one person alongside a day job. The accepted
revenue plan is explicit that the product "must acquire, convert, onboard,
support, and retain customers without the operator in the loop", because
anything that needs a human conversation to close or keep a customer is out of
scope for a no-sales, no-support-desk business.

The pieces already exist but are run by hand:

- a live hosted service with a weekly digest cron;
- 18 skills covering earnings, QBR, anomaly, onboarding, outreach, and setup
  help, several already authored to run on a schedule
  (`skills/programme-anomaly-watch`);
- a defined weekly growth loop: the `weekly-hosted-plg-launch` routine drafts a
  LinkedIn card and post each week as a draft pull request and, in its own
  words, "never merges or posts";
- GitHub issue templates as the structured feedback channel.

What is missing is not capability but orchestration: a scheduled layer that runs
these loops daily, prepares their output, and surfaces the whole company's
pending work and inbound feedback in one place. The open question is how much
authority that layer should have. Full autonomy over outward-facing actions
would contradict the accepted Rob-led delivery model, the custody and privacy
contracts, and the launch guardrail that publishing is always the operator's
decision, and it would expose the project to spam, platform-terms, and
reputation risk when strangers are on the receiving end. A decision is needed
before any of the implementation work begins.

## Decision

Adopt a **prepare-and-approve** operations model. A small scheduled operations
layer prepares the company's recurring work and surfaces it for one-tap
approval. Nothing it prepares sends, posts, or merges on its own.

### The authority boundary

- The operations layer may **read** (GitHub, the hosted service's own
  subscriber enumeration, connected inboxes and channels), **reason**, and
  **prepare drafts**.
- Every outward-facing action is queued as a draft in the system that already
  owns it and requires one explicit human approval to go out:
  - social and content posts as **Buffer drafts** (never queued or published by
    the agent);
  - customer, prospect, and onboarding email as **Gmail drafts** (never sent by
    the agent);
  - code, documentation, and marketing-copy changes as **draft pull requests**
    (never merged by the agent, per the Rob-led delivery model).
- This is the same authority boundary the delivery-system decision already sets
  for code, extended to every company function. It does not grant any new
  send, post, or merge authority.

### Scope: four functions on one spine

1. **Orchestration spine and daily brief.** A repo-local `company-ops` workflow
   and a durable run trail (`ops/`). Once per day a scheduled routine gathers
   pending approvals across GitHub, Buffer, and Gmail, new and updated feedback
   (GitHub issues, the support inbox), and headline metrics, and assembles a
   single **daily brief** for the operator: approvals waiting, feedback
   received, metrics, and what shipped since yesterday.
2. **Customer service.** Triage new and updated GitHub issues and the hosted
   support inbox; draft grounded replies from `docs/`, `docs/findings/`,
   `REPORT.md`, and the setup-help skill; propose triage labels; escalate
   anything ambiguous, upset, or novel into the brief rather than drafting a
   confident answer.
3. **Onboarding.** For new hosted sign-ups, prepare a guided first-value report
   and an activation nudge as drafts, plus a dormant re-engagement sequence,
   reusing the digest compose path rather than building any new data egress.
4. **Marketing and finding users.** Generalise the weekly launch loop so it
   prepares the weekly branded card and post as Buffer drafts, plus directory
   and registry listing submissions and free lead-magnet content. The
   acquisition motion stays the accepted organic one.

### What "finding users" means here

The acquisition motion is the accepted organic engine from the revenue plan:
the weekly content cadence, directory and registry listings, and free
lead-magnet tools. This record does not authorise paid advertising, cold-outreach
blasts, scraping, or the purchase of contact lists. Those were deliberately
refused in the revenue plan and remain refused.

### Where it runs, and what stays with Rob

The layer runs on the environment's scheduled routines, the same mechanism the
weekly launch loop already uses. Connecting the real LinkedIn/Buffer account and
the support inbox, custody of any secret, billing, deploys, creating the
scheduled routines, and every approval remain the operator's, exactly as the
phase-0 checklist already draws the line. The agent prepares; Rob connects,
approves, and merges.

### Custody and privacy

The operations layer moves no credentials and no affiliate data to any new
place. Support and onboarding drafts must never contain another user's
affiliate data, and marketing artefacts keep the existing launch guardrail:
never present invented figures as real client data. Telemetry stays opt-in and
aggregate-only. `PRIVACY.md` and the custody record hold verbatim.

### Raising autonomy later

Prepare-and-approve is the launch model, not a permanent ceiling. A specific
channel may later be promoted to auto-send (for example, applying an
uncontested triage label, or sending a templated first-value email to a user
who just signed up) only through its own decision record that names the channel,
the guardrails, the reversal path, and the evidence that justified it. Until
such a record is accepted, every channel stays prepare-and-approve.

## Rejected alternatives

- **Full autonomy over outward-facing actions.** Let the layer post, email,
  reply, and merge without the operator. Rejected: it contradicts the accepted
  Rob-led delivery model and the launch guardrail that publishing is the
  operator's decision, and it puts unreviewed messages in front of strangers
  with real spam, platform-terms, and reputation exposure. It is also premature:
  there is no evidence yet that the prepared drafts are reliably correct. This is
  the destination the ramp path can move toward per channel, with evidence, not
  the starting point.
- **Tiered auto-send from day one.** Auto-send low-risk channels (issue labels,
  onboarding email to opted-in sign-ups) while gating high-risk ones. A
  reasonable next step, but rejected as the starting model: it needs per-channel
  guardrails and reversal paths that only make sense once the prepare-and-approve
  drafts have a track record. It is folded into the "raising autonomy later"
  ramp instead.
- **A bespoke approvals dashboard.** Build a new store and UI for the pending
  queue. Rejected: Buffer, Gmail, and GitHub already own the drafts and their
  approval gestures; a new store would duplicate state and add a surface to
  maintain. The daily brief links into those systems instead.
- **Keep everything manual.** Rejected: it is the current state, and it makes the
  single operator the bottleneck the revenue plan says the business cannot
  afford.

## Consequences and implementation follow-ups

- **Dependent implementation PRs**, in dependency order:
  1. this decision record;
  2. orchestration spine plus daily brief, shipped with customer-service triage
     as its first real consumer;
  3. the customer-service loop;
  4. the onboarding loop;
  5. the marketing and find-users loop;
  6. an end-to-end integration proof.
- **Merge order and lanes:** this record is the single active-risk PR and must
  be accepted before any dependent PR merges. The dependent PRs are routine,
  decision-complete work in disjoint domains and respect the two-lane limit.
- **Public contracts affected:** none. No change to the MCP tool surface, the
  adapter contract, hosted service behaviour, pricing, or telemetry. The change
  is confined to the coding-agent workflow layer, a new `ops/` trail, and the
  operator's connected channels.
- **Risks and failure modes:** a draft that is wrong or off-brand reaching the
  operator (mitigated by grounding drafts in the docs and by the escalate-when-
  unsure rule); leakage of one user's data into another's draft (mitigated by
  the custody rule and per-loop review); the daily brief becoming noise
  (mitigated by keeping it to approvals, feedback, metrics, and what shipped);
  and scope creep toward auto-send (mitigated by requiring a per-channel decision
  record to promote any channel).
- **Deliberately out of scope:** any auto-send or auto-merge; new product MCP
  tools or any expansion of the advertiser write surface; paid acquisition and
  cold outreach; account creation, secret custody, billing, and deploys; and any
  Team-tier or hosted-service code change.

## Verification

- [x] Decision record added under `docs/decisions/`
- [x] Production foundations and dependent implementation have not started
- [x] Any discovery prototype is explicitly disposable and cannot be promoted
- Evidence or prototypes reviewed: the existing `weekly-hosted-plg-launch`
  routine and the launch bundles under `docs/product/launches/` demonstrate the
  prepare-and-approve shape already working for one function per week; this
  record generalises that proven shape rather than introducing an untried one.

## Agent self-review

- Complete diff inspected: this record is documentation only; a docs-only diff
  confirmed before commit.
- Remaining uncertainty: the onboarding loop depends on a safe read path to the
  hosted sign-up signal; if none beyond the weekly-digest subscriber list exists
  yet, that loop starts partial and is noted as such in its own PR.
- Optional delivery-system learning: none for this record; the model deliberately
  reuses the existing delivery authority boundary rather than inventing a new one.
