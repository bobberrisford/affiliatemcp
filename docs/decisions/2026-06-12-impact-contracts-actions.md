# Impact contracts: the first brand-side write surface

- **Date:** 2026-06-12
- **Status:** Accepted (2026-06-18)
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

## Decision

Add five operations to the existing `impact-advertiser` adapter:

| Operation         | Endpoint                                       | Layer      |
| ----------------- | ---------------------------------------------- | ---------- |
| `listContracts`   | `GET .../Campaigns/{id}/Contracts`             | read       |
| `getContract`     | `GET .../Campaigns/{id}/Contracts/{contractId}`| read       |
| `proposeContract` | none; builds and returns a plan                | advisement |
| `applyContract`   | `POST .../Programs/{id}/Contracts`             | write      |
| `removeContract`  | `DELETE .../Programs/{id}/Contracts`           | write      |

The writes sit behind three independent gate layers, matching the
defence-in-depth posture the client file already states:

1. **Propose, then apply, with a pinned token.** `proposeContract` performs no
   network write; it validates inputs, reads current state, and returns a
   `ContractChangePlan` (action, brand, programme, summary, before and after
   snapshots, warnings, `confirmationToken`). `applyContract` requires the
   token echoed back verbatim, recomputes the hash from the intent it is about
   to execute, and refuses with a `config_error` on any mismatch. The token is
   an advisement boundary, not a security boundary against the model: it
   guarantees the change was rendered as a reviewable plan and pins execution
   to the exact reviewed parameters.
2. **Host approval via MCP annotations.** Write tools carry
   `destructiveHint: true` / `readOnlyHint: false`; a compliant MCP host
   renders an approve or decline dialog before dispatch. Reads and
   `proposeContract` carry `readOnlyHint: true`. The tool generator gains an
   optional `annotations` field on `OpSpec`.
3. **Opt-in read-write credential plus audit.** Writes engage only when a
   distinct `IMPACT_ADV_WRITE_TOKEN` is configured; the default read-only
   token cannot POST or DELETE, and a read-only user gets a clean
   `config_error`, never a surprise mutation. The existing hard throw on
   non-GET methods in `client.ts` is narrowed to an explicit per-operation
   allowlist (`applyContract`, `removeContract`), not removed. Every
   successful write emits a structured audit line via `createLogger` (brand,
   programme, before and after, token tier). `meta.setupRequiresApproval`
   flips to `true` and the setup wizard states the blast radius before
   accepting the write token.

One contract per `applyContract` call, so each change is individually
reviewable. Reads use the `Campaigns` path and writes the `Programs` path;
that split is a known footgun and lives in one well-commented helper.

## Security

- The adapter stays read-only by construction unless the operator explicitly
  configures a separate write token.
- No single tool call mutates Impact; plan review precedes every write.
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

- `AdapterOperation` and `NetworkAdapter` gain optional advertiser-side
  contract operations (style of `listMediaPartners?`), so no publisher adapter
  breaks. This is a shared-contract extension and needs its own review care.
- New domain types: `Contract`, `ContractSnapshot`, `ContractChangePlan`, with
  Zod input schemas in the tools layer.
- Five new `OpSpec` entries (`advertiserOnly: true`); write descriptions steer
  the model to only call `applyContract` after an approved plan.
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

1. Read half: `listContracts` and `getContract`. No write risk; confirms the
   contracts endpoints, auth tiers, and response shapes, and retires part of
   the `TODO(verify)` list.
2. Advisement plumbing: `ContractChangePlan`, the confirmation token, the
   `annotations` field on `OpSpec`, the `IMPACT_ADV_WRITE_TOKEN` credential,
   and the wizard copy.
3. Write half: `proposeContract`, then `applyContract` and `removeContract`
   behind the full three-layer gate, only after the remaining `TODO(verify)`
   items are confirmed against a live agency tenant.
4. Scrubbed fixtures and adapter tests for all five operations; no real
   account, programme, or contract identifiers.
5. Remove or redirect `docs/product/impact-contracts-action-layer.md` from the
   PR #73 branch once this record merges, so the decision record is the single
   source of truth.
