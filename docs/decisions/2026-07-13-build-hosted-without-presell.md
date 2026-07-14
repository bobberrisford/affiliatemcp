# Build the hosted MVP directly, without the pre-sell gate

- **Date:** 2026-07-13
- **Status:** Accepted (2026-07-13, Rob: "No wait list, let's build the
  thing", given in-session during the delivery window)
- **Affects:** the Phase 0 pre-sell gate in
  `../product/solo-50k-revenue-plan.md`, the waitlist decision
  [`2026-07-12-waitlist-email-resend.md`](./2026-07-12-waitlist-email-resend.md)
  (rescinded by this record), the merged but undeployed `waitlist/` Worker,
  and the Phase 1 sequencing in `../product/solo-50k-technical-roadmap.md`
- **Builds on:** [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
  (accepted; authorises the hosted foundation this record starts)

## Context

The accepted revenue plan gated the hosted build on demand evidence: 30
founding pre-orders or 500 waitlist emails. Rob rescinded that gate on
2026-07-13 and directed the hosted MVP to be built directly, with no
waitlist.

## Decision

- Skip the pre-sell gate. Phase 1 (the hosted MVP) starts now, in the slice
  order defined by the workstream brief
  `../product/hosted-mvp-workstream.md`.
- No waitlist. The Resend waitlist record is rescinded; the `waitlist/`
  Worker merged in PR #353 stays in the tree as inert, undeployed code (its
  pattern and CI job are reusable for transactional email later, for example
  magic-link sign-in) unless Rob asks for its removal.
- The pricing page keeps its honest pre-launch labelling; its CTA is
  repointed to the hosted product as slices ship, not to a waitlist.

## Consequences

- Demand risk is accepted knowingly: the build proceeds without market
  evidence, reversing the plan's own funnel-first logic. The revenue plan's
  arithmetic and churn maths are unchanged; only the gate is removed.
- The Phase 0 gate dashboard item loses its purpose and is dropped.
- Custody, security, and lane disciplines are unchanged: hosted work remains
  bounded by the custody record, one active-risk PR at a time, independent
  review plus green CI before merge.

## Rejected alternatives

- **Keep the pre-sell gate.** The plan's original shape; rejected by Rob.
- **Founding-offer checkout first, hosted second.** Sells before building;
  not chosen.
