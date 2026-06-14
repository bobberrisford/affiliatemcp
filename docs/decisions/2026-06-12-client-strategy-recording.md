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
moved to "API-first, browser as fallback", and the accepted
[`action-authority decision`](./2026-06-12-action-authority-layer.md) separately
defines how writes may be authorised. This decision concerns advisory strategy
context for reporting and proposals; it does not define or weaken action
authority.

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
  limits (reversal rate, approval rate), and alert thresholds.

**Storage:** local files keyed by the same brand slug used in `brands.json`:

```
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/Strategy.md
$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/KPI.md
```

`$AFFILIATE_MCP_CONFIG_DIR` defaults to `~/.affiliate-mcp`. The files follow
the `brands.ts` conventions: local-first, read fresh on each use, written
atomically with restrictive permissions. They are not sent through project
telemetry or to a project-operated service. When a user invokes a skill that
uses this context, the relevant contents are supplied to the connected AI
client under the same data flow as other MCP results.

**Capture and editing:** a future client-onboarding skill interviews the
operator, drafts both files, confirms before writing, and thereafter edits
them through chat ("raise Acme's Q3 revenue target to £400k"). Because the
record is plain markdown, the operator can also edit it directly; chat is the
convenience, not the only path.

**Advisory, never authority:** strategy and KPI files may inform reports,
alerts, and proposals. They must never authorise a network write, loosen an
authority rule, or define an absolute budget or payout ceiling. The accepted
action-authority decision keeps hard ceilings and write eligibility in a
separate deterministic policy enforced in code.

**Out of scope by design:** this decision adds no network-write or execution
layer, delivery autonomy, scheduling, or output sinks. Existing and future
action execution remains governed by the accepted action-authority decision
and its separate implementation reviews.

### Positions on the open review points

This decision takes a named position on the review and implementation
boundaries that determine whether the direction is safe to build.

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
   This decision does not choose whether that convention is Markdown
   frontmatter, a structured block, or another small human-editable syntax.
   The exact grammar, version marker, examples, validation, and tests are a
   separate implementation follow-up, and the onboarding skill must emit the
   convention so operators never have to learn it. Reader skills must report
   malformed or unknown entries and exclude them from verdicts; they must
   never guess their meaning.

3. **`brands.json` is the source of truth for which clients exist. Position
   taken, lifecycle edge deferred.** A strategy directory whose slug has no
   brand binding is an orphan: skills must flag it and must not invent
   network data for it. A brand binding with no strategy files is normal:
   skills run exactly as they do today on generic deltas and may note that no
   strategy is recorded; absence is not an error. Behaviour on brand rename or
   unbind is deferred to a follow-up, alongside the existing `brands.json`
   delete-compaction future-work item noted in `src/shared/brands.ts`.

4. **Strategy and KPIs are advisory context, not action authority. Resolved.**
   A KPI may shape a recommendation or tighten a proposed guardrail, but it
   never authorises execution or loosens an absolute ceiling. This preserves
   the separation already accepted by the action-authority decision: flexible
   strategy above core, deterministic write policy in core.

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
  questions governed by the accepted action-authority decision. Excluded from
  this decision.
- **Putting budgets, payout ceilings, or write eligibility in `KPI.md`.**
  Would make an editable advisory document part of the safety boundary and
  conflict with the accepted action-authority decision. Rejected; those
  controls belong in deterministic policy.
- **Doing nothing.** Leaves client intent in decks and email threads, which is
  the status quo failure this decision exists to fix.

## Consequences

- New per-client files appear under the config directory; they stay on the
  user's machine and follow the existing permission and atomic-write
  conventions.
- Relevant file contents enter the connected AI client's context when a user
  invokes a skill that reads them; project telemetry and project-operated
  services never receive them.
- Reader skills gain a context-loading step and must implement the four
  positions above, including unsupported-metric reporting, parse-failure
  reporting, advisory-only treatment, and orphan handling.
- Reports become judgements against the client's own plan ("down 18% but
  still 6% ahead of the quarterly target") rather than bare percentages.
- Nothing changes at runtime until the follow-ups land; this PR is direction
  only. Product docs and the README gain pointers when the capability ships,
  not before.

## Implementation follow-ups

Each is a separate future PR, kept draft until this decision merges:

1. **KPI threshold convention.** Define a versioned, validated, parseable
   `KPI.md` grammar with examples and tests; require malformed and unknown
   entries to fail visibly; update the onboarding skill design to emit it.
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
