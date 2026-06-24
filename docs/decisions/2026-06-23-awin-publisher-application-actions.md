# Awin publisher application actions: write-gated browser approve and decline

- **Date:** 2026-06-23
- **Status:** Proposed
- **Affects:** `src/networks/awin-advertiser/` (adapter, action descriptors,
  tools), `src/shared/types.ts` (the `BrowserHandoff`/`ApiGapResponse` contract
  and the shared constraint floor), the consent/audit primitive (the
  `handoff_emitted` event and per-day cap), action-map wiring in the MCP tool
  layer, and a first consumer skill driving Claude in Chrome
- **Depends on:** the accepted browser-handoff contract
  ([`2026-06-12-browser-handoff-contract.md`](./2026-06-12-browser-handoff-contract.md)),
  the accepted action-authority layer
  ([`2026-06-12-action-authority-layer.md`](./2026-06-12-action-authority-layer.md)),
  and the accepted action capability map
  ([`2026-06-18-action-capability-map.md`](./2026-06-18-action-capability-map.md)).

## Context

An Awin advertiser, brand, or agency reviews publisher applications to its
programme and approves or declines each one. Awin's advertiser API does not
expose an approve or decline endpoint for a pending publisher application; that
decision is made in the Awin advertiser dashboard. The `awin-advertiser` adapter
is read-only by construction: its HTTP client refuses any non-GET method before
any wire I/O (`src/networks/awin-advertiser/client.ts`), and its `network.json`
records the read-only guard and the absence of write surfaces. There is no API
route to approve or decline a publisher, so execution can only be a browser
action against the operator's own authenticated Awin session.

`AGENTS.md` keeps advertiser-side adapters read-oriented unless an accepted
decision explicitly defines a safe write contract. This record defines that
contract for two publisher-application actions, and it authorises the first
browser-handoff emitter and the first browser consumer skill in the repository.
Both ride the already-accepted foundations: the browser-handoff contract fixes
the typed `ApiGapResponse`/`BrowserHandoff` shape, the constraint floor, and the
`handoff_emitted` audit semantics; the action-authority layer fixes the Tier 0
to Tier 3 model in which writes fail closed to Tier 3 and enforcement is code,
not prompt; the action capability map fixes the channel, effect, and
default-authority-tier classification, under which a browser handoff for a write
inherits the same gate as the equivalent API write.

A note on sequencing the reader should not be surprised by: the browser-handoff
contract named Impact `applyToProgram` as the reference first emitter. That
emitter never shipped. The foundation PR below lands the shared types and the
constraint floor without the Impact reference, and the Awin approve and decline
emitter is the first concrete emitter in the repository.

## Decision

### 1. Two stable action ids, write effect, Tier 3 by default

The adapter declares exactly two doing-surface actions, with immutable,
network-scoped identifiers from the moment they ship:

- `awin-advertiser.approvePublisher`
- `awin-advertiser.declinePublisher`

Each carries, under the action capability map's three orthogonal
classifications:

- `channel: browser`: the adapter returns the typed handoff; this repository
  does not open, control, or observe a browser as part of emission.
- `effect: write`: the represented operation approves or declines a publisher
  application, changing network state.
- `defaultAuthorityTier: 3`: a write fails closed to Tier 3 and waits for human
  sign-off. No accepted policy engine exists to return Tier 2, so Tier 3 is the
  operative tier.

The browser channel never weakens the gate. These two actions inherit the same
effect, default authority tier, consent floor, and audit obligations that the
equivalent API write would carry if Awin exposed one. Pure emission of a handoff
is not permission to execute the represented decision.

### 2. The Awin `BrowserHandoff` shape

The emitter produces one `BrowserHandoff` per applicant decision, in the shared
shape fixed by the browser-handoff contract:

- `goal`: plain English, naming the publisher and the decision, for example
  "Approve publisher Acme Media (id 4567) for the Example Brand programme on
  Awin" or the decline equivalent.
- `startingUrl`: a reviewed, Awin-owned advertiser dashboard path for the
  pending-partner queue, confirmed by the live verification below to be
  `https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all` (the
  "Pending partners" section), account-scoped by `advertiserId` (the resolved
  `networkBrandId`). It is selected by reviewed adapter code, never supplied by
  the caller or the model. The earlier guessed
  `https://ui.awin.com/...publishers/pending` path was wrong: that origin is the
  legacy "Awin Classic" UI, which has no equivalent queue (see Live verification
  below).
