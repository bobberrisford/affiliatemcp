# Action-authority layer for brand-side writes

- **Date:** 2026-06-12
- **Status:** Accepted (2026-06-13)
- **Affects:** tool dispatch (`src/tools/generate.ts`), future authority
  primitives in shared core, audit logging, the product framing of brand-side
  writes
- **Depends on:** nothing merged today. The first concrete consumer is the
  Impact contracts Phase 0 decision
  ([`2026-06-12-impact-contracts-actions.md`](./2026-06-12-impact-contracts-actions.md)),
  which needs only the per-call gate and none of the later phases.

## Context

The project is moving from reading affiliate data to taking actions. The first
brand-side write (Impact contracts) sits behind a per-call gate: propose a
change, show the operator a plan, apply only on explicit approval. That is the
right default. But operators will not approve every action by hand forever;
they will want to delegate bounded authority, for example "raise commission for
publishers above target, never by more than a point, never past 8%, never more
than twenty times a month, and ask me for anything outside that".

This record supersedes the action-authority proposal in
`docs/product/action-authority-layer.md` from PR #73, which combined this
direction with the Phase 0 Impact contracts design. The two are linked but
separable decisions; the Phase 0 record is split out per the maintainer's
triage. It is consistent with the manifesto's requirement that anything beyond
local reads is designed with explicit auth, consent, auditability, and
security.

## Decision

Adopt a deterministic action-authority layer, phased, that lets operators
pre-authorise bounded actions without making the model the thing the operator
has to trust.

**Keep three concerns apart.** Authority (what may happen without me: caps,
thresholds, allowlists, budgets, sign-off), KPIs and strategy (what I am trying
to achieve), and triggers (when something fires without a human) are separate
layers. KPIs are inputs to proposals only, never the authority boundary. A KPI
may tighten a guardrail; it may never loosen an absolute ceiling. Hard ceilings
such as maximum payout rate, maximum per-change delta, monthly write budget,
and brand allowlist are strategy-independent and do not move when strategy
changes.

**Tiered authority, extending the propose-apply gate.** Tier 0: reads, always
allowed. Tier 1: propose, no side effect, always allowed. Tier 2: auto-apply
within policy, where a deterministic policy check passes. Tier 3: apply outside
policy, which falls back to propose-apply with human sign-off. The system fails
closed: anything a policy rule does not explicitly green-light drops to Tier 3
and waits for a human. There is no fail-open path.

**Enforcement is code, not prompt.** The policy gate is evaluated in the
tool-dispatch layer, in code, before any write reaches a network. It is never
evaluated by the model. The model proposes; the code authorises. This is the
entire basis of trust.

**Version-controlled policy artefact.** Authority lives in a declarative,
version-controlled policy file in the spirit of existing configuration. Two
properties ride alongside it: every auto-executed action is audited with the
rule that authorised it, the inputs, the before and after state, and the policy
version; and sign-off is pinned to a policy version by hash, so a changed
policy is unapproved until re-signed.

**Autonomy reuses existing scheduling.** The MCP is stateless request/response
with no daemon. Scheduled agent runs (the pattern `programme-anomaly-watch`
already uses) are the trigger; the MCP supplies the deterministic policy check
and the audit trail. No new execution engine.

**Scope boundary.** In core: the policy-check primitive in tool dispatch, the
fail-closed escalation, the audit log, policy versioning. Above core, in skills
and configuration: KPI and strategy modelling and the optimisation logic that
turns "ROAS below target" into a proposed change. The trust boundary stays
small and boring; the strategy stays flexible.

**Phases.** Phase 0: per-call gate only (the Impact contracts decision); no
policy engine. Phase 1: the authority primitive in core, with Tier-2/Tier-3
escalation, fail-closed default, audit with rule attribution, and policy
versioning plus sign-off; still human-triggered. Phase 2: scheduled autonomy,
wiring Tier-2 execution into scheduled agent runs; audit becomes the primary
review surface. Phase 3: KPI-shaped proposals, where strategy inputs feed the
proposal step and may tighten guardrails. Each phase is independently useful
and revocable; the project can stop at any phase boundary.

## Security

- The deterministic gate, not the model, is the safety boundary. The model
  never both reads the policy and decides whether it applies.
- Fail-closed default: no rule match means human sign-off, always.
- Policy sign-off is pinned by hash; editing the policy revokes approval.
- Audit answers "what did the agent do unattended, and under what authority?"
  with rule attribution per action.
- Local-first holds: policy, audit, and credentials stay on the operator's
  machine.

This is an action-execution and product-direction decision with implementation
consequences and is a risk-based review item.

## Rejected alternatives

- **One system that knows the goals, decides the actions, and enforces the
  limits.** Brittle and untrustworthy: the safety boundary would move whenever
  the strategy changes. Rejected in favour of the three-layer separation.
- **KPIs as the authority boundary.** A threshold computed from a KPI target is
  a guardrail tightening, not a ceiling. Letting strategy edits move hard caps
  defeats the point of pre-authorisation. Rejected.
- **Prompt-level enforcement.** If the model evaluates the policy, the
  threshold is a suggestion. Rejected; enforcement is code in tool dispatch.
- **A KPI/strategy engine inside the MCP core.** Entangles the safety layer
  with the part of the system that changes most often. Rejected; strategy lives
  above core in skills and configuration.
- **A new daemon or execution engine for autonomy.** Unnecessary; scheduled
  agent runs already exist and the MCP stays stateless. Rejected.

## Consequences

- Brand-side writes gain a stable trust story: per-call human gate first, then
  bounded delegation under a readable, revocable, signed policy.
- The product framing moves from "data plus safe single actions" to bounded
  autonomous operations: prepare safe next actions, and execute the ones the
  operator has pre-authorised within limits they can read and revoke.
- Shared core eventually gains an authority primitive (Phase 1), which is a
  public-contract change and will need its own risk-based review.
- Open questions deferred to Phase 1 design: policy file format and location
  (YAML vs JSON, single file vs per-network, relationship to `brands.json`);
  the sign-off mechanism the dispatch layer can verify offline; audit storage
  and retention; the revocation kill-switch that drops everything back to
  propose-apply; and whose sign-off authorises actions on a managed brand in
  the multi-operator agency case.

## Implementation follow-ups

1. Land Phase 0 via the Impact contracts decision and its implementation PRs;
   prove the propose-apply gate, the opt-in write credential, and the audit
   line before any policy engine work starts.
2. A Phase 1 design and decision follow-up resolving the open questions above
   (policy format, sign-off, audit storage, kill-switch, agency sign-off)
   before the authority primitive lands in core.
3. Phase 1 implementation: deterministic policy check in tool dispatch,
   fail-closed escalation, audit with rule attribution, policy versioning.
4. Phase 2: wire Tier-2 execution into scheduled agent runs, reusing existing
   scheduling.
5. Phase 3: KPI-shaped proposals as skills and configuration above core, with
   ceilings unchanged.
6. Remove or redirect `docs/product/action-authority-layer.md` from the PR #73
   branch once this record merges, so the decision record is the single source
   of truth.
