# The doing layer

This document is the Phase 0 design for action support in `affiliate-mcp`.
It is a direction and architecture note, not shipped behaviour. Nothing here
changes runtime code. It exists so the contract changes, the consent model,
and the network reachability work can be reviewed before any write lands.

Today the server is read-only by design. Every canonical operation is a GET,
the advertiser clients throw on any non-GET, and `generateTrackingLink` is the
single quasi-write. Adding actions introduces a second risk class, so the whole
system has to learn to handle it. This note sets out how.

It has a companion: `browser-doing-layer.md` covers actions that have no API and
must go through the network's dashboard. This document covers the API side and
the consent and audit model both share. Read them together.

## What "doing" means

Actions are the things an operator does in a network dashboard that change
state. Grouped by who is acting:

**Publisher side** (acting on your own account)

- Apply to or join a programme; leave or pause one.
- Generate and refresh deep or tracking links (partly exists today).
- Raise a query or dispute on a missing or reversed transaction.
- Request a rate increase or placement.
- Edit profile, payment, or registered domains.

**Advertiser, brand, or agency side** (acting on a programme)

- Approve or decline a publisher application.
- Pause, suspend, or reactivate a publisher.
- Adjust commission rates; create commission groups or tiers; issue tactical
  bonuses.
- Validate, approve, or reverse transactions (the validation queue).
- Create or pause a campaign; manage vouchers, offers, creative, or product
  feeds.
- Message a publisher.

**Cross-cutting: permissions from a client.** Agencies act on a brand's
programme on the client's behalf. This is a delegation problem, not a single
action: a client grants the agency authority scoped by which brand, which class
of action, within what limits, and for how long. The repo already addresses a
brand (`brands.json`, `DiscoveredBrand.apiEnabled`) but has no notion of being
*authorised to act on* it. The consent layer fills that gap, and it is the
first slice we build.

### One honest constraint

This document covers actions the doing layer performs through a network's public
API. Many dashboard actions have no API. Those are not abandoned: they are
handled by the browser doing layer, the companion design in
`browser-doing-layer.md`, under the revised product boundary in `AGENTS.md` and
`manifesto.md`. Either way we stay honest. Part of Phase 0 is a per-network
reachability matrix (see below); we do not pretend an action is available
because a workflow would be convenient, whether by API or by browser.

## Principles

The doing layer must satisfy these, in addition to the existing principles in
`AGENTS.md` (principle 4.1, resilience as the only path, honest network truth).

1. **Reads and writes are different risk classes.** Every operation is
   classified `read`, `write`, or `destructive`, and the classification is
   visible in the generated tool.
2. **Capability-gated, opt-in, default off.** A write exists only where an
   adapter declares it and it has been verified against a real account. This
   mirrors the existing read-only guard: the guard lifts per operation, not
   wholesale.
3. **Authorisation before execution.** A local consent record decides whether
   the operator may perform an action class against a brand. The server checks
   it before dispatching any write. It fails closed.
4. **Confirmation is the default; standing consent is what lets you skip it.**
   See the graduated-trust model below. This is the central design decision.
5. **No blind retries.** Writes are mostly non-idempotent. The write resilience
   profile never retries an ambiguous failure (a timeout after the request was
   sent) and uses idempotency keys where the API supports them.
6. **Append-only audit.** Every planned and applied action, with its outcome,
   is appended to a local audit log and surfaced in `doctor`. This is what lets
   a client see what was done on their behalf.
7. **Honest write truth.** `network.json` and `REPORT.md` gain a write column.
   Gated or unverified writes are labelled, never shipped silently.

## Graduated trust: how confirmation and "skipping permissions" relate

We want two things that seem opposed: a safe default that never executes a
surprising change, and the ability for a trusted agent to act without prompting
once a client has granted authority. The consent record reconciles them. It is
the single place that decides, for a given action, whether to prompt or to
proceed.

There are three trust levels for any `(brand, network, action class)`:

- **Prompt always (default).** No standing grant exists. The action runs as two
  phases: a `plan` call previews the effect with no side-effect and returns a
  confirmation token; an `apply` call executes only with that token. A human or
  agent must look at the preview and confirm.
- **Standing consent within bounds.** The client has granted authority for this
  action class on this brand, with limits (for example a maximum commission
  change, a per-day count cap, an expiry date). Inside the bounds the agent may
  call `apply` directly, with no `plan` and no prompt. The grant is recorded and
  every use is audited. This is the "skip permissions" behaviour, made safe by
  being bounded, expiring, and logged.
- **Out of bounds or expired.** Falls back to prompt-always, even if a grant
  exists for the action class, because the specific action exceeds what was
  authorised.

The point is that skipping a prompt is never a global setting. It is the
consequence of a specific, bounded, expiring grant the client made. Revoking
the grant returns the action to prompt-always immediately.

This is the same model the browser doing layer uses, and it is the seam to
reconcile with the API-gap primitive in PR #5 (see
`browser-doing-layer.md`). That primitive's phrasing rules require the agent to
ask the user every time and forbid a silent fallback. That rule is the
prompt-always default, stated for the browser case. A standing grant for the
action class is the carve-out: within bounds it lets the browser handoff proceed
without the per-action question, still recorded and audited. One trust model
governs both API writes and browser handoffs; only the transport differs.

### Consent record shape (proposed)

Stored at `~/.affiliate-mcp/consent.json`, owned by a wizard, readable by the
server at dispatch time. Local-first, consistent with credentials and
`brands.json`.