- `inputs`: `{ publisherId, publisherName, decision: 'approve' | 'decline',
  brand, programmeId, declineReason? }`. All values are JSON-serialisable. The
  payload carries no secrets, tokens, cookies, or session material.
- `constraints`: the shared default floor inherited from the browser-handoff
  contract (no payment or payout changes; stop and hand back on any login, MFA,
  or re-authentication challenge; do not repeat a mutation that already appears
  completed; show a summary and wait for explicit confirmation before submitting
  when `mutates` is true; never accept terms or consents the user has not seen),
  plus Awin-specific additions:
  - operate only on the named `publisherId`;
  - stop if the application row is not in the pending state;
  - do not change commission, payout, or contract terms;
  - if approval requires setting commission or contract terms, stop and hand
    back to the operator rather than choosing terms.
- `mutates: true`: the flow submits a decision, so confirm-before-submit is
  forced.
- `verify`: `{ url: <pending-partner queue url on app.awin.com>, expect:
  "publisher no longer in the pending queue; status reads approved or declined"
  }`.

The emitter wraps this handoff in an `ApiGapResponse` with `kind: 'api-gap'`,
`reason: "Awin has no public publisher approve/decline endpoint"`, a verbatim
`userMessage` for the calling agent to show the operator, and the payload under
`browserFallback`. An API gap is an expected, documented condition, not a
failure; it is returned, never thrown, and never travels through
`NetworkErrorEnvelope`. An actual Awin outage during any operation still
surfaces through the envelope as normal.

The emitter is pure: a side-effect-free function from typed input to
`ApiGapResponse`, with no `fetch`, session, DOM, or retries. It does not lift the
read-only guard in `client.ts`, because it makes no network call.

### 3. Consumer authorisation: one skill, one per-batch human confirmation

This record authorises exactly one consumer skill, driving Claude in Chrome, for
these two action ids and no others. The pending-application queue is read from
the dashboard by the consumer skill, not from the API: live verification (below)
confirmed Awin's advertiser API exposes no pending-application queue, so the
skill reads the pending rows from the new-UI "Pending partners" section and the
adapter only emits the typed handoff per decision. The skill is gated by a single
per-batch human confirmation: the operator reviews the proposed set of approve
and decline decisions and confirms once for the batch. That single confirmation satisfies
the Tier 3 human sign-off for the batch. The per-submit safety floor still
applies on every individual submission: the consumer respects the constraint
floor on each row, stops on a non-pending row, and stops and hands back on any
login or MFA challenge.

This record does not authorise unattended or scheduled execution. Running these
actions without a human present needs the Phase 1 and Phase 2 authority policy
engine from the action-authority layer, which is not built; until it is accepted
and implemented, every batch requires the per-batch human confirmation.

### 4. Strategy and KPI inputs are advisory only

`Strategy.md` and `KPI.md`, read through `affiliate_get_client_strategy`, may
shape which publishers the skill proposes to approve or decline. They never
authorise a write. Where strategy is silent on an applicant, or a KPI line fails
to parse, the skill asks the operator and never guesses. This matches the
client-strategy decision: strategy and KPI files are advisory and never the
authority boundary.

### 5. Audit

The audit trail uses the vocabulary fixed by the browser-handoff contract:

- `handoff_emitted` is recorded for each emitted decision when the
  `ApiGapResponse` with a non-null `browserFallback` is returned through the tool
  layer. A mutating handoff counts against the per-day consent cap, the
  conservative basis already established: a handoff that may have mutated state
  consumes the day's allowance.
- The closing events `verified` or `verify_failed` are recorded from the
  consumer's report-back against the structured `verify` block, completing the
  arc `handoff_emitted -> verified | verify_failed`.
- No code path records `succeeded` or `applied` for a handoff. `succeeded` is
  reserved for outcomes the server itself observed, and the server does not
  observe the dashboard mutation.

`publisherId` folds into the audit `summary` text; it does not introduce a new
audit field.

## Security

- Emission is pure and read-only on the world: a pure emitter cannot mutate Awin
  state, so this contract adds no new write path to the server, and the
  `client.ts` read-only guard is untouched.
- Mutation risk lives in the consumer skill, which drives the browser under the
  per-batch human confirmation and the per-submit constraint floor. The
  `mutates: true` flag forces confirm-before-submit; the floor stops the flow on
  login, MFA, payment, or non-pending-row conditions.
