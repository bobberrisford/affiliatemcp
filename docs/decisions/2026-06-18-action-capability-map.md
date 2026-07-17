# Action capability map: a channel-aware inventory of the doing surface

- **Date:** 2026-06-18
- **Status:** Accepted (2026-06-19)
- **Affects:** a future provider-neutral action descriptor, action discovery in
  the MCP tool layer, and later consent, audit, and policy binding
- **Depends on:** the accepted action-authority layer
  ([`2026-06-12-action-authority-layer.md`](./2026-06-12-action-authority-layer.md)).
  The proposed browser-handoff and Impact contracts records are related design
  inputs, not accepted dependencies and not authorised by this record.

## Context

The shipped network surface is read-oriented. Operators can discover registered
networks with `affiliate_list_networks`, and they can use
`affiliate_run_diagnostic` or an adapter's `capabilitiesCheck` to inspect live
read support, credential validity, latency, and known limitations. Those
surfaces already own read-capability truth.

The accepted action-authority record establishes a separate doing layer. It
distinguishes reads, proposals, policy-authorised writes, and writes requiring
human sign-off. Proposed records explore the first Impact write and a typed
browser handoff, but neither is accepted on the date of this decision.

What is missing is a small, queryable inventory for doing surfaces: actions an
adapter can advise on, submit to an API, or represent as an API gap. An operator
should be able to see the route and default approval posture before configuring
an opt-in write credential. A future deterministic policy and audit trail also
need stable identifiers for the concrete actions they govern.

A second catalogue of every existing read would not solve that problem. It
would duplicate the adapter contract and `capabilitiesCheck` across 86 adapters,
create another metadata-drift surface, and add a broad abstraction before the
roadmap's write, consent, audit, and browser foundations are proven.

## Decision

Introduce an **action capability map** for the doing surface. It is descriptive,
read-only metadata. Reading the map never executes an adapter operation, emits a
browser handoff, performs a live authentication probe, evaluates authority
policy, or mutates local or network state.

### 1. Scope: doing surfaces and explicit gaps, not a duplicate read catalogue

The map contains explicitly declared advisement and write actions, plus API gaps
that have a typed browser-handoff route or are deliberately recorded with no
route. A read-only browser gap may also appear because it needs channel and gap
semantics that the existing API-read capability surface cannot express.

Existing API reads remain discoverable through the generated tool registry,
`affiliate_list_networks`, and `affiliate_run_diagnostic`. They are not copied
into a manually maintained `CANONICAL_READ_ACTIONS` list or repeated on every
adapter. Consumers that need both views compose network/read capability with the
action map; each source retains one clear responsibility.

`effect: read` therefore remains a valid classification, but it does not require
the seven publisher operations or advertiser reads to be redeclared.

### 2. Three orthogonal classifications

Each map entry carries three independent classifications:

- **Channel:** `api`, `browser`, or `none`.
  - `api` means the owned operation can reach a documented network endpoint.
  - `browser` means the adapter can return the typed handoff accepted by the
    browser-handoff decision. It never means this repository opens, controls,
    or observes a browser. No browser entry may ship while that contract remains
    proposed.
  - `none` records a known API gap for which no typed route exists. It is an
    explicit unsupported state, not an executable capability, and is never
    currently available.
- **Effect:** `read`, `advisement`, or `write`.
  - `read` has no local or network side effect.
  - `advisement` is reserved for a typed, side-effect-free operation that
    prepares or validates a reviewable plan for a named write. It is not a label
    for arbitrary workflow reasoning.
  - `write` submits, changes, removes, approves, or sends network state.
- **Default authority tier:** descriptive metadata for the gate that applies
  without a future signed policy. Reads are Tier 0, advisement is Tier 1, and
  writes fail closed to Tier 3. A future accepted Phase 1 policy may produce a
  Tier 2 execution decision for an eligible write. That effective decision is
  evaluated in code at dispatch time and is not stored in or granted by the
  capability map. Action-specific rules may tighten the posture, and channel
  may never weaken it.

The same semantic action has the same effect and default authority posture on
every channel. A browser handoff for a write cannot bypass a gate that applies
to the API form of that write.

### 3. Static support and runtime readiness are separate

An entry distinguishes two questions:

1. **Declared route support:** what the shipped adapter knows how to do, or the
   explicit `none` gap it knows about. This is static metadata owned beside the
   operation.
2. **Current readiness:** whether the route can be offered for the requested
   network and, where relevant, brand using the local configuration available
   now.

Current readiness must represent at least `ready`, `missing_credentials`,
`unsupported`, and `unknown`. Exact field names are settled with the first
implementation. `unknown` is fail-closed and is used when readiness cannot be
determined without a network call. Readiness does not claim that credentials
are valid, that the upstream endpoint is healthy, that policy authorises a
write, or that a browser consumer is installed. Live auth and health remain the
diagnostic surface's responsibility.

The map may expose a public requirement label and whether it is configured,
including that an opt-in write credential is missing. It must never expose a
credential value, token scope, account identity, cookie, session, account or
brand identifier, or any value derived from a secret. A write action remains
visible when its credential is absent so the operator can understand the blast
radius before opting in.

Unknown network or brand filters must return an explicit unsupported or
configuration result. They must not silently return an empty list that is
indistinguishable from a valid scope with no actions.

### 4. Discovery surface follows a concrete action

