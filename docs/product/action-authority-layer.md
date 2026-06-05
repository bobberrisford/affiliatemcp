# The action-authority layer

Status: design proposal, phased roadmap. Nothing here is implemented. This is
the generalisation of the per-call gate described in
[impact-contracts-action-layer.md](impact-contracts-action-layer.md); read that
first. The Contracts work is the concrete first write and needs only the human
gate. This document is what comes after, once that gate is proven.

## The problem

The project is moving from reading data to taking actions. The first writes
(Impact contracts) sit behind a per-call gate: propose a change, show the user a
plan, apply only on explicit approval. That is the right default and it should
stay the default.

But operators will not want to approve every action by hand forever. They will
want to **delegate bounded authority** — "raise commission for publishers above
target, but never by more than a point, never past 8%, and never more than
twenty times a month, and ask me for anything outside that." This document
describes how to grant that delegation **without** making the model the thing
the user has to trust.

## The principle: keep three concerns apart

The instinct is to build one system that knows the goals, decides the actions,
and enforces the limits. That system is brittle and untrustworthy because the
safety boundary moves whenever the strategy changes. Instead, three separate
layers:

1. **Authority / policy** — *what may happen without me.* Caps, thresholds,
   allowlists, budgets, sign-off records. Deterministic, version-controlled,
   auditable. Changes rarely and deliberately.
2. **KPIs / strategy** — *what I am trying to achieve.* Targets and goals.
   These are **inputs to proposals only**. They change constantly.
3. **Trigger / autonomy** — *when something fires without a human.* Schedules
   or events.

**KPIs are inputs, never authority.** A KPI may shape what gets proposed, and it
may *tighten* a guardrail ("only raise commission for publishers above the ROAS
target"). It may **never** loosen an absolute cap. The hard ceilings — maximum
payout rate, maximum per-change delta, monthly write budget, brand allowlist —
are strategy-independent and do not move when the strategy doc is edited. If a
threshold could be computed from a KPI target, it is a guardrail tightening, not
the ceiling itself; the ceiling still stands behind it.

This separation is the whole design. Everything below follows from it.

## Tiered authority

This extends the propose→apply gate rather than replacing it.

| Tier | Action                          | Gate                                                        |
| ---- | ------------------------------- | ----------------------------------------------------------- |
| 0    | read                            | always allowed                                              |
| 1    | `propose` (no side effect)      | always allowed                                              |
| 2    | auto-apply **within policy**    | deterministic policy check passes → executes unattended     |
| 3    | apply **outside policy**        | falls back to propose→apply + human sign-off                |

The system **fails closed**: anything a policy rule does not explicitly
green-light drops to Tier 3 and waits for a human. There is no fail-open path.

## The non-negotiable: enforcement is code, not prompt

The policy gate is evaluated in the tool-dispatch layer, in code, before any
write reaches the network. It is **not** evaluated by the model.

This is the entire basis of trust. If the model both reads the policy and
decides whether it applies, the threshold is a suggestion. If the dispatch layer
deterministically checks the proposed change against the policy and either
executes or escalates, the user is trusting code they can read, not the model's
discretion. **The model proposes; the code authorises.**

## The policy artifact

Declarative, version-controlled, in the spirit of the existing `brands.json` and
`.env` configuration:

```yaml
impact-advertiser:
  applyContract:
    autoApprove:
      when:
        - action: create
        - payoutRate:         { max: 8 }     # CPS %, absolute ceiling
        - deltaFromCurrent:   { maxAbs: 1 }  # never move terms > 1pt
        - brand:              { in: [acme-uk] }
        - monthlyWriteBudget: { maxCount: 20 }
      requireHumanOtherwise: true            # fail-closed default
```

Two properties ride alongside it:

- **Audit.** Every auto-executed action records which rule authorised it, the
  inputs, the before → after, and the policy version. "What did the agent do
  overnight, and under what authority?" has a concrete answer.
- **Policy versioning.** Sign-off means "I approved *this* ruleset," pinned by
  hash — the same idea as the per-call confirmation token, one level up. A
  changed policy is unapproved until re-signed.

## Where autonomy comes from

The MCP is stateless request/response; it has no daemon. The project already
leans on Claude's own scheduling (the `programme-anomaly-watch` skill runs on a
schedule). So "happens automatically" is a scheduled agent run that is
*permitted* to execute Tier-2 actions because the policy pre-authorised them.
The schedule is the trigger; the MCP supplies the deterministic policy check and
the audit trail. No new execution engine is required.

## How KPIs enter, concretely

A scheduled optimisation run:

1. reads the KPI targets (strategy input — lives in config / a skill, not core);
2. reads current performance via the existing read operations;
3. forms a proposal via `proposeContract` (Tier 1, no side effect);
4. the dispatch layer checks the proposal against policy (Tier 2 gate);
5. within policy → auto-applies and audits; outside → escalates to a human
   (Tier 3).

The KPI target influenced *what was proposed* and could have *narrowed* the set
of eligible publishers. It never touched the ceilings in step 4.

## Scope: core vs above core

- **In core:** the policy-check primitive in tool dispatch, the fail-closed
  escalation, the audit log, policy versioning. Small, deterministic,
  high-trust. This is the authority primitive and nothing more.
- **Above core (skills + config + the agent's reasoning):** KPI and strategy
  modelling, and the optimisation logic that turns "ROAS below target" into a
  proposed change. This changes constantly and must not be baked into the trust
  boundary.

Putting a KPI/strategy engine inside the MCP would entangle the safety layer
with the part of the system that changes most often. The boundary stays boring;
the strategy stays flexible.

## Product framing

This is a deliberate product decision, not only an engineering one. It moves the
project from "data + safe single actions" to **bounded autonomous operations**.
The manifesto's "prepare safe next actions" becomes "prepare safe next actions,
and execute the ones I have pre-authorised within limits I can read and revoke."

## Phased roadmap

1. **Phase 0 — per-call gate (the Contracts doc).** Propose → apply, host
   approval, opt-in write credential, audit line. No policy engine. Proves the
   write path and the advisement pattern. *This is the only phase with a
   concrete adapter behind it today.*
2. **Phase 1 — authority primitive in core.** The deterministic policy check,
   Tier-2/Tier-3 escalation, fail-closed default, audit with rule attribution,
   policy versioning + sign-off. Still human-triggered; "auto-approve" now means
   "skips the host prompt because policy and a signed ruleset allow it."
3. **Phase 2 — scheduled autonomy.** Wire Tier-2 execution into scheduled agent
   runs (reusing existing scheduling). The agent may now act unattended strictly
   within signed policy. Audit becomes the primary review surface.
4. **Phase 3 — KPI-shaped proposals.** Strategy inputs (config / skill) feed the
   proposal step and may tighten guardrails. Absolute ceilings remain fixed and
   strategy-independent throughout.

Each phase is independently useful and independently revocable. The project can
stop at any phase boundary and still have shipped something coherent.

## Open questions

1. Policy file format and location — YAML vs JSON, single file vs per-network,
   relationship to `brands.json`.
2. Sign-off mechanism — how a human approves a ruleset version in a way the
   dispatch layer can verify offline (hash in config? a signed file?).
3. Audit storage — local append-only log vs structured store; retention.
4. Revocation and kill-switch — how an operator instantly drops everything back
   to Tier-3-only (propose→apply for all writes).
5. Multi-operator / agency case — whose sign-off authorises actions on a managed
   brand, and how that maps to the agency-passthrough credential tier.
