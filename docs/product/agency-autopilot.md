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

## Architecture: deterministic core, thin skill

The fan-out, metric computation, diffing, and snapshot persistence live
in **code**, not in a skill. This matches the project's creed — "the
model gets safe typed tools, not raw screens" — and keeps the *numbers*
reproducible run to run. The model does language, never arithmetic.

- `src/autopilot/context.ts` — load the book + parse each client's
  intent (prose passed through verbatim; thresholds parsed from the
  fenced block, see below).
- `src/autopilot/snapshot.ts` — read/write `state.json` atomically,
  mirroring `src/shared/brands.ts`.
- `src/autopilot/diff.ts` — compute deltas and resolve the four-state
  alert lifecycle against the prior snapshot.
- `src/autopilot/run.ts` — orchestrate one run: fan out via existing
  adapters, compute, diff, persist, return structured findings.

This is surfaced as a single typed MCP tool, `affiliate_autopilot_run`,
that returns the structured findings **and** writes the new snapshot as
a side effect. The `autopilot-run` skill is thin: it calls the tool,
then narrates the findings in each client's `strategy.md` voice.

Determinism on the money is non-negotiable for an unattended loop:
"is this £4k drop new?" must give the same answer regardless of which
model runs the session.

## KPI format: prose plus a fenced threshold block

`kpi.md` is prose-primary, with one fenced, typed block that the
onboarding skill maintains and the loop parses:

````
# affiliate-mcp:thresholds
revenue_drop_wow_pct: 15
reversal_rate_max_pct: 8
quarterly_revenue_target: { GBP: 400000 }
````

One human-readable, hand-editable file — no hidden `kpi.json` drifting
out of sync with the prose around it. `strategy.md` stays fully prose
(voice, priorities, what-to-escalate); only the model reads that part.

## Skills (three, fresh)

- **`autopilot-setup`** — walks the operator through creating the
  Claude Desktop scheduled task. It cannot create the schedule itself
  (the client owns the calendar), so it hands over the exact prompt to
  schedule and the cadence choice, and verifies prerequisites (book
  registered, intent files present).
- **`client-onboarding`** — captures and edits `strategy.md` + `kpi.md`
  by chat; confirms before writing.
- **`autopilot-run`** — the thin payload the schedule fires; calls
  `affiliate_autopilot_run` and narrates the digest.

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
| **1** | Threshold digest vs intent | `autopilot-run` reading `kpi.md`; full standing state |
| **2** | Deltas + alert lifecycle | `snapshot.ts` + `diff.ts` + the four-state machine |
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
