# Record per-client strategy and KPIs as local living markdown

- **Date:** 2026-06-12
- **Status:** Proposed
- **Affects:** local config layout under `$AFFILIATE_MCP_CONFIG_DIR/clients/`;
  future agency-side skills (a client-onboarding skill, plus reader changes to
  `skills/programme-anomaly-watch`, `skills/agency-portfolio-rollup`, and
  `skills/programme-performance-report`)
- **Depends on:** the brand registry in `src/shared/brands.ts`, whose
  `brands.json` slug is the canonical client key this decision reuses

## Context

Most of an affiliate agency's recurring work is reporting and anomaly
suggestion, and that is already this project's strength. The manifesto
([`docs/product/manifesto.md`](../product/manifesto.md), "What this enables")
and the product direction doc
([`docs/product/ai-native-affiliate-data.md`](../product/ai-native-affiliate-data.md),
roadmap step 3) both frame skills and workflow packs as the delivery vehicle,
and the shipped skills produce earnings reports, portfolio rollups,
single-brand performance reports, and week-over-week anomaly scans.

What is missing is per-client context, not an action engine. A report can say
"Acme revenue is down 18% week over week", but it has no view on whether 18%
matters to Acme, whether Acme is still ahead of its quarterly target, or
whether the drop sits in a channel Acme has deprioritised. The client's intent
lives in a kickoff deck, an email thread, or someone's head; never anywhere
the assistant can read.

The brand layer in `src/shared/brands.ts` already binds a logical client slug
to its network identifiers, stored at `$AFFILIATE_MCP_CONFIG_DIR/brands.json`
with read-fresh-on-each-call and atomic-write conventions. That gives this
decision a natural key and a storage precedent.

An earlier draft of this proposal cited the manifesto's "public APIs only"
principle as the reason there is no execution layer. The manifesto has since
moved to "API-first, browser as fallback", so that justification no longer
holds. The non-execution boundary in this decision stands on its own: the
product remains reporting and anomaly suggestion, and a human carries out
actions on networks.

## Decision

Record each client's affiliate strategy as a small set of living markdown
files that the agency-side skills read as context before reporting.

**Two files per client:**

- `Strategy.md`: plain prose covering objectives for the period, preferred and
  deprioritised partner types, brand safety and compliance rules, seasonal
  focus, reporting voice and cadence, and what to escalate to a human
  immediately.
- `KPI.md`: the measurable targets and thresholds that turn a generic delta
  into a verdict: per-period targets (revenue, conversions, EPC, AOV), health
  limits (reversal rate, approval rate), alert thresholds, and budget or
  payout ceilings.

**Storage:** local files keyed by the same brand slug used in `brands.json`:

```
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/Strategy.md
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/KPI.md
```

`$AFFILIATE_MCP_CONFIG_DIR` defaults to `~/.affiliate-mcp`. The files follow
the `brands.ts` conventions: local-first, read fresh on each use, written
atomically with restrictive permissions. Nothing is uploaded.

**Capture and editing:** a future client-onboarding skill interviews the
operator, drafts both files, confirms before writing, and thereafter edits
them through chat ("raise Acme's Q3 revenue target to £400k"). Because the
record is plain markdown, the operator can also edit it directly; chat is the
convenience, not the only path.

**Out of scope by design:** no network-write or execution layer of any kind
(no approving or declining publishers, no commission changes, no offer
launches), and no delivery autonomy, scheduling, or output sinks. Those are
not deferred details of this decision; they are excluded from it. Any future
action-execution proposal needs its own decision PR per the delivery protocol
in `AGENTS.md`.

### Positions on the open review points

Three points were raised in earlier review. This decision takes a named
position on each.

1. **Unsupported KPI metrics are reported as unsupported, never zero-filled.
   Resolved.** When `KPI.md` sets a target on a metric that a bound network
   cannot supply, the reader skill must say so for that network and exclude it
   from the verdict. It must not substitute zero, omit it silently, or blend
   partial coverage into a cross-network total without saying which networks
   are missing. This is the existing honest-network-truth rule applied to
   client targets; the manifesto already forbids pretending unsupported
   operations work.

2. **`KPI.md` thresholds get a light parseable convention; `Strategy.md`
   stays free prose. Direction resolved, grammar deferred.** Targets and
   thresholds must be reliably machine-readable: one target or threshold per
   line, naming a metric, a comparator or direction, a value, and a period.
   This stops short of a JSON schema, which would contradict the
   living-document intent and raise authoring friction for operators. The
   exact grammar, its examples, and its tests are a separate implementation
   follow-up, and the onboarding skill must emit it so operators never have
   to learn it.

3. **`brands.json` is the source of truth for which clients exist. Position
   taken, lifecycle edge deferred.** A strategy directory whose slug has no
   brand binding is an orphan: skills must flag it and must not invent
   network data for it. A brand binding with no strategy files is normal:
   skills run exactly as they do today on generic deltas and may note that no
   strategy is recorded; absence is not an error. Behaviour on brand rename or
   unbind is deferred to a follow-up, alongside the existing `brands.json`
   delete-compaction future-work item noted in `src/shared/brands.ts`.

## Rejected alternatives

- **A typed JSON or YAML schema for client strategy.** Contradicts the
  living-prose intent, raises authoring friction for the semi-technical
  operators this is for, and adds an abstraction before any reader skill has
  proven what fields matter. The light `KPI.md` convention covers the only
  part that genuinely needs parsing.
- **Storing strategy inside `brands.json`.** Mixes operator-maintained prose
  into a wizard-owned, machine-managed file whose shape is deliberately
  minimal at version 1.
- **Keying by network rather than by client.** The agency's unit of work is
  the client; the brand slug already fans out to networks, which is how
  cross-network rollups are produced today.
- **Pairing recording with an execution layer.** Changes the product from
  suggestion to action, and pulls in consent, audit, and write-safety
  questions that need their own decision. Excluded, not deferred.
- **Doing nothing.** Leaves client intent in decks and email threads, which is
  the status quo failure this decision exists to fix.

## Consequences

- New per-client files appear under the config directory; they stay on the
  user's machine and follow the existing permission and atomic-write
  conventions.
- Reader skills gain a context-loading step and must implement the three
  positions above, including unsupported-metric reporting and orphan
  handling.
- Reports become judgements against the client's own plan ("down 18% but
  still 6% ahead of the quarterly target") rather than bare percentages.
- Nothing changes at runtime until the follow-ups land; this PR is direction
  only. Product docs and the README gain pointers when the capability ships,
  not before.

## Implementation follow-ups

Each is a separate future PR, kept draft until this decision merges:

1. **KPI threshold convention.** Define the parseable `KPI.md` grammar with
   examples and tests; update the onboarding skill design to emit it.
2. **Client strategy storage helper.** Read and write
   `clients/<slug>/Strategy.md` and `KPI.md` following the `brands.ts`
   conventions, including orphan and missing-file detection.
3. **Client-onboarding skill.** Interview, draft, confirm-before-write, and
   chat-based editing of both files.
4. **Wire the reader skills.** `programme-anomaly-watch`,
   `agency-portfolio-rollup`, and `programme-performance-report` read the
   files at run time, with unsupported-metric reporting per position 1.
5. **Slug lifecycle.** Define behaviour on brand rename and unbind, shared
   with the `brands.json` compaction future-work item.
