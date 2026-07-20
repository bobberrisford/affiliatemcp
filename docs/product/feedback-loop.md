# Feedback to product-improvement loop

Status: Current

This document describes how user feedback enters the project and becomes a
concrete product improvement. It is the operating model, not a proposal. Accepted
records under [`../decisions/`](../decisions) and shipped behaviour remain
authoritative where they disagree.

The goal is that a user can report a gap, a bug, or an idea from wherever they
already work, and see it turn into a docs fix, an adapter repair, or a roadmap
item, without the feedback getting lost.

## Principles

- Local-first is preserved. Feedback is only what a user voluntarily submits. No
  telemetry channel carries free text; see the boundary section below.
- Capture where the user is. Different cohorts live in different surfaces, so the
  loop meets them there rather than forcing everyone onto GitHub.
- Every item has one disposition. Feedback is either turned into a tracked
  improvement, merged into an existing item, or closed with a reason. Nothing is
  left unanswered.

## Capture: where feedback comes from

| Surface | Who it reaches | What it captures |
| --- | --- | --- |
| [`feedback`](../../.github/ISSUE_TEMPLATE/feedback.yml) issue template | Developers, semi-technical operators | Feature requests, workflow gaps, general feedback |
| [`setup-stuck`](../../.github/ISSUE_TEMPLATE/setup-stuck.yml) | Anyone blocked in setup | Onboarding friction, unclear docs |
| [`network-broken`](../../.github/ISSUE_TEMPLATE/network-broken.yml), [`network-api-changed`](../../.github/ISSUE_TEMPLATE/network-api-changed.yml) | Users hitting a failing adapter | Breakage and upstream API drift |
| [`new-network-request`](../../.github/ISSUE_TEMPLATE/new-network-request.yml), [`new-skill-idea`](../../.github/ISSUE_TEMPLATE/new-skill-idea.yml) | Users wanting coverage | Requested networks and workflows |
| GitHub [Discussions](https://github.com/bobberrisford/affiliatemcp/discussions) | Anyone with an open-ended question | Questions, discussion, early signals |
| Desktop app "Give feedback" entry point | Non-technical desktop users | One-click route to a pre-filled feedback issue |
| Hosted product "Give feedback" link | Hosted-tier users | A private channel from inside the product |
| Opt-in telemetry aggregates | Consenting users, in aggregate only | Which networks and operations are exercised, and coarse outcome categories |

The desktop and hosted entry points are documented here as part of the loop; they
are delivered as separate, privacy-clean changes and route users to the channels
above rather than storing feedback themselves.

Telemetry is a signal, not a message. It reports counts by network slug,
operation, and coarse outcome category, and never free text, per
[`../decisions/2026-06-13-privacy-first-telemetry.md`](../decisions/2026-06-13-privacy-first-telemetry.md)
and [`../../PRIVACY.md`](../../PRIVACY.md). A rising error category is a prompt to
look, not a description of the problem.

## Triage: turning input into a tracked item

Review the open feedback surfaces on a weekly cadence, alongside the existing
weekly product-led-growth pass. For each new item:

1. Confirm which template or surface it came through and whether it duplicates an
   existing issue. Merge duplicates and link them.
2. Apply a disposition label:
   - `feedback` for general input still being read;
   - `broken` or `needs-triage` for adapter failures already carried by the
     network templates;
   - `docs` and `setup` for onboarding and documentation friction;
   - `skill-idea` and `discussion` for proposed workflows.
3. Note the cohort where the template captured it, so recurring needs from one
   audience are visible.

## Convert: from feedback to improvement

Each kind of feedback maps to an existing product mechanism. Prefer these over
inventing new ones:

- **Adapter breakage or API drift** becomes a
  [`findings`](../findings) update, a `REPORT.md` regeneration, and an adapter
  fix, gated by
  [`../decisions/2026-06-15-adapter-promotion-gates.md`](../decisions/2026-06-15-adapter-promotion-gates.md).
- **Setup confusion** becomes an edit to the relevant
  [`../networks/`](../networks) walkthrough or the setup wizard copy.
- **A feature request or workflow gap** becomes an item in
  [`roadmap.md`](./roadmap.md), sequenced against existing priorities.
- **A requested network or skill** is tracked through its request template and,
  if accepted, added to the roadmap.
- **A recurring telemetry error-category spike** informs adapter priority and
  promotion order, the stated purpose of the telemetry decision.

Product-direction, architecture, privacy, and security-sensitive changes still
follow the delivery protocol in [`../../AGENTS.md`](../../AGENTS.md): a decision
record first where one is required.

## Close the loop

When feedback produces a change, reply on the originating issue, link the pull
request or roadmap item, and, for shipped work, note it in the release notes. If
an item will not be actioned, say so and why. A reporter should always be able to
see what happened to their feedback.

## Privacy boundary and non-goals

- No feedback surface adds a phone-home path. Telemetry stays opt-in,
  aggregate-only, and free of free text.
- The desktop and hosted entry points route users to GitHub or a private email
  channel; they do not, by themselves, store feedback.
- A feedback channel that stores or transmits user-authored free text inside the
  hosted boundary would be a change to what the project holds and would require
  its own accepted decision record and a lockstep `PRIVACY.md` update before
  implementation.
