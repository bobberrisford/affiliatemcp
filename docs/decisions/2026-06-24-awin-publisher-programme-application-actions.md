# Awin publisher programme-application action: write-gated browser apply with surfaced terms

- **Date:** 2026-06-24
- **Status:** Proposed
- **Affects:** `src/networks/awin/` (the publisher-side adapter: a new action
  descriptor, a pure emitter, and the generated tools), action-map wiring in
  the MCP tool layer, and a first publisher-side consumer skill driving Claude
  in Chrome. It does not change `src/shared/types.ts`, the constraint floor, or
  the audit vocabulary.
- **Depends on:** the accepted browser-handoff contract
  ([`2026-06-12-browser-handoff-contract.md`](./2026-06-12-browser-handoff-contract.md)),
  the accepted action-authority layer
  ([`2026-06-12-action-authority-layer.md`](./2026-06-12-action-authority-layer.md)),
  the accepted action capability map
  ([`2026-06-18-action-capability-map.md`](./2026-06-18-action-capability-map.md)),
  and the publisher-application advertiser-side record it mirrors
  ([`2026-06-23-awin-publisher-application-actions.md`](./2026-06-23-awin-publisher-application-actions.md)).

## Context

A publisher, creator, or agency working a publisher account discovers brands on
Awin and applies to their programmes. The advertiser-side record above defined
the first browser-handoff write contract on Awin: an advertiser approves or
declines a pending publisher application through their own authenticated Awin
session, because Awin's advertiser API exposes no approve/decline endpoint. This
record defines the mirror image on the publisher side: a publisher applying to a
brand's programme.

The publisher-side facts, verified against the `awin` adapter:

- **Discovery is API-backed.** `listProgrammes` already filters by relationship:
  it maps the canonical `status: 'available'` to Awin's `relationship=notjoined`
  (`src/networks/awin/adapter.ts`, `pickAwinRelationship`). Pulling the set of
  joinable brands needs no new contract; prioritising them is analysis over
  read data.
- **Applying is dashboard-only.** Awin exposes no publisher-side endpoint to
  apply to or join a programme. `network.json` records `supports_brand_ops:
  false`, and the API map in the adapter header lists only GET routes. The only
  honest route to submit an application is a browser action against the
  operator's own authenticated Awin session.

`AGENTS.md` keeps adapters read-oriented unless an accepted decision explicitly
defines a safe write contract. This record defines that contract for one
publisher-application action. It rides the same accepted foundations as the
advertiser side: the browser-handoff contract fixes the typed
`ApiGapResponse`/`BrowserHandoff` shape, the constraint floor, and the
`handoff_emitted` audit semantics; the action-authority layer fixes the Tier 0
to Tier 3 model in which writes fail closed to Tier 3 and enforcement is code,
not prompt; the action capability map fixes the channel, effect, and
default-authority-tier classification.

## Decision

### 1. One stable action id, write effect, Tier 3 by default

The publisher adapter declares exactly one doing-surface action, with an
immutable, network-scoped identifier from the moment it ships:

- `awin.applyToProgramme`

It carries, under the action capability map's three orthogonal classifications:

- `channel: browser`: the adapter returns the typed handoff; this repository
  does not open, control, or observe a browser as part of emission.
- `effect: write`: the represented operation submits a programme application,
  changing the publisher's relationship state on Awin.
- `defaultAuthorityTier: 3`: a write fails closed to Tier 3 and waits for human
  sign-off. No accepted policy engine exists to return Tier 2, so Tier 3 is the
  operative tier.

The browser channel never weakens the gate. Pure emission of a handoff is not
permission to execute the represented application.

### 2. The Awin publisher `BrowserHandoff` shape

The emitter produces one `BrowserHandoff` per programme application, in the
shared shape fixed by the browser-handoff contract:

- `goal`: plain English, naming the brand and the action, for example "Apply to
  the Example Brand programme (advertiser id 1234) on Awin as publisher Acme
  Media".
- `startingUrl`: a reviewed, Awin-owned `https://ui.awin.com` publisher
  programme-directory or programme-detail path for the join/apply flow. It is
  selected by reviewed adapter code, never supplied by the caller or the model,
  and it is recorded with a `// TODO(verify)` marker to be confirmed against a
  live publisher tenant before the emitter ships.
- `inputs`: `{ advertiserId, programmeName, brand, promotionMethodSummary? }`.
  All values are JSON-serialisable. The payload carries no secrets, tokens,
  cookies, or session material. Terms review evidence belongs to the consumer
  workflow and audit summary, not the pure emitter payload.
- `constraints`: the shared default floor inherited from the browser-handoff
  contract (no payment or payout changes; stop and hand back on any login, MFA,
  or re-authentication challenge; do not repeat a mutation that already appears
  completed; show a summary and wait for explicit confirmation before submitting
  when `mutates` is true; **never accept terms, compliance checkboxes, or
  consents the user has not seen**), plus Awin publisher-specific additions:
  - apply only to the named `advertiserId`;
  - stop if the programme relationship is not in a joinable state (already
    joined, pending, or rejected → stop and hand back);
  - do not negotiate, counter, or alter the programme's commercial terms;
  - if the application form requires answers the inputs do not supply (for
    example a free-text promotional-methods justification beyond the supplied
    summary), stop and hand back rather than inventing them.
