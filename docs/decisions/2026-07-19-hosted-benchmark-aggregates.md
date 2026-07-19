# Hosted programme benchmarks (aggregate-only)

- **Date:** 2026-07-19
- **Status:** Proposed
- **Affects:** the hosted service (`hosted/`, `src/hosted-transport/`,
  `src/hosted-digest/`), `PRIVACY.md`, the local-first boundary in
  `docs/product/manifesto.md` (Principle 2), the trust/security and privacy
  copy on the marketing site, and a new server-side benchmark computation and
  store.
- **Supersedes:** clause 4 ("What the keys are used for") of the **accepted**
  `docs/decisions/2026-07-12-hosted-credential-custody.md`, which states
  "**Never aggregation across tenants, never analytics, never any purpose
  beyond serving the key's owner.**" This record deliberately narrows that
  absolute prohibition to permit one bounded exception: opt-in, aggregate-only,
  k-anonymous benchmarks. It does not touch any other custody clause. **This is
  a change to what the project is allowed to do with data, not a clarification
  of it** — accept it as a boundary move or reject it to keep the line absolute.
- **Builds on:** `docs/decisions/2026-06-13-privacy-first-telemetry.md`. Note
  this record goes **beyond** the telemetry allowlist rather than fitting inside
  it: telemetry's "never collected" list explicitly includes earnings figures
  and click data, which are the inputs these benchmarks derive from. Benchmarks
  therefore establish a distinct, new data-use contract (below), governed by its
  own opt-in and k-anonymity rules — they are not covered by the telemetry
  decision.
- **Sequencing:** this record must be accepted before any benchmark feature is
  implemented, and the superseded custody clause + `PRIVACY.md` + manifesto
  Principle 2 + site trust copy must be updated in lockstep on acceptance.

## Context

The hosted product-led-growth roadmap
(`~/.claude/plans/now-that-we-have-agile-wave.md`) identifies its strongest
LinkedIn hook as a benchmark: "your programme versus the category median". A
number the operator can react to is what makes a shared card spread. But a
cross-tenant benchmark means computing statistics over more than one hosted
user's data, which touches the brightest line the product holds: credentials and
affiliate data never leave the user's control, and any phone-home signal is
opt-in and aggregate-only. Benchmarks cannot ship on vibes; the privacy and
custody contract has to be settled first. This record takes that position so the
feature is either buildable under explicit rules or deliberately declined.

Be clear about what is at stake: the accepted custody decision
(`2026-07-12-hosted-credential-custody.md`, clause 4) currently promises the
project will do "never any purpose beyond serving the key's owner", and the
trust page, `PRIVACY.md`, and manifesto Principle 2 all reflect that promise.
Permitting benchmarks **moves that line**. The case for moving it: the data
stays the user's, contributing is opt-in and revocable, only k-anonymous
derived aggregates ever exist, and the user gets something back they cannot get
alone (a real peer comparison). The case against: it is the first time hosted
data is used for anything beyond the individual owner, and the promise "only
ever used to serve you" becomes "only ever used to serve you, plus opt-in
anonymous benchmarks" — a materially different sentence on the trust page. This
is Rob's call to make consciously, not a formality to nod through.

## Decision

Permit **opt-in, aggregate-only, k-anonymous** programme benchmarks derived from
hosted users' own programme data, computed server-side inside the hosted
boundary, never exposing any individual tenant's data. This narrows custody
clause 4's absolute "never aggregation across tenants" to this single bounded
exception and updates `PRIVACY.md`, manifesto Principle 2, and the site trust
copy to match; every other custody guarantee (bring-your-own-key, read-only,
decrypt-only-at-call-time, export, hard delete) is unchanged.

### Default and consent

- **Off by default. Opt-in only.** A tenant's data contributes to benchmark
  aggregates only after an explicit, revocable dashboard consent, matching the
  telemetry precedent. Revoking consent removes future contribution.
- Seeing a benchmark and contributing to it are recorded as separate choices;
  the consent copy states plainly what is and is not shared.

### What may be aggregated

- **Only derived, non-identifying metrics**, bucketed by category/vertical and
  period: for example EPC, conversion rate, reversal rate, average order value,
  and effective commission rate.
- **Never**: raw transactions, click-level data, publisher identities,
  advertiser or brand identities, credentials, account identifiers, or any figure
  attributable to a single tenant.

### k-anonymity floor

- A benchmark bucket (category × metric × period) is computed and shown only when
  it aggregates at least **K distinct tenants** (proposed K = 5; tunable upward,
  never below). Under the floor, the surface shows "not enough data yet" and
  never a near-single-tenant number that could de-anonymise a contributor.

### Custody and residency

- Aggregation runs server-side within the hosted boundary. Inputs are decrypted
  only at compute time per the custody contract; the pipeline stores **only the
  aggregate outputs**, never the per-tenant inputs, and the stored aggregates
  carry no tenant linkage.

### Display and attribution

- A benchmark artifact labels the comparison as "category median, N programmes"
  and never names or reveals contributors. It is subject to the same free-first
  gating as the rest of the PLG artifacts.

## Rejected alternatives

- **No benchmarks.** Keeps the bright line simplest and needs no new contract,
  but forgoes the roadmap's strongest growth hook. Rejected in favour of a
  bounded, opt-in path.
- **Third-party or industry dataset instead of cross-tenant compute.** Avoids
  touching tenant data, but the numbers are stale, generic, and not the
  operator's real peer set, so the hook loses its credibility. Rejected as a
  primary source; may supplement where own-data buckets are under the k-floor.
- **Opt-out rather than opt-in.** Larger sample, but weaker consent and
  inconsistent with the telemetry decision. Rejected.

## Consequences

- A new server-side aggregate store and compute path, a new dashboard consent
  toggle, a new `PRIVACY.md` section, and a category taxonomy are required.
- Benchmarks become a **gated feature**: no implementation may land until this
  record is accepted. Until then, only discovery and disposable prototypes are
  allowed, per `AGENTS.md`.
- The k-floor means small categories show no benchmark until enough tenants
  opt in; this is deliberate and must be surfaced honestly, not hidden.

## Implementation follow-ups (after acceptance)

- **Amend the superseded documents in lockstep** (these are the boundary-move
  edits, not optional): narrow clause 4 of
  `2026-07-12-hosted-credential-custody.md` with a pointer to this record, add
  the benchmark section to `PRIVACY.md`, revise manifesto Principle 2, and
  update the site trust/security and privacy copy so no surface still promises
  "only ever used to serve you" without the opt-in-benchmark exception.
- Implement consent capture + revocation and the k-anonymity floor.
- Build the aggregate store and the server-side computation inside the hosted
  boundary; store outputs only.
- Define the category/vertical taxonomy.
- Add the benchmark artifact template to the design kit and wire it into the
  weekly launch calendar as the gated week it unblocks.
