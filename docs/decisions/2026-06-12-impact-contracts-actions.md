# Impact contracts: the first brand-side write surface

- **Date:** 2026-06-12
- **Status:** Accepted (2026-06-20)
- **Affects:** `src/networks/impact-advertiser/` (adapter, client, network
  metadata), `src/shared/types.ts` (optional advertiser-side operations),
  `src/tools/generate.ts` (tool annotations), setup wizard copy, `.env.example`
- **Depends on:** the action-authority layer decision
  ([`2026-06-12-action-authority-layer.md`](./2026-06-12-action-authority-layer.md))
  as its foundation. This is Phase 0 of that direction: the per-call human
  gate only, with no policy engine.

## Context

Every operation in the project today reads. This record proposes the first
genuine brand-side write: managing Impact contracts, the payment-term
relationship between a brand and a partner, from the `impact-advertiser`
adapter. It also fixes the rule for every brand-side write that follows: a
write is never a single tool call; the operator is shown a plan, and nothing
reaches the network until that plan is approved.

Impact's Contracts API exposes read (`GET .../Campaigns/{id}/Contracts` and
per-contract), create (`POST .../Programs/{id}/Contracts`), and remove
(`DELETE .../Programs/{id}/Contracts`). There is no approve, sign, or
countersign endpoint, so no negotiation flow is pretended.

The Impact docs site returned 403 to automated fetches during research, so
several endpoint details carry `TODO(verify)` markers and must be confirmed
against a live agency tenant before write code lands.

This record supersedes the Impact contracts proposal in
`docs/product/impact-contracts-action-layer.md` from PR #73, which combined
this design with the general action-authority direction. The two are linked
but separable decisions; the general direction is recorded separately per the
maintainer's triage.

Acceptance approves this design and authorises the read half only. The three
write-facing operations remain design commitments, not implementation
authority. They stay blocked until their live-tenant verification gates are
closed and their own scoped risk review approves the credential, consent,
authority, audit, idempotency, and recovery behaviour below. This record does
not authorise broad write automation or bypass the action-authority decision.

## Decision

Add five operations to the existing `impact-advertiser` adapter:

| Operation         | Endpoint                                       | Layer      |
| ----------------- | ---------------------------------------------- | ---------- |
| `listContracts`   | `GET .../Campaigns/{id}/Contracts`             | read       |
| `getContract`     | `GET .../Campaigns/{id}/Contracts/{contractId}` | read       |
| `proposeContract` | none; builds and returns a plan                | advisement |
| `applyContract`   | `POST .../Programs/{id}/Contracts`             | write      |
| `removeContract`  | `DELETE .../Programs/{id}/Contracts`           | write      |

The writes sit behind three independent gate layers, matching the
defence-in-depth posture the client file already states:

1. **Propose, then apply or remove, with a pinned token.** `proposeContract`
   performs no network write; it validates inputs, reads current state, and returns a
   `ContractChangePlan` (action, brand, programme, summary, before and after
   snapshots, warnings, expiry, `confirmationToken`). Both `applyContract` and
   `removeContract` require the token echoed back verbatim, recompute it from
   the exact normalised intent and observed before-state they are about to act
   on, and refuse with a `config_error` when it is missing, mismatched, or
   stale. The token is an advisement boundary, not a security boundary against
   the model: it proves the exact change was rendered as a reviewable plan and
   pins execution to those reviewed parameters. A write still requires the
   operator's explicit confirmation at dispatch.
2. **Host approval via MCP annotations.** Write tools carry
   `destructiveHint: true` / `readOnlyHint: false`, allowing a compliant MCP
   host to render an approve or decline dialog before dispatch. Reads and
   `proposeContract` carry `readOnlyHint: true`. The tool generator gains an
   optional `annotations` field on `OpSpec`. An annotation describes the risk;
   it is not itself an enforcement boundary. Hosts without a trustworthy
   confirmation step are not a supported Phase 0 write surface.
3. **Opt-in read-write credential plus audit.** Writes engage only when a
   distinct `IMPACT_ADV_WRITE_TOKEN` is configured; the default read-only
   token cannot POST or DELETE, and a read-only user gets a clean
   `config_error`, never a surprise mutation. The existing hard throw on
   non-GET methods in `client.ts` is narrowed to an explicit per-operation
   allowlist (`applyContract`, `removeContract`), not removed. Every
   write attempt emits a structured audit line via `createLogger` (action,
   brand, programme, before and intended-after state, credential tier, plan
   fingerprint, and outcome, but never a token value). Denied, failed,
   unknown-outcome, and verified-success states remain distinct; a dispatched
   request is never logged as successful merely because no error was observed.
   `meta.setupRequiresApproval` flips to `true` and the setup wizard states the
   blast radius before accepting the write token.

One contract per apply or remove call, so each change is individually
reviewable. Reads use the `Campaigns` path and writes the `Programs` path; that
split is a known footgun and lives in one well-commented helper.

