# Impact Contracts — the first brand-side action

Status: design proposal. Nothing here is implemented yet. The Impact docs site
returned 403 to automated fetches during research, so several endpoint details
are marked `TODO(verify)` and must be confirmed against a live agency tenant
before code lands.

## What this is

Every operation in the project today reads. The one apparent exception,
`generateTrackingLink`, is a publisher-side convenience and is not implemented
on the advertiser adapter. This document proposes the first genuine brand-side
write: managing Impact **contracts** — the payment-term relationship between a
brand and a partner — from the `impact-advertiser` adapter.

It also fixes the rule for every brand-side write that follows: a write is never
a single tool call. The user is shown a plan, and nothing reaches the network
until that plan is approved.

This per-call gate is Phase 0 of a larger direction — a deterministic
action-authority layer that lets operators pre-authorise bounded actions within
limits they can read and revoke. That generalisation is described separately in
[action-authority-layer.md](action-authority-layer.md); this document stays
scoped to the first concrete write and its human gate.

## Source material

Two Impact documents prompted this work.

1. **Contracts API** (`/brand-api-reference/reference/contracts`). Contracts are
   "the rules of the business relationship between you and a partner" — payment
   terms and compensation structure, usually derived from template terms shared
   across a programme. The API exposes three verbs:
   - `GET  /Advertisers/{SID}/Campaigns/{id}/Contracts` (and `/{contractId}`, `/Download`) — read
   - `POST /Advertisers/{SID}/Programs/{id}/Contracts` — create
   - `DELETE /Advertisers/{SID}/Programs/{id}/Contracts` — remove

   There is no approve, sign, or countersign endpoint. The write surface is
   create and remove, nothing more.

2. **Event notification postbacks** (brand help centre). These are outbound
   webhooks Impact pushes to a brand's own endpoint when actions track, reverse,
   or clear. They are **out of scope** for this layer and for the MCP generally:
   there is no API to manage them (they are configured in the Impact settings
   UI), and the MCP is a request/response tool with no long-lived inbound HTTP
   server to receive pushes and their retry schedule. They are a "told it
   happened" channel, not a "make it happen" one. Filed here only to record that
   they were considered and rejected.

## Scope

Five operations on the existing `impact-advertiser` adapter. The reads are
uncontroversial; the writes carry the new safety model.

| Operation         | Verb + endpoint                                   | Layer       |
| ----------------- | ------------------------------------------------- | ----------- |
| `listContracts`   | `GET …/Campaigns/{id}/Contracts`                  | read        |
| `getContract`     | `GET …/Campaigns/{id}/Contracts/{contractId}`     | read        |
| `proposeContract` | none — builds and returns a plan                  | advisement  |
| `applyContract`   | `POST …/Programs/{id}/Contracts`                  | write       |
| `removeContract`  | `DELETE …/Programs/{id}/Contracts`                | write       |

Explicitly **not** in scope:

- Approve / sign / countersign — the API has no such endpoint, so we do not
  pretend to offer a negotiation flow.
- Bulk or looped writes — one contract per `applyContract`, so each change is
  individually reviewable.
- Event-notification postbacks — wrong runtime for an MCP, as above.

## The advisement model

The adapter is read-only by construction today. `impactAdvRequest` in
`src/networks/impact-advertiser/client.ts` hard-throws on any non-`GET` method,
with a comment noting that "a future contributor must consciously remove this
throw to enable writes". This is that moment. We do not remove the guard — we
narrow it to an explicit per-operation allowlist, and we put a human gate in
front of every write. Three independent layers, matching the defence-in-depth
philosophy the client file already states.

### Layer 1 — propose, then apply, with a pinned token

No tool mutates Impact in a single call.

1. `proposeContract` performs **no network write**. It validates the inputs,
   reads the current state (is there already a contract on this campaign?), and
   returns a `ContractChangePlan`:

   ```ts
   interface ContractChangePlan {
     action: 'create' | 'remove';
     network: 'impact-advertiser';
     brand: { networkBrandId: string; displayName: string };
     programmeId: string;
     summary: string;            // "Create a contract on 'Acme UK' (campaign 4421) using terms template 'Standard 8% CPS'."
     before: ContractSnapshot | null;
     after: ContractSnapshot;
     warnings: string[];         // "Replaces an existing active contract paying 10% CPS."
     confirmationToken: string;  // deterministic hash of the normalised intent
     expiresHint: string;        // advisory: re-propose if terms change
   }
   ```