The eventual MCP discovery surface is read-only and provider-neutral. A
dedicated `affiliate_list_actions` meta tool is acceptable once at least one
accepted, implemented action makes its result useful. It may filter by network,
brand, effect, or channel without calling the action itself.

This decision does not require adding an empty seventh meta tool or a shared
read-inventory framework first. The smallest coherent implementation starts
with the first accepted concrete action, its descriptor, and focused tests. The
query tool follows in the same PR or a small dependent PR once it has real data
to return.

`affiliate_list_networks` remains network discovery, while
`affiliate_run_diagnostic` remains live capability and credential-health
evidence. The action map must link callers to those surfaces rather than
restate or overrule them.

### 5. Stable names without blocking adapter-local actions

Every declared action has an immutable, machine-oriented identifier from the
moment it ships. Provider-neutral names join the shared adapter contract only
after two real networks prove the same semantics, following the repository's
existing convention.

A useful first-network action is not blocked by that rule. It uses a stable,
network-scoped identifier owned with its network-specific tool. If a later
second implementation justifies a provider-neutral name, migration is explicit:
the shipped identifier is not silently renamed, and policy or audit consumers
receive an alias or versioned migration path.

Human descriptions may improve without changing the identifier. Policy rules,
approval records, host annotations, and audit events bind only to the stable
machine identifier. An adapter must not declare an `api` or `browser` action
unless the corresponding owned operation or handoff emitter exists.

### 6. Sequencing and boundaries

This record:

- adds no write operation, browser emitter, browser consumer, consent gate,
  audit event, authority evaluator, or policy file;
- does not accept the proposed browser-handoff or Impact contracts records;
- does not settle the Phase 1 authority questions, including policy format,
  sign-off, audit storage, revocation, or multi-operator agency authority;
- does not require duplicated per-action declarations in `network.json` and
  runtime metadata. Public reporting should derive from one reviewed source of
  truth once the metadata-ownership roadmap item is resolved;
- does not make strategy or KPI files authoritative. They remain advisory and
  may shape proposals but never readiness or write permission.

Broad writes and general browser automation remain later, experimental roadmap
work. The map is a narrow visibility and binding primitive, not a reason to
advance them ahead of accepted consent, audit, write, and handoff foundations.

## Security

- The map is read-only and non-probing. It cannot execute an action or convert
  missing authority into permission.
- Writes default to Tier 3. Only a separately accepted deterministic policy
  evaluator can return Tier 2, and unmatched cases remain Tier 3.
- Channel cannot weaken effect or authority. A browser entry describes handoff
  emission only and never claims that the downstream mutation occurred.
- Credential reporting is presence-only and redacted. Values, identities,
  tokens, cookies, sessions, and account or brand identifiers are excluded.
- Unsupported and unknown states remain explicit. `none` and `unknown` never
  degrade to an optimistic capability claim.

This decision affects a future public discovery contract, cross-network
semantics, credentials, write framing, and browser framing, so it is a
risk-based review item.

## Rejected alternatives

- **Redeclare every existing API read.** Rejected because the adapter contract
  and diagnostics already own that truth. A second constant and per-adapter map
  would increase drift without improving write consent or policy binding.
- **Infer actions from tool names or descriptions.** Rejected because effect,
  channel, and unsupported state are not safely inferable, and policy and audit
  need stable identifiers.
- **Treat `availability` as one boolean.** Rejected because it conflates static
  route support, local credential presence, live auth, upstream health, policy
  authority, and browser-consumer presence.
- **Treat `browser` as execution.** Rejected. It means a typed handoff can be
  emitted after the browser-handoff contract is accepted; consumers remain a
  separate boundary.
- **Omit known gaps.** Rejected because honest network truth includes a known
  action with no route. Such entries use `channel: none`, `unsupported`
  readiness, and can never be dispatched.
- **Make advisement a generic workflow category.** Rejected because that would
  pull skills and reasoning into the authority contract. Advisement is limited
  to a typed plan for a named write.
- **Ship the registry and meta tool before a concrete action.** Rejected as a
  speculative abstraction. The first accepted action proves the descriptor;
  discovery follows when it has real operator value.

## Consequences

- Operators gain one honest view of the doing surface without replacing the
  existing read-capability and diagnostic surfaces.
- A future policy, approval record, host annotation, and audit event can share
  stable action identifiers while execution authority remains outside the map.
- The implementation stays small: no blanket changes across 86 adapters, no
  duplicate canonical-read constant, and no immediate metadata expansion.
- Browser and Impact entries remain blocked until their own decisions are
  accepted and their implementation evidence is reviewed.
- Existing downstream implementation drafts that predeclare all reads or ship
  an empty read-only action tool must be revised to this narrower sequence.

## Implementation follow-ups

1. After one concrete action decision is accepted, add the smallest descriptor
   beside that owned operation. Cover channel, effect, default tier, declared
   support, redacted readiness, stable identifier, and explicit unsupported
   behaviour with focused tests.
2. Add `affiliate_list_actions` once real entries exist. Keep it non-probing,
   return explicit unknown-scope errors, and link live-health questions to
   `affiliate_run_diagnostic`.
3. Add further API or browser entries only after their own decisions and
   implementations are accepted. A `browser` entry requires a real typed
   emitter; `none` requires an evidenced gap.
4. Add public report labelling only from the chosen source of truth, avoiding a
   third hand-maintained copy in `network.json`, runtime metadata, and
   `REPORT.md`.
