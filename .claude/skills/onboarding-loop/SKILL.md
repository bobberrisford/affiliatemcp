---
name: onboarding-loop
description: |
  Use this skill to prepare onboarding and lifecycle email for new and dormant hosted sign-ups in prepare-and-approve mode: a guided first-value message for a fresh sign-up, an activation nudge for someone who connected but has not run a report, and a re-engagement draft for a dormant account. It prepares Gmail drafts only; it never sends. Distinct from the agency `client-onboarding` skill, which records a client's advisory strategy.
  Trigger on: "prepare onboarding emails", "draft activation nudges", "welcome new sign-ups", "re-engage dormant hosted users", "run the onboarding loop".
---

# Operating instructions

You prepare the lifecycle email a hosted user should receive, as **Gmail drafts
only**. You never send. This honours the authority boundary in
`docs/decisions/2026-07-20-agentic-company-operations.md` and the operating
model in `docs/product/solo-50k-revenue-plan.md` section 6 ("onboarding replaces
account management").

This is not the agency `client-onboarding` skill (which records a client's
strategy and KPI targets). This loop is about bringing a new **product** sign-up
to first value and keeping accounts active.

## The targeting dependency (read this first)

You need a signal of **who** to contact: who just signed up, who connected but
has not run a report, who has gone quiet. That roster lives on the hosted side.
Per `hosted/src/digest.ts`, the active-subscriber roster is enumerated
**in-process from `HOSTED_BILLING` KV and never exposed over HTTP**, so an agent
session cannot read it directly.

Therefore this loop is **partial by design** until a safe read-only path is
connected:

- If the operator supplies a target list (or a connected read path exists),
  prepare drafts for those users.
- If no target signal is available, say so plainly in the brief
  ("onboarding: no sign-up signal connected") and prepare **reusable draft
  templates** (below) rather than guessing at recipients. Never invent
  sign-ups or email addresses.

Do not build a new data egress from the hosted service to get this signal; that
would need its own decision under the custody record. Reuse the existing
`listActiveSubscribers` enumeration on the hosted side if and when onboarding
signals are surfaced through an approved read path.

## The three lifecycle drafts

Prepare whichever apply to a given user (or as templates when untargeted):

1. **First value (new sign-up).** Welcome, the single next action to see their
   own numbers, and what to expect. The first-value report itself reuses the
   digest compose path (`composeDigestForUser` in `src/hosted-digest/run.ts`,
   the same engine behind the weekly digest) rather than any new report code.
   Keep it to one clear call to action.
2. **Activation nudge (connected, no report yet).** A short prompt with the
   exact first thing to ask in their MCP client, framed around their own data.
3. **Re-engagement (dormant).** A light, non-pushy check-in that leads with a
   concrete recent value the product can show, not a plea to come back. Honour
   unsubscribe and frequency norms; one re-engagement draft, not a sequence that
   would read as pressure.

## Preparing the drafts

- Create each as a **Gmail draft** via the Gmail MCP `create_draft`. Never call
  a send path.
- Voice: matter-of-fact, UK English, no marketing language, no fake urgency.
  Lead with the user's own outcome, tool second (the launch-content register).
- Never include another user's data, and never present illustrative numbers as
  the recipient's real figures. If you show a sample, label it a sample.
- Hand each draft to `company-ops` for the brief's Approvals-waiting section,
  keyed by lifecycle stage and an opaque handle (never the full address).

## Constraints

- Draft-only. No sent email, ever, without the operator's approval.
- Partial-honest: with no sign-up signal, prepare templates and say so; do not
  fabricate a recipient list.
- Reuse the digest compose engine for first-value content; do not add report
  code or new tools.
- Stay within the custody contract: no new data path out of the hosted service.
