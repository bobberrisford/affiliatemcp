# Browser-handoff contract: public shape, audit semantics, consumer boundary

- **Date:** 2026-06-12
- **Status:** Accepted (2026-06-20)
- **Affects:** `src/shared/types.ts` (contract extension, implementation PR),
  `src/tools/generate.ts` (surfacing handoffs), the future consent/audit
  primitives, `REPORT.md` and `network.json` labelling of browser-driven
  operations
- **Depends on:** nothing; this is the foundation decision. Closed PRs
  [#5](https://github.com/bobberrisford/affiliatemcp/pull/5) and
  [#23](https://github.com/bobberrisford/affiliatemcp/pull/23) are superseded
  design input, not dependencies.

## Context

`main` already accepts browser-driven operations in principle. The product
boundary in `AGENTS.md` says: prefer a network's public, documented API; where
no usable API exists, automate the user's own authenticated session, keep
browser-driven operations behind the same typed contract, and label them as
more brittle. What `main` does not yet have is that typed contract.

Two closed PRs prototyped it and diverged:

- **PR #5** (RFC: API-gap + browser-handoff primitive) proposed
  `ApiGapResponse` with `kind: 'api-gap'`, the payload under a nullable
  `browserFallback`, `inputs: Record<string, unknown>`, and a structured
  `verify: { url?, expect }`. The null-fallback case carries a `userMessage`
  inviting the user to teach the gap.
- **PR #23** (doing layer: consent, audit, guarded actions) shipped an
  Impact-local `applyToProgram` emitter with `kind: 'browser_handoff'`, an
  `apiGapReason` field, the payload under `browserHandoff`,
  `inputs: Record<string, string>`, and a free-text `verify` string. It also
  shipped consent and audit machinery in the same PR, and its `dispatchAction`
  recorded `succeeded` when `run()` resolved.

Maintainer triage on closing both: the public handoff contract, audit
semantics, and consumer boundary still need an explicit decision; preserve the
PRs as design input and replace them with a small decision PR before a fresh
implementation (#5), split into separate decision docs, consent/audit
primitives, and handoff/action wiring PRs in dependency order (#23).

This record settles the four open questions: the single public contract shape,
what the audit trail may claim, where the consumer boundary sits, and the
safety-constraint floor.

## Decision

### 1. One public contract shape: `ApiGapResponse` with a nullable `BrowserHandoff`

Converge on PR #5's shape, taking its three stronger elements, with PR #23's
field-level improvements folded in where they are genuinely stronger:

```ts
/** Network-agnostic handoff payload. One consumer reads every handoff. */
interface BrowserHandoff {
  /** Plain-English goal, e.g. "Apply to programme 12345 on Impact". */
  goal: string;
  /** Reviewed network-owned https location; never a caller- or model-supplied arbitrary URL. */
  startingUrl: string;
  /** Minimum non-secret values needed for the operation. JSON-serialisable; schema is per-operation. */
  inputs: Record<string, unknown>;
  /** Shared default floor plus per-action additions. See decision 4. */
  constraints: string[];
  /** True if the flow submits, changes, or sends anything. Forces confirm-before-submit. */
  mutates: boolean;
  /** How the outcome is confirmed: a URL to revisit and the state to expect there. */
  verify: { url?: string; expect: string };
  /** Optional bounded hints (stable selectors, known steps). Never executable or open-ended instructions. */
  hints?: string[];
}

/** Normal return value for an operation the network's API does not expose. Never thrown. */
interface ApiGapResponse {
  kind: 'api-gap';
  network: NetworkSlug;
  operation: string;
  /** Factual one-liner naming the gap. */
  reason: string;
  /** Verbatim sentence the calling agent shows the user. */
  userMessage: string;
  /** Null when no fallback path is known; the message invites the user to teach the gap. */
  browserFallback: BrowserHandoff | null;
}
```

Element-by-element rationale:

- **One discriminator, `kind: 'api-gap'`.** The discriminator names the
  condition, not the mechanism. The gap exists whether or not a fallback is
  known, so the no-fallback case uses the same kind with
  `browserFallback: null`. PR #23's `kind: 'browser_handoff'` names the
  mechanism and has no honest value for the no-fallback case; rejected.
- **Structured `verify: { url?: string; expect: string }`.** A consumer (or a
  human) needs to know where to look and what to look for; a future
  verify-driven audit closure (decision 2) needs machine-usable parts. PR #23's
  free-text `verify` string cannot support either; rejected.
- **Nullable `browserFallback`.** Honest network truth includes "we know the
  gap and have no browser route yet". Without the null affordance, adapters
  would be forced to either invent a fallback or throw, and throwing is wrong:
  an API gap is an expected, documented condition, not a failure, so it must
  not travel through `NetworkErrorEnvelope` (principle 4.1 covers failures; a
  gap is not one). An actual outage during any operation still surfaces
  through the envelope as normal.
- **`inputs: Record<string, unknown>`, JSON-serialisable.** Real flows carry
  lists (PR #5's `promotionalMethods: string[]`). PR #23's
  `Record<string, string>` forces stringly-typed encodings; rejected. The
  constraint is JSON-serialisable values, because the payload crosses the MCP
  boundary verbatim.
- **`reason`, not `apiGapReason`.** The envelope's `kind` already says this is
  an API gap; the prefix is redundant. The field's job (a factual one-liner
  for logging and agent reasoning, taken from PR #23's doc comment) is kept.
- **`mutates: boolean`, not the literal `true`.** Read-only gaps exist (a
  report only visible in a dashboard). The flag drives the
  confirm-before-submit constraint and the audit event, so it must be able to
  be false.

The types live in `src/shared/types.ts` next to `NetworkErrorEnvelope`. That
is a shared-contract change and a risk-based review item; the implementation
PR stays draft until this decision merges. Per the existing "two networks
first" convention, the emitting operation does not join `NetworkAdapter` until
a second network emits a handoff for the same goal; the first emitter is
adapter-local, but it speaks this shared shape from day one.

### 2. Audit semantics: a distinct `handoff_emitted` event, never `succeeded`

When an emitter's `run()` resolves with an `ApiGapResponse`, the only thing
that has happened is that a handoff struct was produced. The mutation, if any,
has not happened on the dashboard and may never happen. PR #23's
`dispatchAction` recorded `succeeded` at that point; under principle 4.1 that
is invented success, and it is rejected.

The decision:

- The audit vocabulary gains a distinct event, `handoff_emitted`, recorded
  when an `ApiGapResponse` with a non-null `browserFallback` is returned
  through the tool layer. It claims exactly what is true: a handoff was
  produced and shown.
- `succeeded` is reserved for outcomes the server itself observed. No code
  path may record `succeeded` for a handoff.
- Verify-driven closure is the follow-up, not part of this contract: once a
  consumer exists, it reports back against the structured `verify` block and a
  closing event (for example `verified` or `verify_failed`) completes the arc
  `handoff_emitted -> verified | verify_failed`. Until then, a
  `handoff_emitted` entry with no closing event is the honest record: the
  server handed off and does not know the outcome.
- For per-day consent caps, `handoff_emitted` for a mutating handoff counts
  against the budget, the conservative basis PR #23 already used for
  `applied`: a handoff that may have mutated state consumes the day's
  allowance.

### 3. Consumer boundary: emitters are pure; consumers are out of scope

Nothing in this repository drives a browser. An emitter is a pure,
side-effect-free function from typed input to `ApiGapResponse`: no `fetch`, no
session, no DOM, no retries, nothing for `withResilience` to wrap. The handoff
is carried out by a human following the payload, or later by a consumer skill
(for example one driving the Claude in Chrome extension, per PR #23's Tier A
design). Consumers are explicitly outside this contract and arrive in their
own PR; the `ApiGapResponse` shape is the only coupling point between emitter
and consumer, which is what lets one general consumer serve every network.
Accepting this record authorises neither an emitter implementation nor a
consumer or general browser automation. Each follows the dependency order
below and receives its own scoped review.

### 4. Safety-constraint floor: shared defaults every handoff inherits, plus per-action additions

`constraints` is composed, not free-form per adapter. A shared default floor,
defined once in shared code and inherited by every handoff, contains at
minimum:

- do not enter, modify, or confirm payment or payout details;
- stop and hand back to the user on any login, MFA, or re-authentication
  challenge;
- do not repeat a mutation that already appears completed (for example, do not
  re-apply when the state already reads pending or approved);
- when `mutates` is true, show the user a summary of what will be submitted
  and wait for explicit confirmation before submitting;
- never accept terms, compliance checkboxes, or consents the user has not
  seen.

Adapters append per-action constraints (PR #5's "stop if the apply button is
missing", PR #23's "do not alter the campaign ID") but cannot remove or
override the floor. Rationale: both prototype emitters independently re-typed
overlapping subsets of these rules; per-action-only constraints make the floor
a convention that drifts, and one missed constraint is a safety hole. The
exact wording of the floor is settled in the implementation PR; its existence,
its inheritance, and the five categories above are settled here.

The handoff channel never weakens action authority. A browser handoff that
represents a write inherits the same effect, default authority tier, consent
floor, and audit obligations as the equivalent API write under the accepted
action-capability map. Pure emission is not permission to execute the
represented action.

### 5. Sequencing

Dependency order, per the #23 closure:

1. this decision PR (docs-only) merges first;
2. a consent/audit primitives PR: the append-only audit log and consent gate
   from PR #23, reworked so the event vocabulary includes `handoff_emitted`
   and never records `succeeded` for a handoff;
3. a handoff/action wiring PR: the `ApiGapResponse` and `BrowserHandoff` types
   in `src/shared/types.ts`, the shared constraint floor, the first emitter
   (Impact `applyToProgram`), and tool-layer surfacing;
4. later, in its own PR: the consumer skill and verify-driven audit closure.

Each dependent PR stays draft until its foundation merges.

## Security

- Emission is read-only on the world: a pure emitter cannot mutate network
  state, so the contract itself adds no new write path to the server.
- Mutation risk concentrates in the consumer, which is out of scope here and
  will get its own risk-based review; the constraint floor and the
  `mutates`-forces-confirmation rule are the contract-level mitigations it
  inherits.
- The payload must never carry credentials, session tokens, or cookies;
  sensitive affiliate or account data is excluded as well. `startingUrl` is
  selected by reviewed adapter code from a network-owned https origin and
  bounded path; callers and models cannot supply an arbitrary navigation
  target.
- `goal`, `constraints`, and `hints` are bounded declarative data for the named
  operation. They cannot carry scripts, executable content, or open-ended
  instructions that let a caller override the shared safety floor.
- Audit honesty is a security property: recording `succeeded` for an
  unobserved outcome would let the trail overstate what was done on a user's
  or client's behalf. `handoff_emitted` keeps the trail truthful.

This decision touches shared/public contracts, write actions, consent, and
audit behaviour, so it is a risk-based review item for `@offmann`.

## Rejected alternatives

- **PR #23's envelope shape** (`kind: 'browser_handoff'`, free-text `verify`,
  `inputs: Record<string, string>`, payload key `browserHandoff`, mandatory
  `mutates: true`). Each element is weaker than the #5 counterpart for the
  reasons in decision 1: no honest no-fallback case, no machine-usable verify,
  stringly-typed inputs, and no read-only handoffs.
- **Recording `succeeded` when `run()` resolves.** Invented success; violates
  principle 4.1. Rejected outright.
- **Closing the audit arc only on consumer report-back, from day one.** No
  consumer exists yet, so every handoff would sit permanently open and the
  per-day cap would have no basis event. Adopted as the follow-up shape
  (decision 2), not the initial requirement.
- **Per-action-only constraints.** Both prototypes already drifted apart on
  the same safety rules; a floor that every adapter must re-type is a floor
  that will eventually be missed. Rejected in favour of shared defaults plus
  additions.
- **Throwing for API gaps** (a `NotImplementedError` or an error envelope). A
  documented gap is an expected condition the agent should reason over, not a
  failure; throwing would also erase the fallback affordance. Rejected.
- **One combined PR for contract, primitives, emitter, and consumer.** PR #23
  demonstrated the cost: 3,160 additions across consent, audit, CLI, tools,
  and an adapter, unreviewable as one outcome. Rejected; see sequencing.

## Consequences

- `src/shared/types.ts` gains two types next to `NetworkErrorEnvelope` in the
  wiring PR; this is a deliberate, reviewed exception to "do not modify
  `src/shared/`", authorised by this decision.
- The audit event vocabulary is fixed before the primitives PR is written, so
  the consent/audit PR does not re-import #23's `succeeded`-on-resolve bug.
- The tool layer will surface `ApiGapResponse` as a normal result; MCP clients
  can branch on `kind` and the shape becomes stable once shipped, like
  `NetworkErrorEnvelope`.
- `REPORT.md` and `network.json` gain honest labelling for browser-driven
  operations (API-backed versus browser-driven, per the product boundary);
  exact representation is settled in the wiring PR.
- Handoffs without a consumer degrade to guided manual steps: the user follows
  `startingUrl`, `inputs`, and `verify` by hand. That is acceptable and
  matches local-first, human-supervised operation.

## Implementation follow-ups

1. Consent/audit primitives PR: append-only audit log with the
   `handoff_emitted` event, consent gate, per-day caps counting mutating
   handoffs (draft until this decision merges).
2. Handoff/action wiring PR: shared types, shared constraint floor, Impact
   `applyToProgram` emitter rebuilt on the converged shape, tool-layer
   surfacing, scrubbed fixtures and tests (draft until the primitives PR
   merges).
3. Consumer skill PR plus verify-driven closure events, later, with its own
   risk-based review.
4. Documentation pass: `REPORT.md` and setup docs labelling browser-driven
   operations as more brittle, alongside the wiring PR.