- The handoff payload never carries credentials, session tokens, cookies, or
  account secrets. `inputs` is limited to the non-secret values the decision
  needs.
- `startingUrl` is selected by reviewed adapter code from the Awin-owned
  `https://app.awin.com` origin and a bounded, account-scoped path; callers and
  models cannot supply an arbitrary navigation target.
- Audit honesty is a security property: recording `succeeded` for an unobserved
  dashboard outcome would overstate what was done on the operator's behalf.
  `handoff_emitted` plus consumer-reported `verified`/`verify_failed` keeps the
  trail truthful.

This decision touches a shared and public contract, an action-execution and
write surface, the consent and audit primitive, browser framing, and the first
browser consumer, so it is a risk-based review item for `@offmann`.

## Rejected alternatives

- **Unattended or scheduled auto-approve without a per-batch gate.** Needs the
  unbuilt Phase 1/Phase 2 policy engine and violates the Tier 3 fail-closed
  default and the confirm-before-submit floor. Rejected.
- **One confirmation per applicant (N confirmations for a batch).** Unusable for
  the common case of reviewing many pending applications at once; it defeats the
  workflow. Rejected in favour of one per-batch confirmation that satisfies the
  Tier 3 gate once while the per-submit floor still applies to every row.
- **Making `Strategy.md` or `KPI.md` authoritative for the decision.** Strategy
  and KPI files are advisory by accepted decision; letting them authorise a
  write would move the authority boundary into a file the model shapes. Rejected.
- **Attempting an API write.** Awin exposes no publisher approve or decline
  endpoint, and the `awin-advertiser` client refuses any non-GET method.
  Rejected; the only honest route is the browser handoff.
- **Emitting the handoff from the skill without the typed `ApiGapResponse`.**
  Bypasses the shared contract, the constraint floor, the consumer boundary, and
  the `handoff_emitted` audit semantics. Rejected; the adapter emits the typed
  response and the skill consumes it.
- **Maintaining two parallel UI flows (new Awin UI and legacy Awin Classic).**
  Live verification found Awin accounts split across the new `app.awin.com` UI
  and the legacy `ui.awin.com` "Awin Classic" UI, which has no equivalent
  pending-applications queue, and deep-linking a Classic account to the new-UI
  URL OIDC-redirects back to `ui.awin.com`. Building and maintaining a second
  Classic flow is fragile and doubles the browser surface. Rejected; this feature
  supports new-UI accounts only, and legacy-account mapping is a separate future
  effort.

## Live verification (2026-06-24)

A live dry run against a real Awin advertiser account (API key authenticated, two
advertiser accounts visible) produced three findings that change the design.
They are recorded here as they were observed.

1. **The API has no pending-application queue.** `GET
   /advertisers/{id}/publishers/` returns only joined publishers and carries no
   status or relationship field, so a pending publisher application cannot be
   read from the API at all. Consequence: the pending queue is read from the
   dashboard by the consumer skill, not from the API. The two write action ids
   (`awin-advertiser.approvePublisher`, `awin-advertiser.declinePublisher`) and
   the Tier 3 assisted-batch gate are unchanged.

2. **The real `startingUrl`.** The pending queue and the approve (green tick) and
   decline (red cross) controls live in the new Awin UI at
   `https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`,
   under the "Pending partners" section, account-scoped by `advertiserId` (the
   resolved `networkBrandId`). This replaces the earlier guessed
   `https://ui.awin.com/...publishers/pending` path. Each pending row exposes the
   publisher name, publisher id, website, primary promotional type, and primary
   sector: the signals the advisory strategy is matched against.

3. **UI generation is not uniform across accounts (scope limit).** Some
   advertiser accounts are on the new UI (`app.awin.com`); others are on the
   legacy "Awin Classic" UI (`ui.awin.com`), which has no equivalent
   pending-applications queue. Deep-linking a Classic account to the
   `app.awin.com` URL OIDC-redirects back to `ui.awin.com`. Decision: this
   feature supports new-UI accounts only. The consumer skill must detect the
   generation (if navigation lands on `ui.awin.com` the account is Classic) and
   stop with a clean "this account is on Awin Classic; automated approval is not
   supported for it yet" message. Legacy-account mapping is a separate future
   effort, not part of this contract.