- `mutates: true`: the flow submits an application, so confirm-before-submit is
  forced.
- `verify`: `{ url: <publisher programme-detail or pending-applications url>,
  expect: "programme relationship reads pending or joined for this advertiser" }`.

The emitter wraps this handoff in an `ApiGapResponse` with `kind: 'api-gap'`,
`reason: "Awin has no public publisher programme-application endpoint"`, a
verbatim `userMessage` for the calling agent to show the operator, and the
payload under `browserFallback`. An API gap is an expected, documented
condition, not a failure; it is returned, never thrown, and never travels
through `NetworkErrorEnvelope`. An actual Awin outage during any operation still
surfaces through the envelope as normal.

The emitter is pure: a side-effect-free function from typed input to
`ApiGapResponse`, with no `fetch`, session, DOM, or retries. It makes no network
call, so it adds no write path through the publisher `client.ts`.

### 3. Terms are itemised, reviewable, then accepted under one informed confirmation

Awin programme applications generally require accepting the advertiser's
programme terms (commission terms, promotional-method restrictions, voucher and
PPC rules). The shared constraint floor forbids accepting terms the user has not
seen, and that floor cannot be removed or weakened.

This contract therefore does not authorise blind acceptance. The consumer skill
must build an itemised review bundle before any submit click. For each programme
in the batch it shows, at minimum:

- brand/programme name and advertiser id;
- the application action to be taken;
- the terms source the operator can inspect (full displayed text, modal content,
  or the exact dashboard section/link Awin presents);
- a short digest of material restrictions such as PPC, voucher/coupon, content,
  sub-network, cashback/loyalty, geography, disclosure, or promotional-method
  rules; and
- a clear "terms seen" status.

The operator must be able to remove individual programmes from the batch after
seeing their terms. The final confirmation must name the batch count and make
the consent explicit, for example: "Apply to these N Awin programmes and accept
the displayed terms for each listed programme." That single confirmation is the
operator's informed acceptance for the remaining itemised programmes. It is not
permission to accept terms for programmes that were hidden, summarised without a
source, added after confirmation, or changed between review and submission.

Where a programme's terms cannot be retrieved, displayed, or linked for review,
the skill stops on that programme and hands back rather than confirming unseen
terms. If Awin presents a special term, extra compliance checkbox, legal
certification, payment/payout change, or form answer not included in the review
bundle, the consumer stops on that programme and asks the operator; it does not
fold the new condition into the existing batch confirmation.

### 4. Consumer authorisation: one skill, one per-batch human confirmation

This record authorises exactly one consumer skill, driving Claude in Chrome, for
this action id and no other. The skill reads the joinable-brand set from the
Awin API (`listProgrammes` with `status: 'available'`), proposes a prioritised
subset to apply to, builds the itemised terms review bundle above, allows the
operator to remove rows, and is gated by a single per-batch human confirmation:
the operator reviews the proposed applications and the terms evidence, then
confirms once for the final batch. That single confirmation satisfies the Tier 3
human sign-off and the floor's informed-terms requirement for that final batch
only. The per-submit safety floor still applies on every individual submission:
the consumer respects the constraint floor on each row, stops on a non-joinable
programme, stops if terms differ from the reviewed bundle, and stops and hands
back on any login or MFA challenge.

This record does not authorise unattended or scheduled execution. Running this
action without a human present needs the Phase 1 and Phase 2 authority policy
engine from the action-authority layer, which is not built; until it is accepted
and implemented, every batch requires the per-batch human confirmation.

### 5. Strategy and KPI inputs are advisory only

`Strategy.md` and `KPI.md`, read through `affiliate_get_client_strategy`, may
shape which brands the skill proposes to apply to and how it prioritises them.
They never authorise a write. Where strategy is silent, or a KPI line fails to
parse, the skill asks the operator and never guesses. This matches the
client-strategy decision: strategy and KPI files are advisory and never the
authority boundary.

### 6. Audit

The audit trail uses the vocabulary fixed by the browser-handoff contract:

- `handoff_emitted` is recorded for each emitted application when the
  `ApiGapResponse` with a non-null `browserFallback` is returned through the
  tool layer. A mutating handoff counts against the per-day consent cap, the
  conservative basis already established.
- The closing events `verified` or `verify_failed` are recorded from the
  consumer's report-back against the structured `verify` block, completing the
  arc `handoff_emitted -> verified | verify_failed`.
- No code path records `succeeded` or `applied` for a handoff. `succeeded` is
  reserved for outcomes the server itself observed, and the server does not
  observe the dashboard mutation.

`advertiserId` and brand fold into the audit `summary` text; this introduces no
new audit field.

## Security