### Errors, retries, and recovery

- Reads and writes use the existing `NetworkErrorEnvelope` categories. Write
  failures additionally distinguish a confirmed rejection before mutation
  from an unknown outcome after dispatch. Unknown outcomes require a fresh
  read and operator reconciliation; they are never retried automatically.
- A write uses Impact's idempotency facility if live verification proves one
  exists. Otherwise it re-reads and compares the pinned before-state before
  dispatch, treats an already-achieved target state as a no-op, and verifies
  state after dispatch. The implementation must not claim exactly-once
  delivery where Impact cannot provide it.
- There is no pretend transaction or automatic rollback. An apply may be
  compensated only by a separately proposed and confirmed remove after the
  remove endpoint is live-verified. A removal may be irreversible; its plan
  and audit record preserve the before-state and say so explicitly.

Shared contracts contain only network-neutral concepts and error semantics.
Impact path selection, request bodies, identifiers, auth tiers, pagination,
response mapping, and recovery details stay inside `impact-advertiser`. Under
the repository's two-network convention, an operation or domain type joins
the provider-neutral adapter contract only when its semantics are genuinely
shared; otherwise the first Impact implementation remains adapter-local while
using reviewed shared primitives.

The accepted action-capability map does not duplicate `listContracts` or
`getContract`; existing read discovery owns those operations. Once the
corresponding operations actually ship, the doing surface uses stable
network-scoped identifiers aligned to `proposeContract` (advisement, Tier 1)
and `applyContract` / `removeContract` (API writes, default Tier 3). No map
entry may claim an API route, readiness, or write availability before its
owned operation, live proof, and opt-in credential gate exist.

## Security

- The adapter stays read-only by construction unless the operator explicitly
  configures a separate write token.
- A proposal never mutates Impact; no write dispatch occurs without a pinned
  plan and explicit confirmation.
- The narrowed allowlist keeps every other operation GET-only in code.
- Audit lines give a trail independent of Impact's own UI.
- Local-first holds: both tokens stay on the operator's machine.

This decision touches write actions, consent, credentials, and a shared
contract extension, and is a risk-based review item.

## Rejected alternatives

- **Impact event-notification postbacks.** Outbound webhooks Impact pushes to
  a brand's own endpoint. Rejected: there is no API to manage them (settings
  UI only) and the MCP is a stateless request/response tool with no long-lived
  inbound HTTP server to receive pushes and their retry schedule. They are a
  "told it happened" channel, not a "make it happen" one. Recorded so the
  consideration is not repeated.
- **An approve/sign/countersign flow.** The API has no such endpoint; offering
  one would invent capability. Rejected.
- **Bulk or looped writes.** Defeats per-change review at Phase 0. Rejected.
- **Removing the non-GET guard outright.** The guard is narrowed to a named
  allowlist instead, so every future write must be consciously added.
- **Waiting for the full policy engine.** The per-call gate is independently
  useful and proves the write path and advisement pattern; the authority
  primitive (Phase 1 of the foundation decision) builds on it later.

## Consequences

- The read implementation decides through review whether advertiser contract
  operations and minimal domain types are genuinely provider-neutral or stay
  Impact-local. Any shared-contract extension needs its own review care and
  must not force Impact endpoint semantics onto other networks.
- The future write implementation needs a reviewable plan type and Zod input
  schemas, with Impact-specific fields contained in its adapter.
- The read half adds only the two read `OpSpec` entries. Later advisement and
  write PRs add their own entries (`advertiserOnly: true`); write descriptions
  steer the model to apply or remove only after an approved plan.
- `.env.example`, setup docs, and `network.json` must record the write
  operations honestly, including their unverified status until live testing.
- Unverified endpoint details block the write half, all `TODO(verify)` against
  a live agency tenant: the POST body schema for `/Programs/{id}/Contracts`
  (template id versus inline rate fields); whether DELETE carries the contract
  id in the path or the body; and whether scoped tokens force the `Programs`
  versus `Campaigns` path split exactly as the reference implies.

## Implementation follow-ups

Sequenced so the risky half lands last; keep implementation PRs draft until
this decision merges:

1. Read half: `listContracts` and `getContract`. It introduces no mutation;
   endpoint, auth-tier, and response-shape claims remain labelled unverified
   until exercised against a live agency tenant.
2. Advisement plumbing and `proposeContract`: the reviewable plan,
   confirmation token, and future write annotations, still without a network
   mutation or write credential.
3. Write half: `applyContract` and `removeContract` behind the full gate,
   including `IMPACT_ADV_WRITE_TOKEN`, setup approval, audit, idempotency, and
   recovery behaviour, only after the remaining `TODO(verify)` items are
   confirmed against a live agency tenant.
4. Scrubbed fixtures and adapter tests for all five operations; no real
   account, programme, or contract identifiers.
5. Remove or redirect `docs/product/impact-contracts-action-layer.md` from the
   PR #73 branch once this record merges, so the decision record is the single
   source of truth.