A pre-existing adapter bug surfaced during this run and is fixed in the emitter
PR: the live `/accounts` response uses `accountType` while the adapter read
`type`, so advertiser accounts were invisible until corrected.

A full end-to-end click-test was then run against a real advertiser account: one
pending applicant (a sub-network) was declined successfully, and the dashboard
confirmed the row left the "Pending partners" queue afterwards. That run
produced four further operational facts that the consumer skill must honour.

4. **Account context must be switched first.** Deep-linking
   `https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all` does
   not switch accounts; the app serves the session's currently-active account and
   OIDC-redirects otherwise. The consumer must activate the target advertiser
   account in the session before loading the queue, rather than relying on the
   account id in the URL to scope the view.

5. **Decline requires a reason.** The decline flow opens a panel with a required
   reason dropdown drawn from a fixed Awin list (for example "Website doesn't
   align with our brand or audience", "Website content isn't relevant to our
   brand", "Publisher profile is incomplete") before the "Decline partner" submit
   control enables. The consumer maps the decline rationale to the closest listed
   reason; it never invents or free-types a reason. Approve has not yet been
   exercised live and may differ; its panel and required fields remain unverified.

6. **Applicant-website vetting is part of the decision.** Before proposing
   approve or decline, the consumer visits each applicant's website to verify
   what it actually does and whether it fits, rather than relying on the
   dashboard's promotional-type and sector labels alone. This is advisory input
   to the proposal, consistent with the advisory-only strategy boundary in
   section 4; it never authorises a write and never substitutes for the per-batch
   human confirmation.

7. **Interstitials.** The flow must dismiss the cookie banner (decline
   non-essential cookies), the "Welcome to your new Awin" modal, and any
   feedback-survey popup before the queue and the decline controls are reliably
   reachable.

## Consequences

- The `awin-advertiser` adapter gains its first non-read actions, both
  browser-channel writes, without lifting the `client.ts` read-only guard,
  because emission makes no network call.
- The action capability map gains two `channel: browser`, `effect: write`,
  `defaultAuthorityTier: 3` entries bound to the stable identifiers
  `awin-advertiser.approvePublisher` and `awin-advertiser.declinePublisher`.
- The repository ships its first browser-handoff emitter and its first browser
  consumer skill, both behind the per-batch human gate; unattended execution
  remains blocked on the unbuilt authority policy engine.
- The audit trail records `handoff_emitted` per decision and closes on
  consumer-reported `verified`/`verify_failed`; mutating handoffs draw down the
  per-day consent cap.
- The `startingUrl` and the pending-partner queue path are confirmed by the live
  verification below against a real advertiser account
  (`https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`),
  so the `// TODO(verify)` marker is resolved for new-UI accounts. Legacy "Awin
  Classic" accounts are out of scope and the consumer skill detects and stops on
  them.

## Implementation follow-ups

Sequenced; each PR stays draft until its parent merges, and each is a risk-based
review item for `@offmann`:

1. **Foundation: shared types and constraint floor.** Add `ApiGapResponse` and
   `BrowserHandoff` to `src/shared/types.ts` next to `NetworkErrorEnvelope`, plus
   the shared default constraint floor. This lands the floor without the Impact
   `applyToProgram` reference named in the browser-handoff contract.
2. **Consent and audit extension.** Add the `verified` and `verify_failed`
   closing events and the per-day consent cap that counts mutating handoffs, on
   top of the existing `handoff_emitted` event.
3. **Awin emitter, descriptors, tools, and action-map wiring.** Add the pure
   `approvePublisher` and `declinePublisher` emitters in `awin-advertiser`, their
   action descriptors with the stable identifiers, the generated tools, and the
   action-map entries. Use the live-verified `app.awin.com` pending-partner path
   (no longer a `// TODO(verify)`) and add scrubbed fixtures and tests with no
   real publisher, programme, or account identifiers.
4. **Consumer skill and verify closure.** Add the one consumer skill driving
   Claude in Chrome for these two ids, gated by the single per-batch human
   confirmation with the per-submit floor enforced, reporting back against the
   `verify` block to record `verified` or `verify_failed`. The skill must detect
   the account's UI generation first: if navigation lands on `ui.awin.com` the
   account is on Awin Classic, and the skill stops with a clean "this account is
   on Awin Classic; automated approval is not supported for it yet" message
   rather than attempting the flow.
