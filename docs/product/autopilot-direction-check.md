# Agency autopilot — direction check

> For review. A short note on where we're taking affiliate-mcp, what we
> just built, and the judgement calls behind it — so we can confirm the
> direction before building further. Full design in
> [`agency-autopilot.md`](./agency-autopilot.md). UK English.

## The goal in one line

Turn affiliate-mcp from a tool you *ask* into a loop that *watches* — so an
agency learns about problems in its client book before the clients do, without
anyone re-running a report every Monday.

## Why now, and why this is a natural step (not a pivot)

Today the product answers questions: "how is Acme doing this quarter?", "any
anomalies this week?". The answers are good, but they only exist when a human
opens a conversation and asks. The data, the fan-out across every brand ×
network, and the anomaly logic already exist — they're just driven by a person
typing. **Autonomy here is mostly removing the person from the trigger**, not
inventing new capability. That's why this is a small, low-risk step rather than
a new product.

## The strategy: a ladder, not a leap

"Fully autonomous" is a direction, not a v1. We've framed it as four rungs, each
shippable and trust-building on its own:

| Rung | What it does | Status |
| --- | --- | --- |
| **1** | Scheduled digest judged against each client's targets | **built — on branch, not yet released** |
| **2** | Reports only what *changed* since last run (not standing facts) | **built — on branch, not yet released** |
| **3** | Drafts the client update / next action — human still sends | next |
| **4** | Acts on the network (approve publisher, adjust rate) under consent | later, gated |

> Status note: Rungs 1–2 are **code-complete on the feature branch with the
> full test suite green** — they have not been merged or released. This note is
> the gate before that happens.

We deliberately ship the low-conflict rungs first. Rungs 1–3 stay **read-only**
and **local-first**, which keeps us fully inside the manifesto. Rung 4 unwinds
the read-only guarantee, so it's a separate, explicit decision with its own
consent/audit design — not something that arrives by accident via a schedule.

## What we just built (Rungs 1–2, on the branch)

Three things, deliberately small:

1. **Run-state memory.** The one genuinely-new capability. A small local store
   (`src/shared/autopilot.ts`) lets each run remember the last run's numbers, so
   the loop can say "*new* reversal spike since last week" instead of
   re-reporting the same facts every Monday. Without this, a scheduled watcher
   is a broken record nobody reads.
2. **Client intent.** Two human-editable markdown files per client —
   `strategy.md` (priorities, voice) and `kpi.md` (targets + alert thresholds).
   This is what turns "Acme down 18%" into "down 18% but still ahead of the
   quarterly target." Captured by chat (interview, draft, confirm), editable by
   hand.
3. **The loop + on-ramp.** Three skills: `autopilot-run` (the scheduled
   payload), `client-onboarding` (record intent), `autopilot-setup` (wire the
   Claude Desktop scheduled task).

It runs as a **Claude Desktop scheduled task** — a fresh local session on a
timer, credentials staying on the machine, no servers, no hosted service.

## The judgement call worth reviewing

We almost built this as a TypeScript "engine" that computed the analysis in
code. On review we **didn't**, for two reasons:

- The anomaly logic (revenue drops, reversal spikes, dropouts) **already exists**
  as model-driven logic in the existing `programme-anomaly-watch` skill. Rebuilding
  it in code would have duplicated it and introduced a second way of doing the
  same thing.
- The whole project deliberately computes *in the model* from typed tool output.
  A code engine would have fought that grain.

So the analysis stays in a skill, and the **only** new code is the memory store.
The result is much smaller and more in-keeping. The trade we accepted: the
numbers are model-computed, not bit-reproducible. We judged that acceptable
because (a) it's already true everywhere else in the product, and (b) once a
run's numbers are frozen in the snapshot, the run-to-run comparison is stable.
**This is the main thing to sanity-check: are we comfortable that the watching
loop's arithmetic lives in the skill layer rather than in code?**

## How to judge whether it's working

- **Signal, not noise.** Does a run surface what changed and stay quiet about
  standing facts? The four-state lifecycle (new / ongoing / worsened / resolved)
  is the mechanism; alert fatigue is the failure mode to watch.
- **Judged against intent.** Does a digest read against *this client's* targets,
  or is it generic percentages?
- **Easy to feed.** Can a non-technical operator record a client's targets in a
  two-minute chat, and does the digest itself prompt them to when a target is
  missing?

## Open questions for the reviewer

1. **Autonomy ceiling.** Are we aligned that Rung 4 (acting on networks) is a
   separate, consent-gated decision — or is there appetite to push there sooner?
2. **Delivery.** v1 lands the digest in the Claude session. "Actually
   autonomous" means it reaches you without opening the app (email/Slack). Is
   that a fast-follow or can it wait?
3. **Always-on.** Desktop scheduling only fires while the machine is awake. Do
   we need overnight coverage (hosted/Cloud Routines) for real agency use, or is
   awake-hours watching enough to prove the idea?

## Status

Rungs 1–2 are **code-complete on branch `claude/autonomous-project-architecture-6SCsS`,
not merged and not released**: full test suite green, read-only, local-first, no
new infrastructure. Ready to demo against fixtures, and to decide whether to
merge and whether Rung 3 (drafting) is the next build.