```jsonc
{
  "version": 1,
  "grants": [
    {
      "subject": "acme",               // brand slug from brands.json, or "self" for the operator's own account
      "network": "awin-advertiser",    // or "*" for all networks bound to the subject
      "actionClass": "publisher.approve",
      "mode": "standing",              // "standing" skips prompts within bounds
      "bounds": {
        "maxPerDay": 25,
        "expiresAt": "2026-09-30T00:00:00Z"
      },
      "grantedBy": "client@acme.example",
      "grantedAt": "2026-05-30T00:00:00Z",
      "note": "Q3 onboarding push; pre-vetted applicants only"
    }
  ]
}
```

Action classes are coarse on purpose (`publisher.approve`,
`publisher.decline`, `commission.adjust`, `transaction.validate`,
`link.generate`). A client reasons about classes of authority, not individual
endpoints. The map from class to concrete adapter operation lives in code.

`assertAuthorised(brand, network, actionClass, magnitude?)` is the one entry
point. It returns `prompt`, `proceed`, or `deny`, and the server branches on
the result. `magnitude` lets a bound such as "max 5 percentage points" be
checked against the actual change in the planned action.

## Architecture

Layers, smallest blast radius first.

- **Contract** (`src/shared/types.ts`). Add a `WriteOperation` union and an
  operation classification; add consent types; add `NetworkMeta.writeSupport`;
  add a write resilience profile. This touches the stable shared contract, so
  per `AGENTS.md` it needs an issue and review before it lands. The proposal is
  scoped in the next section.
- **Authorisation** (new `src/shared/consent.ts`). Loads `consent.json`,
  exposes `assertAuthorised`, fails closed, never throws an action through on a
  parse error. Surfaces a new envelope type (`authorisation_denied`) or reuses
  `config_error`; to be decided in Phase 1.
- **Audit** (new `src/shared/audit.ts`). Append-only writer to
  `~/.affiliate-mcp/audit.log`. One line per plan, apply, and outcome.
- **Execution** (per-adapter `client.ts`). Selectively lift the read-only
  guard; route writes through `withResilience` with the no-blind-retry profile;
  attach idempotency keys where supported. Each network owns its writes; no
  cross-adapter changes.
- **Tooling** (`src/tools/generate.ts`). Generate write tools only for adapters
  that declare support; tag them with MCP tool annotations
  (`readOnlyHint`, `idempotentHint`, `destructiveHint`); emit the `plan` and
  `apply` pair for prompt-always classes, and a direct `apply` path the server
  gates through consent.
- **Skills.** Doing workflows that narrate preview then confirm: clear the
  validation queue, approve qualified applications, pause underperformers.

## Contract change proposal (needs an issue before code)

This is the shared-types delta Phase 1 would need. It is strictly additive so
existing publisher adapters keep compiling unchanged.

- `OperationClass = 'read' | 'write' | 'destructive'` and a lookup from
  operation name to class.
- `WriteOperation` union, starting empty in code and growing per network, kept
  separate from the read `AdapterOperation` union.
- `NetworkMeta.writeSupport: 'none' | 'partial' | 'full'`, defaulting to
  `'none'`, inert until an adapter opts in (the same pattern as the existing
  inert `side` and `credentialScope` fields).
- A write resilience profile in `ResilienceConfig`: `retries: 0` for
  non-idempotent writes, an explicit `idempotencyKeyHeader?: string`, and a
  rule that ambiguous failures never retry.
- Consent types: `ConsentGrant`, `ConsentMode`, `ConsentDecision`,
  `ActionClass`.
- A new error envelope type `authorisation_denied` (or a documented reuse of
  `config_error`).

## Per-network reachability matrix (to complete in Phase 0)

For each network and action class: does a public, documented API exist, and is
it verified. This is the honest-truth gate before any write is built. Initial
shape, to be filled from each network's API docs and `docs/findings/`:

| Action class | Awin | CJ | Impact | Rakuten |
| --- | --- | --- | --- | --- |
| `link.generate` | TBC | TBC | partial (POST today) | TBC |
| `publisher.approve` | TBC | TBC | TBC | TBC |
| `publisher.decline` | TBC | TBC | TBC | TBC |
| `commission.adjust` | TBC | TBC | TBC | TBC |
| `transaction.validate` | TBC | TBC | TBC | TBC |

A `TBC` becomes `yes`, `no`, or `gated` only with a docs citation.

## Phasing

- **Phase 0 (this note).** Decide and document: taxonomy, reachability matrix,
  consent model, plan/apply contract, write resilience rules, audit model. Open
  the shared-types issue.
- **Phase 1.** Safety rails, no live writes. Land the contract delta, the
  consent and audit modules, and the plan/apply tool scaffolding. All default
  off. Fixture-tested. Nothing writes yet.
- **Phase 2.** One real write, on the reference adapter, end to end: the safest
  reversible action, with plan, apply, consent, and audit. Acceptance-tested
  against a real account before it leaves `experimental`.
- **Phase 3.** Expand the action set, or a second network: approve and decline,
  commission changes, validation.
- **Phase 4.** Agency consent and delegation UX: the permissions-from-a-client
  wizard, with bounds, expiry, and an exportable record the client can review.

## Open questions

- Where is the authority for a grant. Local file is the v1 answer, but a client
  signing or approving a grant out of band is the trustworthy version.
- Magnitude bounds need a unit per action class (percentage points for
  commission, count for approvals). Define these alongside each write.
- How `doctor` should present active grants and recent audited actions without
  leaking anything sensitive.
- Whether `plan` tokens expire, and how short their lifetime should be.