2. `applyContract` **requires** the `confirmationToken` echoed back verbatim. It
   recomputes the hash from the intent it is about to execute; on any mismatch
   (parameters drifted, stale plan) it refuses with a `config_error` and does
   not call the network.

   The token is not a security boundary against the model. It is an advisement
   boundary: it guarantees the change was rendered as a reviewable plan before
   anything hit the wire, and it pins execution to the exact reviewed
   parameters. The model cannot apply terms the user never saw.

### Layer 2 — host approval via MCP annotations

The write tools carry `destructiveHint: true` / `readOnlyHint: false`
annotations. A compliant MCP host renders an approve/decline dialog before
dispatch — this is the human's actual click. `proposeContract`, `listContracts`,
and `getContract` are annotated `readOnlyHint: true` and run without prompting.

The tool generator (`src/tools/generate.ts`) does not emit annotations today;
adding an optional `annotations` field to `OpSpec` and threading it through is a
small, isolated change.

### Layer 3 — a separate, opt-in read-write credential

The allowlist in the client engages only when a distinct `IMPACT_ADV_WRITE_TOKEN`
(a read-write Impact API token) is configured. The default read-only token
cannot POST or DELETE. A user with only read credentials gets a clean
`config_error`, never a surprise mutation. `meta.setupRequiresApproval` flips to
`true`, and the setup wizard states the blast radius before accepting the write
token.

Every successful write also emits a structured audit line via the existing
`createLogger` (brand, programme, before → after, token), so there is a trail
independent of Impact's own UI.

## Implementation outline

### Client

`impactAdvRequest` is widened narrowly — not unlocked:

```ts
// Operations permitted to write. Everything else stays GET-only.
const WRITE_OPS = new Set<AnyOperation>(['applyContract', 'removeContract']);

const method = input.method ?? 'GET';
if (method !== 'GET') {
  if (!WRITE_OPS.has(input.operation)) {
    throw /* config_error: "<op> is not an approved write operation" */;
  }
  if (!creds.writeToken) {
    throw /* config_error: "writes require IMPACT_ADV_WRITE_TOKEN; only a read token is configured" */;
  }
}
```

The brand API takes form-encoded bodies. `buildUrl` already handles the
agency-passthrough vs brand-direct tier prefixes; it needs the one extra wrinkle
the docs flagged — reads use `…/Campaigns/{id}/Contracts` but writes use
`…/Programs/{id}/Contracts`. That `Campaigns` vs `Programs` split is a genuine
footgun (scoped tokens reportedly require the path to match the method), so it
lives in one well-commented helper rather than being scattered.

### Types and interface

- `AdapterOperation` (`src/shared/types.ts`) gains `listContracts`,
  `getContract`, `proposeContract`, `applyContract`, `removeContract`.
- `NetworkAdapter` gets these as **optional** advertiser-side methods, in the
  style of `listMediaPartners?`, so no publisher adapter breaks. The generator
  wires them only when `meta.side === 'advertiser'` and the method exists.
- New domain types: `Contract`, `ContractSnapshot`, `ContractChangePlan`, with
  `ProposeContractInput` / `ApplyContractInput` Zod schemas in the tools layer.

### Tool generation

Five `OpSpec` entries (`advertiserOnly: true`) in `src/tools/generate.ts`. The
write specs carry the new annotations. Descriptions steer the model: e.g.
`applyContract` reads "Only call after proposeContract has returned a plan the
user has approved; pass its confirmationToken verbatim."

## Open questions — verify against a live tenant

These block the write half. The read half (`listContracts`, `getContract`)
carries no such risk and can ship first to de-risk auth and pathing.

1. The POST body schema for `/Programs/{id}/Contracts`. Terms derive from
   "template terms" — confirm the field names (template id? inline rate?).
2. Whether DELETE carries the contract id in the path or the body.
3. Whether scoped tokens force the `Programs` vs `Campaigns` path exactly as the
   reference implies.

## Suggested sequencing

1. Read half: `listContracts` + `getContract`. No write risk; confirms the
   contracts endpoints, auth tiers, and response shapes.
2. Advisement plumbing: `ContractChangePlan`, the token, the `annotations`
   field on `OpSpec`, the `IMPACT_ADV_WRITE_TOKEN` credential and wizard copy.
3. Write half: `proposeContract` → `applyContract` / `removeContract`, behind
   the full three-layer gate.
