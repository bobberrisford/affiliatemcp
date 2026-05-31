---
name: publisher-application-approvals
description: |
  Use this skill when an affiliate network manager wants to work through the queue of publishers who have applied to a programme and approve or reject them. This is a browser workflow — there is no public API for actioning applications — so it drives the live network dashboard (Awin first) in the operator's own signed-in session via a browser tool (the Claude for Chrome extension, a Playwright MCP, or computer-use). It judges each applicant against an appropriateness rubric, auto-actions the clear-cut cases, and escalates the borderline ones to the human with evidence.
  Trigger on: "approve publishers on Awin", "review my pending affiliate applications", "go through the publisher application queue", "who should I approve or reject", "triage my Awin applications".
---

# Operating instructions

You are working through a network's pending **publisher application queue** in the
operator's live, already-signed-in browser session. There is no API for this — you read
the dashboard and click. Your job per applicant: gather evidence, judge appropriateness
against the rubric, then either action the obvious cases or escalate the borderline ones.

Read [`rubric.md`](./rubric.md) before you start — it is the contract for every decision.
This skill is dashboard-driven and does **not** call any `affiliate_*` MCP tool; the
`affiliate_*` tools are for API-backed reporting, not application actioning.

## Step 1 — confirm scope and mode

Before touching the browser, state plainly and get the operator's confirmation:

1. **Which network and account** you will operate (default: Awin, the account currently
   signed in). Confirm you will be acting in their live dashboard.
2. **Run mode**:
   - `auto` (default) — auto-approve clear passes, auto-reject clear fails, escalate the
     rest. This clicks real controls.
   - `recommend-only` — never click; produce recommendations the operator actions. **Offer
     this as the safer choice for a first run**, especially before the rubric is tuned.
3. **Volume guard** — a maximum number of applications to auto-action in one run before
   pausing for re-confirmation (default 10). Bulk actioning a large queue unattended is the
   highest-risk path; pause and re-confirm past the limit.

If the operator has not yet confirmed mode and scope, stop and ask. Do not assume `auto`.

## Step 2 — open the applications queue

Navigate to the network's pending publisher applications view. Because you are reading the
live page, **do not rely on hard-coded selectors** — locate the queue by its visible labels
and adapt to the current UI.

For Awin, the application/partnership requests live under the advertiser's publisher
management area. See **Known navigation (Awin)** at the foot of this file; if that note is
empty or stale, find the queue by reading the dashboard, then record the confirmed path
back into that note so later runs are faster.

If you cannot find a pending-applications queue, say so plainly and stop — do not guess at
another screen.

## Step 3 — gather evidence per application

For each pending application, capture from the application record:

- publisher name and account/ID,
- **website / promotional URL**,
- declared promotional methods (content, cashback, voucher, email, social, PPC, etc.),
- primary category / vertical,
- region / audience geography and any declared traffic sources.

Then **open the publisher's website in the browser and assess it live**: is it reachable,
real, on-topic for a plausible advertiser, and not thin / made-for-affiliate / AI-spam /
scraped. Note what you actually saw — not what the application claims.

If the website is missing, unreachable, or you cannot gather enough to judge, that pushes
the verdict to `escalate` (or `reject` if a hard gate in the rubric is clearly tripped).

## Step 4 — evaluate against the rubric

Apply [`rubric.md`](./rubric.md). For each applicant produce:

- **hard-gate results** (each pass/fail, with the evidence that decided it),
- **soft-signal notes**,
- a **verdict**: `approve`, `reject`, or `escalate`,
- a **one-line justification** citing the specific gate or signal that drove it.

The decision policy (tunable in the rubric):

- all hard gates pass **and** no soft-risk flags → `approve`
- any hard gate fails → `reject`
- hard gates pass but soft signals are weak / mixed / uncertain, or evidence is thin →
  `escalate`

Never invent evidence and never guess to avoid an escalation. When in doubt, escalate.

## Step 5 — act according to mode

- **`auto` + clear-cut `approve`/`reject`** → click the corresponding control in the
  dashboard. Confirm the action registered (the row left the pending queue / status
  changed) and record that confirmation. If the click does not visibly take, stop and report
  — do not retry blindly.
- **`escalate`** (or any ambiguity, missing website, or rubric conflict) → **do not click**.
  Add it to the escalation list with the reason and the evidence you gathered.
- **`recommend-only` mode** → never click anything that changes state. Record the
  recommendation for every applicant, including the ones you would have auto-actioned.

Respect the volume guard from Step 1: when you reach the limit of auto-actions, pause and
re-confirm before continuing.

## Step 6 — produce the decision log and summary

Emit an auditable decision log — one row per application (see format below) — and a short
headline: counts of approved / rejected / escalated (or, in recommend-only mode,
recommended-approve / recommended-reject / escalated), followed by the **"Needs your
decision"** list of escalations for the operator to action by hand.

Offer to save the log to a local file (e.g. `~/affiliate-approvals/<network>-<YYYY-MM-DD>.md`)
so the operator keeps a trail. Default to showing it in chat.

### Decision-log format

A compact table, one row per application:

| Publisher | URL | Hard gates | Soft signals | Verdict | Action | Why |
| --- | --- | --- | --- | --- | --- | --- |
| name | site | pass / which failed | brief notes | approve/reject/escalate | actioned & confirmed / escalated / recommended | one line citing the deciding gate or signal |

Then a **Needs your decision** section listing each escalation with its evidence and the
specific reason it could not be auto-actioned.

## Constraints

- **Browser-tool-agnostic.** Drive whatever browser capability is present — the Claude for
  Chrome extension (operating the operator's real signed-in session), a Playwright MCP, or
  computer-use. Do not assume a specific one; do not store or ask for dashboard credentials.
- **Act only inside the pending-applications queue.** Never change programme terms,
  commission rates, payments, or any setting outside actioning a pending application.
- **Clicks happen only in `auto` mode, only on clear-cut verdicts, within the volume guard.**
  Everything else is escalated. Recommend-only never clicks.
- **Cite evidence for every decision.** A verdict with no observed evidence is an escalation,
  not an approval or rejection.
- **Escalate rather than guess.** Thin evidence, an unreachable site, or a rubric conflict
  is always an escalation.
- **Honest reporting.** If a click does not register, if the queue can't be found, or if the
  dashboard layout has changed, say so plainly and stop — never fabricate a confirmation.
- Matter-of-fact tone, UK spelling.
- Pair with the operator's own appropriateness policy: the default [`rubric.md`](./rubric.md)
  is meant to be edited.

## Known navigation (Awin)

_Record the confirmed path to the pending publisher applications queue here on the first
successful run (menu labels verbatim), so later runs skip the discovery step. Left
deliberately blank until verified against the live dashboard — do not invent a path._
