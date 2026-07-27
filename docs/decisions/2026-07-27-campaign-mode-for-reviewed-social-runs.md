# Campaign mode: scheduling a reviewed social run

- **Date:** 2026-07-27
- **Status:** Accepted (2026-07-27) by Rob, the maintainer and decision owner. This
  widens agent authority, narrowly, and was merged as a deliberate act.
- **Amends:** [`2026-07-20-agentic-company-operations.md`](./2026-07-20-agentic-company-operations.md)
  (Accepted 2026-07-21) — specifically the clause requiring social posts to be
  "Buffer drafts (never queued or published by the agent)", and the marketing
  loop's weekly cadence constraint.
- **Builds on:** [`2026-06-26-rob-led-delivery-system.md`](./2026-06-26-rob-led-delivery-system.md)
  (the underlying authority boundary: agents may prepare and recommend, Rob
  decides)
- **Affects:** `.claude/skills/affiliate-mcp-marketing`, `.claude/skills/company-ops`,
  and the Buffer channel

## Context

The accepted operations record draws the authority boundary at the point of
going out: an agent prepares a Buffer **draft**, Rob queues or publishes it.
The marketing loop adds a cadence constraint — "the launch cadence is weekly,
not daily".

For the hosted push (week of 27 July 2026) Rob asked for the queue to be
scheduled directly, as it was for blitz #1 on 20–24 July. That is a seven-post
run over five days. Under the record as written, both the scheduling and the
cadence are disallowed.

Rob is the maintainer and the decision owner, and can simply direct it. But
there is a difference between a maintainer changing a rule and a rule being
quietly ignored, and the second one erodes every other boundary in the same
record — including the ones about sending email and merging pull requests,
which matter more. This amendment makes the change explicit and bounded rather
than leaving the record contradicting practice.

It is also worth recording plainly: blitz #1 was scheduled by an agent on
20–24 July, overlapping the record's acceptance on 21 July. The gap has already
happened once. This closes it rather than pretending it did not.

## Decision

Add **campaign mode** to the operations authority boundary. Outside a campaign,
nothing changes: drafts only, weekly cadence, Rob publishes.

A campaign is in force only when all of the following hold:

1. **It is named and time-boxed.** A start date, an end date, and a slug. The
   hosted push is `hosted-jul26`, 29 July to 4 August 2026.
2. **Every post's copy has been reviewed by Rob in a tracked pull request**
   before anything is scheduled. Not a Buffer draft, not a chat message — a
   diff under `docs/product/launches/week-NN-<slug>/`, where the claims can be
   read against their sources and the review is durable.
3. **Rob explicitly authorises scheduling for that campaign**, after reading it.
   Approval of the campaign plan is not approval of the copy; the copy is
   approved on its own.
4. **Scheduling only.** The agent may place the approved posts into the Buffer
   queue at the agreed slots. It may not write new copy into the queue, alter
   approved copy, extend the run, or add a channel. Any change goes back through
   step 2.
5. **Cadence is set by the campaign**, not by the weekly default. The hosted
   push is 1–2 posts a day on one channel.

Everything outside that list stays exactly as the operations record has it.
Email is still never sent. Pull requests are still never merged. Comments and
replies are still not posted by an agent, campaign or not — a scheduled post is
a reviewed artefact, whereas a reply is improvised in public, and only the first
of those is covered here.

## Rejected alternatives

- **Leave the record alone and schedule anyway.** What was implicitly done in
  blitz #1. Rejected: it makes the record decorative, and the same record is
  what stops an agent sending email or merging a PR.
- **Leave the record alone and hand Rob seven drafts to queue by hand.** Fully
  compliant and genuinely tempting, since the manual step is perhaps ten
  minutes. Rejected because Rob asked for the opposite, and because the real
  control is the copy review, not the button press. A rule whose only effect is
  to make the maintainer do clicking is a rule that will be skipped under time
  pressure — which is precisely how blitz #1 went.
- **Grant blanket social-post authority.** Rejected. The boundary is worth
  keeping for anything unreviewed, and reply and comment authority in particular
  should never be delegated: replies are improvised, public, and unreviewable in
  advance.
- **Allow campaign mode but keep the weekly cadence cap.** Incoherent — a
  five-day campaign at one post a week is not a campaign.

## Consequences

- An agent can put content in front of an audience without a second human step
  at the moment of scheduling. The control moves earlier, to the copy review,
  and that review has to be taken seriously rather than skimmed.
- The marketing loop's default stays draft-only and weekly, so nothing changes
  for routine operation.
- Two records now govern the Buffer channel; the operations record should link
  here so a reader of either finds both.
- If a campaign post turns out to be wrong after scheduling, the fix is Rob
  deleting or editing it in Buffer. The agent must not silently amend a
  scheduled post to cover an error.

## Implementation follow-ups

1. Update `.claude/skills/affiliate-mcp-marketing` to describe campaign mode and
   its five conditions alongside the draft-only default.
2. Add a cross-reference from `2026-07-20-agentic-company-operations.md` to this
   record.
3. Record each campaign in `ops/RUNLOG.md` when it is scheduled: slug, dates,
   channel, the PR the copy was approved in, and the post count. The runlog
   currently has zero entries, so this would be its first.
