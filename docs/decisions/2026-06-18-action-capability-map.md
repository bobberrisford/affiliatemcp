# Action capability map: a channel-aware inventory of what can be done

- **Date:** 2026-06-18
- **Status:** Proposed
- **Affects:** `src/shared/types.ts` (a declarative action descriptor on the
  adapter contract), `src/tools/generate.ts` (a `list_actions` meta tool and
  per-op annotations), `network.json` and `REPORT.md` (honest labelling of
  actions by channel and effect), the future consent/audit and policy
  primitives
- **Depends on:** the three records this one connects, none of which it blocks:
  the action-authority layer
  ([`2026-06-12-action-authority-layer.md`](./2026-06-12-action-authority-layer.md),
  accepted), the browser-handoff contract
  ([`2026-06-12-browser-handoff-contract.md`](./2026-06-12-browser-handoff-contract.md),
  proposed), and the Impact contracts Phase 0 write
  ([`2026-06-12-impact-contracts-actions.md`](./2026-06-12-impact-contracts-actions.md),
  proposed).

## Context

The project is moving from reading affiliate data to doing things with it:
changing commissions, approving publishers, applying to programmes, submitting
transactions. Three records already settle large parts of that move. The
authority layer settles how much an operator must approve (tiered, fail-closed,
enforced in code). The browser-handoff contract settles what happens when a
network's API cannot do the job (a normal `ApiGapResponse` carrying a nullable
`BrowserHandoff`, executed by an out-of-scope consumer such as the Claude in
Chrome extension). The Impact contracts record settles the first concrete API
write and the propose-apply gate every write inherits.

What none of them provide is an inventory. Today an agent or operator cannot
ask "for this brand on this network, what actions are possible, by which
channel, and how risky is each?" without calling an operation and seeing what
comes back. The channel answer (API versus browser versus no route yet) is
known only per call, at call time, from the shape of the response. The effect
answer (does this read, propose, or mutate) and the default authority tier are
implied by tool naming and prose, not declared. `affiliate_list_networks` and
`capabilitiesCheck` already give operators a readable map of read capability;
the doing layer has no equivalent.

Without that map, three problems follow. Operators cannot see the blast radius
of a network before they grant a write credential. Agents cannot plan a
multi-step workflow ("raise commission, then notify the partner") without
probing. And the authority policy artefact, deferred to Phase 1 of the
authority decision, has nothing stable to bind rules to: a policy that says
"auto-apply commission changes under a point" needs a canonical action name to
attach to.

## Decision

Introduce an **action capability map**: a declarative, queryable inventory of
the actions each adapter can perform, classified on three orthogonal axes. The
map is descriptive metadata, not an execution path; it states what is possible
and how it is gated, and it changes nothing about how the authority layer or
the browser-handoff contract execute.

### 1. Three orthogonal axes

Every declared action carries exactly three classifications, and they do not
collapse into one another:

- **Channel** — how the action reaches the network. One of `api` (the adapter
  calls a documented endpoint), `browser` (the adapter emits an
  `ApiGapResponse` with a `BrowserHandoff`; a consumer or a human carries it
  out), or `none` (a known gap with no route yet; an `ApiGapResponse` with
  `browserFallback: null`).
- **Effect** — what the action does to network state. One of `read` (no side
  effect), `advisement` (computes and returns a plan, such as
  `proposeContract`; no side effect), or `write` (submits, changes, or sends).
- **Authority tier** — the default gate from the authority layer (0 read, 1
  propose, 2 auto-apply within policy, 3 human sign-off). This is the action's
  *default*; an operator's policy may tighten it but never loosen it, and
  anything unmatched stays at Tier 3.

These axes are independent on purpose. The most important consequence: **a
browser-driven write and an API write of the same thing sit at the same
authority tier.** Channel changes brittleness and who executes; it does not
change how much trust the action needs. A commission change is a commission
change whether the adapter POSTs it or a browser consumer clicks it. Letting
the channel set the tier would mean an operator who blocked API commission
changes could be surprised by a browser one. The map forbids that by keeping
the axes separate and pinning the tier to the effect and the action, not the
channel.

### 2. A `list_actions` meta tool, alongside `list_networks`

Add a seventh meta tool that returns the capability map for the configured
networks (optionally scoped to one brand or network). Each entry names the
canonical action, its three axis values, whether it is currently available
given the configured credentials (for example, an Impact write needs the
opt-in write token), and a one-line human description. This is the doing-layer
analogue of `affiliate_list_networks`: the readable answer to "what can I do
here, and what will it cost me in approvals?" It is read-only and side-effect
free.

### 3. A declarative descriptor on the adapter contract

