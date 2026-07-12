# A paid tier for brand-data features, gated by a local entitlement check

- **Date:** 2026-06-30
- **Status:** Accepted (2026-07-12, Rob, via acceptance of the solo revenue
  plan and its Phase 0 technical roadmap, which lands this gate)
- **Affects:** the MCP server dispatch path (`src/server.ts`), a new
  `src/brand-data/entitlement.ts`, the three brand-data meta-tools defined in the
  companion record `2026-06-30-brand-data-layer.md`, and the project's
  free/open-source posture recorded in `2026-06-09-desktop-app-free.md`.
- **Supersedes, narrowly:** `2026-06-09-desktop-app-free.md`, which removed the
  paid tier and stated "A future tier can re-introduce it behind its own decision
  record." This is that record. It does not reinstate the desktop licence screen
  or the issuer Worker; it introduces a different, smaller gate on a different
  surface.

## Context

The Brand Data Layer feature (companion record `2026-06-30-brand-data-layer.md`)
ships interactive pivotable tables for free, and gates three higher-value
deliverables behind a paid tier:

- CSV export of the normalised 30-day rows;
- the "Make a QBR" AI action;
- the "Write a weekly report" AI action.

The free decision of 2026-06-09 deleted the desktop app's £39 licence, the
offline Ed25519 verification, and the Stripe issuer Worker, on the grounds that
bundling payments and licensing into the setup app was hard to review and
contradicted a "free" message. That reasoning still holds for the **setup app**.
It does not bind the project to never charging for anything: the same record
explicitly left the door open for a future tier behind its own decision.

This record makes three things explicit so the delivery protocol's
payment/licensing risk gate is satisfied before any code:

1. There will be a paid tier. Three brand-data deliverables sit behind it; the
   rest of the product, including all 80+ adapter tools and the free tables,
   stays free.
2. The enforcement point is a single local entitlement check in the MCP server,
   not a per-feature scatter of checks and not a re-run of the desktop licence
   screen.
3. Payments are out of scope for this work. This record authorises a **stubbed**
   entitlement check only. The real payment flow, issuance, and verification are
   a separate decision and a separate PR the maintainer owns.

## Decision

Introduce a two-tier model for the brand-data features: a free tier (tables,
snapshot viewing) and a paid tier (CSV export, QBR, weekly report). Gate the paid
tier with one local entitlement check.

### The gate

- **One choke point.** The check lives in the MCP server's tool-dispatch path
  (`src/server.ts`), after the tool is resolved and before its handler runs,
  keyed on a `GATED_TOOLS` set naming the three paid meta-tools. A single point
  means a tool author cannot forget to apply it and the decision is auditable in
  one place. No adapter tool and no free meta-tool is touched.
- **Stubbed check.** A new `src/brand-data/entitlement.ts` exposes
  `isEntitled(userId?: string): boolean` and `entitlementState(): { entitled,
  reason, tier }`. In v1 `isEntitled` reads an environment flag
  (`AFFILIATE_MCP_ENTITLED`) with a hardcoded default; it performs no network
  call, reads no licence file, and verifies no signature. It is the single seam a
  future payment PR replaces.
- **Visible-but-locked.** Gated tools stay registered and continue to appear in
  `ListTools`, so a client can render them as locked rather than hide them. A
  call without entitlement returns a structured `entitlement_required` result
  (`isError: true`), mirroring the existing unknown-tool and error-envelope
  paths, carrying `{ entitled: false, tier: 'paid', upgradeHint }`. It is never an
  opaque transport error. This honours Principle 4.1: a refusal is surfaced
  honestly, not faked into a success or collapsed into a generic error.
- **Observability via existing machinery.** A denied call records the existing
  audit outcome `write_denied` with a `reasonCode: 'entitlement'` field (reusing the
  structured audit line rather than extending the shared audit union) and emits
  telemetry through the existing meta-tool dispatch path. No new telemetry field
  carries credentials, affiliate data, or account identifiers; `PRIVACY.md`
  holds verbatim.

### What this gate is not

The entitlement gate decides **licence access** to a feature. It is orthogonal to
the action-authority machinery (`DefaultAuthorityTier`, the action-capability
map), which decides **write-approval tier** for an action. The two must not be
conflated: a paid user is still bound by the authority tiers, and a free user is
refused the gated feature regardless of authority. This record does not change
any authority-tier semantics.

### Local-first and privacy posture

The local-first promise is preserved. The stubbed check makes no outbound call.
When the real payment flow lands behind its own decision, the entitlement lookup
is the one sanctioned exception, designed there with auth, consent, and
auditability, exactly as the project's boundaries require. Affiliate data and
credentials never leave the machine for the entitlement check.

## Rejected alternatives

- **Keep everything free (do nothing).** Honours 2026-06-09 verbatim. Rejected:
  the maintainer has decided the QBR, weekly report, and CSV export are the paid
  value of this product line. Recorded as the fallback if this record is not
  accepted; the data layer and free tables can still ship without it.
- **Gate only via a future remote service, nothing local.** Consistent with the
  one carve-out in 2026-06-09 (a remote service the app opts into). Rejected for
  v1: the brief's interface is Claude-native through the local MCP, so the
  enforcement point has to be the local server. A remote service remains the
  right home for the *payment and issuance* half; this record only places the
  *check* locally and stubs it.
- **Hide locked features entirely.** Rejected: visible-but-locked is the
  honest-limitation posture this project takes everywhere else, and it lets a
  client show the upgrade path rather than pretend the feature does not exist.
- **Scatter the check into each tool handler.** Rejected: a single dispatch
  choke point is auditable and impossible to forget; per-handler checks drift.
- **Re-introduce the desktop licence screen and issuer Worker.** Rejected: that
  is exactly the heavy, hard-to-review surface 2026-06-09 removed. This gate is a
  one-function stub on the server, not an activation gate on the app.

## Consequences and implementation follow-ups

Keep all of these in draft until this record is accepted.

- The CSV export tool and the entitlement gate land together in one PR
  (plan PR-4), an `active-risk` change because it is the payment/licensing
  surface; it takes an independent agent review plus green CI as the backstop,
  then the maintainer's deliberate acceptance. Do not request `@offmann`; Rob is
  the current maintainer decision owner.
- `isEntitled` stays a stub. No Stripe, no licence file, no signature
  verification ships under this record.
- Doc sync: on acceptance, add a forward-pointer banner to
  `2026-06-09-desktop-app-free.md` noting this record introduces a paid tier on
  the brand-data surface, so the two never read as contradictory.

## Open questions for the maintainer

- **Entitlement granularity.** One flag for all three paid tools, or per-feature
  entitlement (CSV vs AI actions priced separately) later.
- **Free-tier ceiling.** Whether the free tables have any limit (network count,
  history depth) or stay fully free.
- **Where payment lands.** Confirm the real entitlement endpoint is a separate
  remote service behind its own decision, with this stub as the only local seam.
