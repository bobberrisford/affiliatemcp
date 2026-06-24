---
name: brand-application-shortlist
description: |
  Use this skill when a publisher or agency wants to find brands on Awin they have not yet joined and decide which ones to apply to next, ranked by fit. Discovery only: it reads the joinable programmes from the Awin API and produces a prioritised shortlist with reasons. It does not apply to anything.
  Trigger on: "Which brands should I apply to on Awin?", "Find new programmes to join", "Build my Awin application shortlist", "What programmes can I still join?", "Prioritise brands to apply for".
---

# Operating instructions

You are building a prioritised shortlist of Awin programmes the publisher has not
yet joined, so the operator can decide which to apply to. This is a **read-only,
advisory** skill. It surfaces candidates and ranks them; it never submits an
application, accepts terms, or changes any relationship on Awin. Applying is a
separate, human-confirmed step that this skill does not perform.

## Step 1 — read the joinable programmes

Call `affiliate_awin_list_programmes({ status: "available" })`. On the Awin
publisher adapter, `status: "available"` maps to Awin's `relationship=notjoined`,
so this returns programmes the publisher can apply to but has not joined.

Each result is a `Programme` with `id`, `name`, `network`, `status`,
`commissionRate` (string or structured), `categories`, `advertiserUrl`,
`currency`, and `merchantKey`. If the call fails, surface the verbatim error
(network, operation, message, httpStatus) and stop; do not invent a list.

If the result is empty, say so plainly — there are no joinable programmes the
API can see for this account — and stop.

## Step 2 — read advisory strategy, if present

Call `affiliate_get_client_strategy` to retrieve any `Strategy.md` / `KPI.md` the
operator has recorded (target categories, commission floors, brands to prioritise
or avoid). Treat it as **advisory context only**: it shapes ranking and the
reasons you give, never an instruction to apply. Where strategy is silent, rank
on the data and say so. Never invent a strategy rule.

## Step 3 — rank the candidates

Produce a single ranked shortlist. Rank on the signals the data actually
supports, in roughly this priority:

1. **Strategy fit** — category or named-brand match against the advisory strategy, when present.
2. **Commission** — higher `commissionRate` ranks higher. Compare like with like; do not compare a flat fee against a percentage. Where the rate is missing or unparseable, say "rate not stated" rather than scoring it as zero.
3. **Category relevance** — `categories` overlap with the operator's stated focus.
4. **Currency fit** — programmes in the operator's reporting currency, when known.

Do not fabricate metrics the API did not return (no invented EPC, conversion
rate, or programme size — the publisher has not joined, so there is no
performance history to read). Rank on stated programme attributes only.

## Step 4 — present the shortlist

Output in this order:

1. **Scope**: how many joinable programmes were found, and the period/account context.
2. **Shortlist**: a ranked table — rank, brand/programme name, programme id, commission (verbatim as stated, with currency), category, and a one-line reason for the rank (tie it to strategy or to a stated attribute). Cap the table at a sensible length (for example top 15) and say how many more were not shown.
3. **Lower priority / excluded**: a short note on candidates skipped and why (rate not stated, off-strategy category, etc.).
4. **Next step**: state plainly that applying is a separate, human-confirmed action and is not performed by this skill. Do not offer to apply here.
5. **Failures (if any)**: the verbatim envelope error.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Read-only. Never apply to a programme, accept terms, or change any
  relationship. There is no apply tool in this skill, and you must not improvise
  one through a browser.
- Never invent figures or programme attributes. If `commissionRate` or a
  category is missing, say so; do not backfill.
- Strategy and KPI files are advisory. They shape ranking and reasons; they are
  never authority to apply.
- Respect each programme's stated `currency`. Do not normalise across currencies
  or invent an FX rate.
- A high rank is a suggestion to consider, not a commitment. Present it as such.