Actions are declared, not inferred from naming. The adapter contract gains a
descriptor (shape settled in the wiring PR) binding a canonical action name to
its channel, effect, and default tier, plus the availability predicate.
Read operations are declared too, so the map is complete rather than
"writes only"; the seven existing canonical reads register as
`channel: api, effect: read, tier: 0` with no behaviour change. Per the
existing "two networks first" convention, a new *action* name joins the shared
contract once a second network declares it; the first declarant is
adapter-local but speaks the shared descriptor shape from day one.

### 4. Canonical action names are the binding surface

The action names in the map are the stable identifiers the Phase 1 policy
artefact, the audit log, and the MCP host annotations all reference. Naming an
action once, in one place, is what lets a policy rule, an audit line, and an
approval dialog all talk about the same thing. This record does not design the
policy file (that remains Phase 1 of the authority decision); it fixes the
vocabulary that file will reference.

### 5. What this record does not do

It adds no write path. It does not change the authority tiers, the
propose-apply gate, the browser-handoff shape, or the audit vocabulary. It does
not design the policy artefact or resolve the multi-operator agency sign-off
question. It is the connective inventory those pieces hang from, and it is
independently useful the moment the first action is declared, because the
operator can finally see the doing surface before granting a credential.

## Security

- The map is descriptive and read-only; exposing it adds no mutation path. A
  consumer that can read the map still cannot act without the credential, the
  tier gate, and the propose-apply flow each action already requires.
- Pinning the authority tier to effect and action, never to channel, closes the
  surprise-channel hole: an operator cannot block an action on one channel and
  be exposed to it on another.
- The availability predicate makes credential blast radius visible before a
  write token is configured, supporting the informed-consent posture in the
  setup wizard.
- Honest channel labelling (`api` versus `browser` versus `none`) carries the
  product boundary's brittleness warning into a machine-readable field rather
  than prose alone.

This record touches the shared adapter contract, a new public meta-tool
surface, and the framing of write actions and consent, so it is a risk-based
review item for `@offmann`.

## Rejected alternatives

- **Infer channel and effect from tool naming and prose.** The status quo. It
  leaves the policy artefact, the audit log, and approval dialogs with no
  stable identifier to bind to, and it cannot answer the operator's
  "what can I do here?" question without probing. Rejected.
- **Fold channel into the authority tier (browser actions one tier higher).**
  Conflates brittleness with trust and creates the surprise-channel hole in
  section 1. Rejected; the axes stay orthogonal.
- **A writes-only map.** Leaves the inventory incomplete and forces consumers
  to merge two sources (reads from `capabilitiesCheck`, writes from here).
  Rejected; reads are declared too, at Tier 0.
- **Design the policy artefact here.** Out of scope and premature; the
  authority record already deferred it to a Phase 1 design with named open
  questions. This record only fixes the action vocabulary that artefact will
  reference. Rejected for now.
- **A standalone registry file decoupled from adapters.** Drifts from the code
  it describes. The descriptor lives on the adapter that owns the behaviour, so
  the map cannot claim an action the adapter does not implement. Rejected.

## Consequences

- `src/shared/types.ts` gains an action descriptor type next to the operation
  and capability types; this is a reviewed shared-contract change and the
  wiring PR stays draft until this decision merges.
- `src/tools/generate.ts` gains the `list_actions` meta tool (the meta-tool
  count moves from six to seven; the external contract note in `AGENTS.md`
  updates accordingly) and an optional annotations path so write tools can
  carry `destructiveHint` / `readOnlyHint` consistently with the Impact
  contracts record.
- `network.json` and `REPORT.md` gain per-action channel and effect labelling;
  exact representation is settled in the wiring PR.
- The Impact contracts and browser-handoff records gain a home for their
  actions: each becomes a declared entry in the map rather than a bespoke
  surface. Neither record's execution behaviour changes.
- The Phase 1 policy artefact has a stable binding surface to design against
  when it is taken up.

## Implementation follow-ups

Sequenced so each step is independently reviewable; keep dependent PRs draft
until this decision merges:

1. Contract PR: the action descriptor type in `src/shared/types.ts`, the seven
   existing reads registered as Tier 0 `api`/`read`, and a registry helper that
   assembles the map from the adapter set. No new actions, no behaviour change.
2. Surface PR: the `list_actions` meta tool over the descriptor, with scoping by
   brand and network and the availability predicate; tests and the `AGENTS.md`
   meta-tool-count update.
3. First declared write: re-express the Impact contracts actions
   (`proposeContract` advisement, `applyContract` / `removeContract` writes) and
   the Awin proof-of-purchase action as map entries, proving advisement and
   write effects and the `api` channel end to end.
4. First declared browser action: re-express the browser-handoff emitter
   (Impact `applyToProgram`) as a `browser`-channel entry, proving the channel
   axis and the gap-with-no-fallback (`none`) case.
5. Documentation pass: `network.json` and `REPORT.md` per-action labelling,
   alongside the wiring PRs.
