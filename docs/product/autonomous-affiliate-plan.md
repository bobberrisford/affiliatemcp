# Plan: towards autonomous affiliate — and an honest check on whether it's a good idea

**Status:** thinking doc, not committed scope. North Star is "autonomous affiliate."
**Date:** 2026-06-05

This is two things in one document, because the brief was "make a plan; check
if it is a good idea." Section A is the verdict. Section B is the plan that
follows from it. The plan only exists in the shape it does *because* of the
verdict — so read A first.

---

## A. Is "fully autonomous affiliate" a good idea?

Short version: **the watching-and-thinking half is an unequivocally good idea
and is most of the value. The spending-and-approving half is not a good idea as
a literal goal, for four concrete reasons that are structural, not just
caution.** Keep the North Star, but redefine what it means.

### What "autonomous" should mean here

An autonomous **analyst and operator-on-a-leash** — not an autonomous spender:

- **Full autonomy in watching and thinking.** The system runs the
  pull → analyse → recommend loop unattended, on a schedule, and tells you what
  changed and what to do. No human needed for this to run.
- **Gated, graduated autonomy in *reversible* doing.** A narrow envelope of
  low-risk, reversible, API-backed actions (generate a tracking link, shortlist
  programmes to apply to, draft outreach) that can graduate from
  human-approved to autonomous as an audit record earns it.
- **Human required for spending and approving.** Anything financial or
  irreversible — approving/reversing transactions, adjusting commission rates,
  paying out — stays human-gated. Possibly forever. That is the correct design,
  not an unfinished one.

### Why the literal "fully autonomous, hands-off" goal is not a good idea

1. **The networks don't expose the write APIs.** Today every adapter in this
   repo is read-only bar `generateTrackingLink`. The coverage research confirms
   the wider reality: public self-serve APIs are overwhelmingly read endpoints.
   A handful expose narrow writes (Indoleads `apply-to-offer`, coupon creation,
   deeplink generation); approving transactions, adjusting rates, and payouts
   almost never have a public API. So "doing" those autonomously means driving
   the user's dashboard in a browser — brittle, UI-dependent, and **usually a
   breach of the network's terms of service**, especially for financial
   actions. We would be building the most fragile, least defensible part first.

2. **Financial actions are irreversible and high-liability.** Auto-approving a
   batch of transactions or triggering a payout is real money with no undo. The
   blast radius of a bug or a bad inference is the user's revenue or their
   relationship with a network. No amount of cleverness makes "fire and forget"
   appropriate here.

3. **The reward signal is lagged and reversible, so the optimisation loop is
   starved.** True autonomy implies a closed loop: act, observe outcome, adjust.
   But affiliate outcomes settle over 30–90 days and can reverse after the fact.
   You cannot run a tight optimise loop on a reward that arrives a quarter late
   and might be clawed back. Any system claiming to "optimise autonomously" is
   either acting on noise or quietly waiting months between learning steps.

4. **The real money lives outside the network APIs.** Affiliate income is made
   by choosing the right programmes, producing content and placements that
   convert, and driving traffic. The network API is the *least* leveraged
   surface for autonomy. Even perfect autonomous network-action would be
   automating the low-leverage 10% while the 90% (content, traffic, audience)
   sits outside anything we can touch.

### The conclusion that shapes the plan

Point autonomy at the part that is high-value, low-risk, and actually
achievable now — **continuous monitoring, analysis, and recommendation** — and
build the action layer behind it slowly, reversible-first, with a hard stop at
financial/irreversible operations. The autonomy dial goes up per action class
*only as an audit track record earns it*, and it may never reach the top. That
is success, not failure.

---

## B. The plan

Architecture, recapped from the design discussion:

```
Pull (live)  →  Analyse (deterministic Findings)  →  Strategise (human Policy
   ↑                                                   + model proposals)
   └──────────── verify by re-pull ←── Act (typed Actuator + gate) ←─┘
```

Cross-cutting spine: a thin **observation diary** (timestamped metrics, for
change-detection only — never a mirror of network data, never queried by the
user, always surfaced with an "as of" label); an **append-only audit log**; and
an **autonomy governor** that decides per action whether to act or ask.

Each phase is independently valuable and ships on its own. The dial only turns
up when the previous phase has earned it.

### Phase 0 — Foundations (no action, no autonomy risk)

- **Observation diary + scheduler.** Record the metrics the existing skills
  already compute, on a schedule, so change can be detected unattended. Live
  pull stays the source of truth for "what is it now"; the diary only answers
  "what changed."
- **Deterministic Findings library.** Lift the arithmetic out of the reporting
  skills (`affiliate-earnings-report`, `programme-anomaly-watch`,
  `programme-performance-report`) into pure, tested functions emitting typed
  `Finding` objects. The model interprets Findings; it never does the maths.
- **Deliverable:** an unattended daily/weekly "what changed" digest.
- **Does NOT:** take any action. Reads only.
- **Exit criteria to advance:** Findings are stable and trusted; digest is
  useful enough that users rely on it.

### Phase 1 — Strategy capture (recommend-only)

- **Policy file** — human-authored, versioned: objectives, guardrails,
  thresholds, playbooks (e.g. "prioritise programmes with EPC > X", "never let
  a top-20 partner go 14 days without contact"). This is where strong operators
  encode judgment so weaker ones inherit it — the floor rises.
- **Ranked recommendations.** The model reads Findings + Policy and proposes
  actions with rationale, expected value, and confidence. Still recommend-only;
  the human acts in the dashboard.
- **Does NOT:** act. Proposes.
- **Exit criteria:** recommendations are good enough that users routinely
  follow them by hand.

### Phase 2 — Actuator contract, dry-run only

- **Typed `Action`** mirroring the read adapter: declares side-effects,
  reversibility class (read / reversible-write / irreversible-financial),
  `via: api | browser`, and a verification check.
- **Implement the safest first, API-only:** tracking-link generation (already
  have it), programme-application shortlists, draft outreach. Everything runs
  as **dry-run / preview**; the human approves each one.
- **The gate:** policy check → preview → execute → verify (re-pull) → log.
- **Does NOT:** execute without per-action approval; touch financial actions;
  touch browser actions.
- **Exit criteria:** the gate + verify + audit machinery is proven reliable on
  safe actions.

### Phase 3 — Graduated autonomy on the safe envelope

- Turn the dial up **only** for reversible, non-financial, API-backed actions,
  under policy thresholds, with verify-then-log and easy undo.
- Browser actuators for no-API networks stay **human-gated** (brittle + ToS).
- **Does NOT:** auto-execute anything financial or irreversible.
- **Exit criteria:** clean audit history over a meaningful period per action
  class.

### Phase 4 — Conditional, and may never ship

- Financial and/or browser-driven autonomy. **Explicitly gated behind:** (a)
  per-network ToS clearance, (b) a proven multi-month audit track record from
  Phase 3, and (c) a real answer to the lagged-reward problem. If those gates
  aren't cleared, this phase does not happen — and the product is still
  complete and valuable without it.

---

## What to build first

Phase 0 alone delivers most of what "autonomous affiliate" actually means to a
user: *it watches everything, unattended, and tells me what changed and what to
do.* It carries zero action risk, reuses the skills already shipped, and earns
the trust that every later phase spends. Start there.