- Emission is pure and read-only on the world: a pure emitter cannot mutate Awin
  state, so this contract adds no new server write path. The publisher
  `client.ts` is unchanged; in particular this record does not add any non-GET
  application route to the adapter.
- Mutation risk lives in the consumer skill, which drives the browser under the
  per-batch human confirmation and the per-submit constraint floor. The
  `mutates: true` flag forces confirm-before-submit.
- Terms acceptance is bounded by the floor: the operator sees the terms in the
  batch summary and confirms once; the agent never accepts unseen terms, and the
  skill stops where terms cannot be displayed.
- The handoff payload never carries credentials, session tokens, cookies, or
  account secrets. `inputs` is limited to the non-secret values the application
  needs.
- `startingUrl` is selected by reviewed adapter code from the Awin-owned
  `https://ui.awin.com` origin and a bounded path; callers and models cannot
  supply an arbitrary navigation target.
- Audit honesty is a security property: recording `succeeded` for an unobserved
  dashboard outcome would overstate what was done on the operator's behalf.
  `handoff_emitted` plus consumer-reported `verified`/`verify_failed` keeps the
  trail truthful.

This decision touches an action-execution and write surface, the consent and
audit primitive, browser framing, and the first publisher-side browser consumer,
so it is a risk-based review item for maintainer review.

## Rejected alternatives

- **Accepting programme terms on the operator's behalf without showing them.**
  Directly contradicts the accepted constraint floor ("never accept terms the
  user has not seen"), which cannot be weakened. Rejected in favour of surfacing
  terms and treating the per-batch confirmation as informed acceptance.
- **Applying to a model-selected batch before the operator can remove rows.**
  A ranked shortlist is only a proposal. The user must be able to drop brands
  after seeing their terms, because a single surprising restriction can make one
  otherwise attractive programme unacceptable. Rejected in favour of an
  itemised, editable review bundle.
- **Relying on a short model summary as the only terms evidence.** A digest is
  useful, but it is not the contract. The consumer must show or link the source
  terms Awin presents and stop if it cannot. Rejected.
- **Unattended or scheduled auto-apply without a per-batch gate.** Needs the
  unbuilt Phase 1/Phase 2 policy engine and violates the Tier 3 fail-closed
  default and the confirm-before-submit floor. Rejected.
- **One confirmation per application (N confirmations for a batch).** Unusable
  for the common case of applying to many brands at once. Rejected in favour of
  one per-batch confirmation that satisfies the Tier 3 gate and informed-terms
  requirement once, while the per-submit floor still applies to every row.
- **Making `Strategy.md` or `KPI.md` authoritative for the decision.** Strategy
  and KPI files are advisory by accepted decision; letting them authorise a
  write would move the authority boundary into a file the model shapes.
  Rejected.
- **Attempting an API write.** Awin exposes no publisher programme-application
  endpoint. Rejected; the only honest route is the browser handoff.
- **Adding the action to a shared/cross-network apply surface.** Joining a
  programme differs materially across networks (API-backed on some, dashboard on
  others, terms models differ). This record scopes one Awin action only;
  generalising is a separate future decision.

## Consequences

- The `awin` publisher adapter gains its first non-read action, a
  browser-channel write, without adding any network write path, because emission
  makes no network call.
- The action capability map gains one `channel: browser`, `effect: write`,
  `defaultAuthorityTier: 3` entry bound to the stable identifier
  `awin.applyToProgramme`.
- The repository ships its first publisher-side browser consumer skill, behind
  the per-batch human gate with terms surfaced for informed acceptance;
  unattended execution remains blocked on the unbuilt authority policy engine.
- The audit trail records `handoff_emitted` per application and closes on
  consumer-reported `verified`/`verify_failed`; mutating handoffs draw down the
  per-day consent cap.
- The `startingUrl` and verify paths carry `// TODO(verify)` until confirmed
  against a live Awin publisher tenant.

## Implementation follow-ups

Sequenced; each PR stays draft until its parent merges, and each write-surface
PR is a risk-based review item for maintainer review:

1. **Read consumer first (independent, routine).** A publisher-side
   discover-and-prioritise skill that reads joinable brands via `listProgrammes`
   (`status: 'available'`) and ranks them. No new contract, no write; shippable
   independently of this decision and useful on its own. If exposing Awin's
   `rejected`/`suspended` relationship values through the status filter helps
   prioritisation, that is a small read-only adapter change scoped to its own PR.
2. **Awin emitter, descriptor, tool, and action-map wiring.** Add the pure
   `applyToProgramme` emitter in `awin`, its action descriptor with the stable
   identifier, the generated tool, and the action-map entry. Carry the
   `// TODO(verify)` markers for the dashboard paths and add scrubbed fixtures
   and tests with no real publisher, advertiser, or account identifiers.
3. **Consumer skill and verify closure.** Add the one consumer skill driving
   Claude in Chrome for this id, gated by the single per-batch human confirmation
   with terms surfaced and the per-submit floor enforced, reporting back against
   the `verify` block to record `verified` or `verify_failed`.
