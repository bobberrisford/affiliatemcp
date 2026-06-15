# Adapter verification and promotion gates

- **Date:** 2026-06-15
- **Status:** Accepted (2026-06-15)
- **Affects:** the `claim_status` contract in
  [`src/shared/types.ts`](../../src/shared/types.ts) and every
  `network.json`; the generated `README.md` table and
  [`REPORT.md`](../../REPORT.md); the contributor guidance in
  [`.claude/skills/contribute/SKILL.md`](../../.claude/skills/contribute/SKILL.md);
  the manifest validator
  [`scripts/validate-network-json.ts`](../../scripts/validate-network-json.ts);
  and the honesty principle recorded in `AGENTS.md`.
- **Depends on:** nothing merged. Implements work package 3 of the canonical
  roadmap ([#199](https://github.com/bobberrisford/affiliatemcp/pull/199)) and
  advances issue
  [#201](https://github.com/bobberrisford/affiliatemcp/issues/201). It governs,
  but does not change, the `production | partial | experimental | unsupported`
  contract that already exists.

## Acceptance

Othman accepted this cross-network contract decision on 2026-06-15 after
reviewing the freshness, full-operation coverage, confirmed-failure, and
commercial-independence rules. Issue #201 closes with this accepted record.

## Context

affiliate-mcp ships 86 adapters across 72 network families. 82 declare
`experimental`, four declare `partial` (Awin, CJ, Impact, Rakuten on the
publisher side), and none declares `production`. Every adapter already carries a
`claim_status` in its `network.json` and a matching `claimStatus` in its runtime
`NetworkMeta`, plus a dated `last_verified`. `OperationCapability` already
supports a per-operation status override.

What does not exist is a written standard for what *evidence* earns each status.
The contributor skill says only that "promotion to `production` needs live
acceptance testing"; the rest is implicit. The top product risk in the roadmap
is breadth without trust: a user can read 86 adapters as 86 reliable
integrations when most have never been exercised against a live account.

Claim status is a cross-network public contract. Downstream surfaces, the README
table, REPORT.md, and eventually a verified-outcome scorecard all read it. It
needs one standard that a maintainer and a contributor can apply consistently,
and that distinguishes *availability* from *verified reliability* in plain
language.

This record sets the standard. It does not verify any adapter and does not
change runtime behaviour.

## Decision

Adopt an evidence-strict, no-auto-promotion promotion model. A status is a claim
about verification evidence, not about how much code exists or who wrote it.

### Evidence required per status

- **`experimental`** (default for every new adapter)
  - Implements the adapter contract from `src/shared/types.ts`.
  - Ships scrubbed fixtures and passes the offline checks: `npm run typecheck`,
    `npm run lint`, the adapter's tests, and
    `npm run validate:network -- <slug>` manifest validation.
  - No live-account verification is required.
  - Public meaning: *available; not yet verified against a live account.*

- **`partial`**
  - Everything required for `experimental`, plus at least one canonical
    operation verified against a real account, with the date recorded in
    `last_verified`.
  - Operations that are not verified, or are known to be unsupported or
    degraded, are declared honestly. Where verified and unverified operations
    coexist, use the per-operation `OperationCapability` status so the gap is
    visible at operation granularity, not hidden behind one network-level word.
  - Public meaning: *partially verified; specific operations are proven, others
    are not.*

- **`production`**
  - Everything required for `partial`, plus a live acceptance test against a
    real account covering **every operation the adapter declares as supported**,
    with `last_verified` inside the freshness window below.
  - Known limitations are current and honest.
  - Promotion is an explicit maintainer decision recorded in the promoting PR;
    it is never automatic.
  - Public meaning: *verified reliable for the declared operations as of
    `last_verified`.*

- **`unsupported`** is unchanged: the side or network is not implemented and no
  reliability claim is made.

Live acceptance evidence is gathered outside public CI. Public CI must never be
required to hold real affiliate credentials.

### Freshness and reconsideration

- A `partial` or `production` claim is only valid while `last_verified` is
  within **180 days**. Beyond that the live evidence is stale and the claim must
  be reconsidered.
- A credible signal triggers **investigation**, not immediate demotion. A
  credible signal is a plausible report or observation that an operation the
  status depends on may be failing: an upstream break, an auth or contract
  change, a `NetworkErrorEnvelope` in the field, or a network changing an API
  contract the adapter relied on for its evidence. While such a report is
  unresolved, disclose it in `known_limitations` so the claim is not presented
  as more certain than the current evidence supports.
- A status is **demoted** when either:
  - `last_verified` ages past the 180-day window without re-verification; or
  - a failure is **reproduced or otherwise confirmed**, not merely reported. An
    account-specific, mistaken, or unsupported-operation report that cannot be
    confirmed does not lower a public claim.
- Demotion is honest and routine, not a failure event. The demoting change
  lowers `claim_status` (or the affected per-operation status), refreshes
  `known_limitations`, and states why. Re-verification against a live account
  restores the higher status with a new `last_verified`.

### Network adoption, ownership, and paid certification

- A network adopting, owning, maintaining, or **paying for** an adapter is
  supporting context only. It never auto-grants any status and never lifts
  `claim_status` on its own.
- A network-owned or network-certified adapter clears exactly the same evidence
  bar as any other adapter. Payment or certification may fund or accompany the
  live acceptance work, but the *claim* still rests on the evidence, not on the
  relationship.
- This keeps the public claim independent of commercial arrangements and closes
  the pay-to-play gap flagged against the roadmap's "network-certified adapters"
  monetisation line: certification can be a paid service, but it can never move
  an adapter's reliability claim without the evidence the claim requires.

### Public surface

Every surface that exposes status must distinguish availability from verified
reliability in plain language:

- the generated `README.md` table and `REPORT.md` label `experimental` as
  *available, not yet verified*, and reserve *verified* language for `partial`
  and `production`;
- per-network setup docs and `network.json` carry the same distinction;
- a future verified-outcome scorecard counts only `partial` and `production`
  evidence, never raw adapter count.

## Consequences

- Users gain an honest signal: a status now means a specific, dated level of
  live evidence, and stale or broken evidence demotes the claim rather than
  lingering.
- Contributors get a clear, reachable ladder. `experimental` stays achievable
  with offline work alone, so community contribution is not blocked; only
  `partial` and `production` require live evidence.
- The standard is deliberately strict at the top. `production` requires
  full-operation live coverage inside a freshness window, so it will be earned
  slowly and rarely, which is the intended trade for trustworthiness.
- The freshness window adds an ongoing re-verification obligation for promoted
  adapters. That maintenance cost is accepted as the price of an honest claim.
- The independence rule means a commercial certification programme cannot be
  sold as a shortcut to a `production` badge; that boundary must hold in any
  later monetisation decision.

## Implementation follow-ups

Each implementation follow-up remains a separate, small change:

- Document the four statuses, the 180-day freshness window, and the
  reconsideration and demotion rules in `.claude/skills/contribute/SKILL.md` and
  the public docs.
- Teach `scripts/validate-network-json.ts` to flag a `partial` or `production`
  adapter whose `last_verified` is missing or older than the freshness window.
- Update the `README.md` and `REPORT.md` generators so status wording
  distinguishes availability from verified reliability.
- Reconcile the "network-certified adapters" monetisation line in the roadmap
  with the independence rule above before that line is treated as direction.
- Leave all 86 current statuses as they are; this record sets the gate, it does
  not re-classify adapters. Re-classification happens per adapter, with
  evidence, under the new gate.
