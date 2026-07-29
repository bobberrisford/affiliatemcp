# Hosted credential custody: bring-your-own-key hosted execution

- **Date:** 2026-07-12
- **Status:** Accepted (2026-07-12, Rob; "Plan accepted" covering this record
  and the solo revenue plan it implements)
- **Affects:** the local-first boundary in `docs/product/manifesto.md`
  (Principle 2), `PRIVACY.md`, `README.md` claims, and every hosted work item
  in `docs/product/solo-50k-technical-roadmap.md`
- **Builds on:** `docs/product/hosted-version-scoping.md` (discovery),
  [`2026-06-13-privacy-first-telemetry.md`](./2026-06-13-privacy-first-telemetry.md)
- **Relates to:** [`2026-06-30-paid-tier-entitlement-gate.md`](./2026-06-30-paid-tier-entitlement-gate.md),
  [`2026-07-01-desktop-premium-skill-packs.md`](./2026-07-01-desktop-premium-skill-packs.md)

## Context

The value of this product concentrates in people who cannot self-host: agency
account managers, brand managers, and multi-network publishers blocked by the
runtime, credential-capture, client-wiring, and liveness walls documented in
`docs/product/hosted-version-scoping.md`. The commercial plan
(`docs/product/solo-50k-revenue-plan.md`) depends on a hosted tier, and the
scoping doc identified credential custody as the single decision that
separates a hosted tier from the current posture: today the project never
holds a user's network credentials; a hosted version stores live affiliate
API keys for many tenants.

Manifesto Principle 2 anticipated this: credentials stay local "unless a
future remote option is explicitly designed with auth, consent, auditability,
and security". This record is that explicit design decision.

## Decision

Accept hosted credential custody in the narrowest form that removes the
install wall: **bring-your-own-key hosted execution**, the middle option from
the scoping doc.

The custody contract:

1. **What is held.** Per-user affiliate network API credentials and OAuth
   tokens, plus per-tenant brand and client-strategy context. Nothing else.
   Browser session credentials are never held; browser-handoff and write
   operations stay local-only until a separate hosted-action safety contract
   exists.
2. **How it is held.** KMS-backed envelope encryption with per-user data
   keys, using established managed secrets infrastructure, not home-rolled
   cryptography. Keys are decrypted only at call time, in memory, to serve
   that user's request. A documented key-rotation procedure exists before
   launch.
3. **Least privilege.** Where a network offers scoped or read-only API keys,
   the connect flow instructs the user to create one; the hosted tier is
   read-only in scope regardless.
4. **What the keys are used for.** Serving that user's own requests and their
   own scheduled jobs. No analytics and no purpose beyond serving the key's
   owner, with **one bounded exception**: opt-in, aggregate-only, k-anonymous
   programme benchmarks, defined in and governed by
   [`2026-07-19-hosted-benchmark-aggregates.md`](./2026-07-19-hosted-benchmark-aggregates.md),
   which supersedes this clause's original absolute "never aggregation across
   tenants". That exception is off by default and revocable, exposes no single
   tenant's data, and is the only cross-tenant use permitted. Otherwise this
   extends the `PRIVACY.md` posture: hosted custody changes where keys live, not
   what the project is allowed to do with data.
5. **User control.** Self-serve export of everything and hard delete of the
   account, credentials included, at any time. Deletion is complete, not a
   soft flag.
6. **Transparency.** A public trust page states what is stored, how it is
   encrypted, who can access it, and how deletion works, before the first
   paying hosted customer.
7. **Security owner.** Rob owns the security, legal, and privacy contract for
   hosted custody. A written incident and disclosure runbook exists before
   launch; affected users are notified promptly on any suspected compromise,
   within GDPR timelines.
8. **Local remains free and complete.** The local server stays fully
   functional, free, and open source. Hosted custody is an addition for the
   cohort that cannot self-host, not a replacement or a degradation of the
   local path.

## Rejected alternatives

- **Stay local-only.** Preserves the current posture verbatim, but leaves the
  highest-value cohort permanently unable to use the product and caps the
  commercial plan. Rejected by the maintainer with the constraint that local
  stays free and complete.
- **Assisted-local tunnel only.** Keeps keys local but requires a runtime and
  an awake machine; already the answer for semi-technical users, does not
  reach the non-technical cohort. Retained as a shipped path, insufficient
  alone.
- **Fully managed SaaS custody including browser sessions.** Would enable
  hosted browser-driven operations but holds login sessions, a far larger
  custody and safety surface. Rejected; browser handoffs stay local-only.

## Consequences and implementation follow-ups

- The identity and tenancy foundation, encrypted vault, remote MCP transport,
  guided connect flow, and trust surface proceed per
  `docs/product/solo-50k-technical-roadmap.md` Phase 1, in the risk-lane
  order recorded there, once this record is accepted.
- `PRIVACY.md` gains a hosted section matching the contract above in the same
  change set as the first hosted foundation PR.
- `README.md` and website claims are re-worded so "local-first" describes the
  default and the free path, not a promise that no hosted option exists.
- Per-network terms-of-service review becomes a promotion requirement before
  any adapter is offered hosted; networks that prohibit third-party
  credential use stay local-only and the pricing page says so.
- The manifesto gains a forward pointer from Principle 2 to this record on
  acceptance.
