# Agency autopilot — design (2026-06-02)

> Status: design doc, pre-implementation. Defines the autonomous
> agency loop for `affiliate-mcp`. Designed fresh; it does not depend
> on the earlier `agency-automation.md` or `doing-layer.md` notes,
> though it reuses ideas from both. UK English throughout.

## Purpose

Promote the agency-side reporting the project already does from a
human-in-the-loop conversation into an **unattended loop** that runs on
a schedule, watches the whole client book, and surfaces only what
changed or breached a client's own targets.

The fan-out already exists: `affiliate_resolve_brand` plus the
`(brand × network)` bindings in `brands.json` let one question explode
across the book. What is missing is the **ignition** (a schedule), the
**memory** (so a run knows what changed since the last one), and the
**judgement** (so a delta is read against what the client actually
wants). This note designs those three.

This is agency-first by choice. The same machinery serves a single
publisher later, but the agency portfolio is where unattended watching
earns its keep.

## The unit of work: a *run*

Everything is organised around one concept — a **run**: a single
scheduled, unattended invocation. Every run is the same seven steps;
the autonomy rungs (see Roadmap) only add capability to steps 5–6.

1. **Load the book** — `brands.json` bindings. *(exists today)*
2. **Load intent** — each client's `strategy.md` + `kpi.md`.
3. **Load last run's state** — the snapshot from the previous run.
4. **Fan out** — read calls across every `(brand × network)` pair, in
   parallel, through the existing adapters. Read-only; no contract change.
5. **Judge** — current metrics against *two* references: the client's
   thresholds (intent) and the prior snapshot (what changed).
6. **Emit + deliver** — a ranked, de-duplicated digest; only what is
   new, worsening, or resolved.
7. **Persist** — write the new snapshot and an append-only audit line.

## Two memory layers, kept deliberately apart

There are two kinds of memory, and conflating them is how "memory"
becomes a file nobody trusts. They are stored separately and joined
only by the shared **brand slug**.

- **Intent memory** — *what the client is trying to do.* Prose and
  thresholds, human-authored, slow-changing. Turns "Acme down 18%" into
  "down 18% but still 6% ahead of the quarterly target."
- **Run-state memory** — *what the numbers were last run.* Compact,
  machine-authored, rewritten every run. The thing that lets a run say
  "**new** reversal spike since last week" instead of re-reporting
  standing facts.

### On-disk layout

```
~/.affiliate-mcp/
  .env                       # credentials            (exists)
  brands.json                # the book               (exists)
  clients/<slug>/
    strategy.md              # INTENT — prose, human-authored
    kpi.md                   # INTENT — targets + thresholds
  autopilot/
    <loop>/state.json        # RUN-STATE — machine-authored, rewritten each run
    <loop>/digest.md         # last delivered digest
    <loop>/log.ndjson        # append-only run history (audit)
```

`clients/` and `autopilot/` are split on purpose: different owner,
lifecycle, and trust. Intent is hand-maintained and must never be
clobbered by a script; run-state is disposable and never hand-edited.
Both follow the local-first, read-fresh-each-call, atomic-write
conventions already used by `src/shared/brands.ts`. Nothing is uploaded.

## The alert lifecycle — why this isn't spam

A naive scheduled watcher re-screams the same problem every run until
the operator mutes it. The snapshot's primary job is therefore
**suppression**, not analytics. Each finding carries a state:

- **`new`** — absent last run → surface loudly.
- **`ongoing`** — same finding, no material change → suppress to a
  single quiet "still open" footnote.
- **`worsened`** — crossed the next step threshold → re-surface with
  both the previous and current figures.
- **`resolved`** — was open, now back in band → one closing line, then
  forget.

This state machine is the core deliverable of Rung 2. Getting it right
is what earns the loop the trust to climb to drafting and acting.

## Architecture: skill-driven, with one tiny store

A review for simplicity changed the original plan here. The project
already computes its analysis **in the model**, from typed tool output —
`programme-anomaly-watch` already defines every anomaly (revenue drop,
reversal spike, top-10 dropout, silenced publisher, dead programme). A
"deterministic code core" would have re-implemented that in TypeScript
and introduced a second computation paradigm. So the autopilot keeps the
analysis in a skill and adds only the one thing the codebase genuinely
lacks: **a place to persist run-state**.

- `src/shared/autopilot.ts` — the store. Mirrors `src/shared/brands.ts`
  (fresh read per call, atomic temp-write + rename, mode 0600). Loads the
  book + each client's intent (prose verbatim; thresholds parsed from the
  fenced block) + the last snapshot; saves the new snapshot, the digest,
  and client intent. It does **not** compute anything.
