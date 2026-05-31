# Publisher-application approvals: a browser-driven workflow

## The job

An affiliate network manager who looks after multiple brands spends real time on
**publisher application approvals**. Publishers apply to a programme; the manager opens the
queue, judges whether each applicant is *appropriate* for the advertiser, and approves or
rejects them. It is repetitive, judgement-heavy, and time-sensitive — applications pile up,
and good publishers churn while they wait.

## Why this is not an API adapter

The rest of `affiliate-mcp` wraps **public network APIs** into typed, read-only tools.
Application actioning does not fit that model: **there is no public API for it.** On Awin —
and on the networks we checked — approving or rejecting a pending publisher application
happens in the **dashboard UI**, not over an API. So this capability sits deliberately
outside the API-adapter layer. It is shipped as a **skill** — a workflow Claude follows —
not as adapter code.

(The API-side work we explored — modelling each network's validation/locking SLAs — was
useful for *discovering* which jobs matter and how time-critical they are, but it does not
let you action an application. The approval job is browser work.)

## Mechanism: drive the operator's own browser

The skill drives the manager's **live, already-signed-in** dashboard session through a
browser tool — primarily the **Claude for Chrome extension**, which operates the operator's
real Chrome tab. This has three properties that matter:

- **No credential handling.** The skill never sees, stores, or asks for dashboard logins —
  it works in the session the operator is already authenticated in. Nothing about logins or
  2FA enters the repo.
- **No brittle selectors.** Because the tool reads the live page, the skill locates the
  applications queue by visible labels and adapts, rather than pinning CSS selectors that
  break when the dashboard changes.
- **Tool-agnostic.** The skill is written to drive *whatever* browser capability is present
  — the Chrome extension, a Playwright MCP, or computer-use — so it is not locked to one.

## The rubric and the decision policy

Appropriateness is judged against an **editable rubric**
([`skills/publisher-application-approvals/rubric.md`](../../skills/publisher-application-approvals/rubric.md)),
structured in two tiers so the automation boundary is unambiguous:

- **Hard gates** (pass/fail): a live relevant website, permitted promotional methods, no
  brand-bidding abuse, genuine content (not made-for-affiliate), a complete non-fraudulent
  application. **Any** failure → reject.
- **Soft signals** (judged once gates pass): content quality, audience/geo fit,
  traffic-source transparency, niche relevance, professionalism.

**Decision policy:** all gates pass and no soft-risk flags → approve; any gate fails →
reject; gates pass but soft signals are weak/mixed/uncertain (or evidence is thin) →
**escalate**.

## Autonomy: auto the clear-cut, escalate the borderline

The skill **auto-actions the clear-cut cases** — clean approvals and unambiguous rejections —
and **escalates everything else** to the manager with the evidence it gathered. This keeps
the manager's judgement on exactly the cases that need it, and off the obvious ones.

Safety rails:

- A **`recommend-only` mode** that never clicks — recommended as the first run, especially
  before the rubric is tuned.
- A **volume guard** that pauses for re-confirmation before auto-actioning more than a set
  number of applications in one run.
- The skill **acts only inside the pending-applications queue** — never programme terms,
  commission, or payments.
- It **cites evidence for every decision** and **escalates rather than guesses**; a verdict
  with no observed evidence is an escalation.

## The audit trail

Every run emits a **decision log** — one row per application: publisher, URL, hard-gate
results, soft-signal notes, verdict, the action taken (and, for auto-actioned items, a
confirmation that the dashboard click registered), and a one-line justification. Escalations
are collected into a "Needs your decision" list. The log can be saved locally
(`~/affiliate-approvals/<network>-<date>.md`) so the manager keeps a record of what was
actioned and why.

## Relationship to the project's read-only stance

`affiliate-mcp` is read-only on the API side, and that does not change: the adapters still
do not write. This skill is a **separate, opt-in, operator-driven browser workflow** — the
manager is acting in their own dashboard session, exactly as they would by hand, with the
skill doing the legwork and keeping the trail. `CONTRIBUTING.md` is updated to reflect that
browser-driven workflow skills of this kind are in scope, distinct from the read-only API
adapters.

## Scope today and next

**Today:** Awin, the three-tier verdict (approve / reject / escalate), `auto` and
`recommend-only` modes, the volume guard, and the in-chat decision log.

**Next:** per-advertiser/per-programme rubric files; persistent decision-log files by
default; and extending the skill to other network dashboards (CJ, Impact) once their queue
layouts are confirmed.