- Three meta-tools in `src/tools/generate.ts` (the `affiliate_resolve_brand`
  pattern): `affiliate_autopilot_load_context`, `affiliate_autopilot_save_state`,
  `affiliate_autopilot_save_intent`. These are the first server tools that
  *write* under `~/.affiliate-mcp/`; writes are confined to the
  `autopilot/` and `clients/` subtrees.

The `autopilot-run` skill carries the logic: load context, fan out via
the existing per-network performance tools, compute anomalies (reusing
anomaly-watch's definitions) against each client's thresholds, assign the
four-state lifecycle by diffing against the loaded snapshot, render the
digest in the client's voice, then save the snapshot.

The snapshot freezes each run's numbers, so the run-to-run comparison is
stable even though the figures are model-computed — the diff is "compare
the stored number to the new number", which the model does reliably.

## Intent storage: human-editable markdown, read via the store tool

`strategy.md` and `kpi.md` stay plain markdown on disk so the operator can
hand-edit them. A scheduled Claude Desktop session is not assumed to have
a filesystem connector, so the **affiliate-mcp store tool reads the files
off disk and returns their contents** — no external connector needed, and
the files remain editable by hand. Onboarding writes them through the same
tool.

## KPI format: prose plus a fenced threshold block

`kpi.md` is prose-primary, with one fenced, typed block that the
onboarding skill maintains and the loop parses:

````
# affiliate-mcp:thresholds
revenue_drop_wow_pct: 15
reversal_rate_max_pct: 8
quarterly_revenue_target_gbp: 400000
````

Simple `key: value` lines (no nested objects — keep currency in the key,
e.g. `_gbp`), so parsing needs no YAML dependency. One human-readable,
hand-editable file — no hidden `kpi.json` drifting out of sync with the
prose around it. `strategy.md` stays fully prose (voice, priorities,
what-to-escalate); only the model reads that part.

## Skills (three, fresh)

- **`autopilot-setup`** — walks the operator through creating the
  Claude Desktop scheduled task. It cannot create the schedule itself
  (the client owns the calendar), so it hands over the exact prompt to
  schedule and the cadence choice, and verifies prerequisites (book
  registered, intent files present).
- **`client-onboarding`** — captures and edits `strategy.md` + `kpi.md`
  by chat; confirms before writing.
- **`autopilot-run`** — the payload the schedule fires; calls
  `affiliate_autopilot_load_context`, fans out, computes, then
  `affiliate_autopilot_save_state`, narrating the digest in each
  client's voice.

## Scheduling: Claude Desktop, local-first

The loop fires from a **Claude Desktop scheduled task**. Each run is a
fresh local session with full access to the MCP server, skills, and
connectors. Because the server already runs locally over stdio with
credentials in `~/.affiliate-mcp/.env`, there is **no credential
provisioning gap** — this is the most local-first-aligned scheduling
path available, and it honours the manifesto with no new infrastructure.

One honest limitation: a Desktop task only fires while the app is
running and the machine is awake; a run scheduled during sleep is
skipped. For always-on overnight coverage, Cloud Routines are the later
escape hatch — but they reintroduce hosted/awake-when-closed tradeoffs,
so they are explicitly out of scope for v1.

## Delivery: session surface, v1

The digest is rendered in the scheduled session and saved to
`autopilot/<loop>/digest.md`. Out-of-band delivery (email, Slack via an
available connector) is deferred — it is the difference between "feels
autonomous" and "actually autonomous", and worth doing, but not a v1
blocker.

## Roadmap (the rungs)

| Rung | Adds | Build |
| --- | --- | --- |
| **1** | Threshold digest vs intent | `autopilot-run` reading `kpi.md` thresholds; full standing state |
| **2** | Deltas + alert lifecycle | the store (`src/shared/autopilot.ts`) + the four-state machine in `autopilot-run` |
| **3** | Drafts the client update / next action (read-only; human sends) | Generation step in the skill, using `strategy.md` voice |
| **4** | Consent-gated writes | A consent + audit layer; its own gated design |

Rungs 1 and 2 ship together as the **first slice** — the snapshot is
useless split in half. Rung 4 unwinds the read-only advertiser contract
and is deliberately a separate, later, explicitly-gated decision, not
something smuggled in via a schedule.

## Principle alignment and non-goals

In scope and aligned with the manifesto:

- Local-first; credentials never leave the machine.
- Read-only for v1–v3; every fan-out call is a GET through existing
  adapters.
- Honest output: a failed fan-out call is reported as a failure, never
  silently treated as "no anomaly". The existing `NetworkErrorEnvelope`
  carries this through.

Explicit non-goals for this design:

- **No hosted service** and no telemetry.
- **No network writes** until Rung 4, which is out of scope here.
- **No always-on/Cloud Routines** dependency in v1.
- **No new cross-network abstraction** beyond the autopilot module
  itself, which is additive and touches no adapter contract.
