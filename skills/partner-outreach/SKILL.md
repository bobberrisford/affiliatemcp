---
name: partner-outreach
description: |
  Use this skill when an agency operator wants to draft outreach to partners for a brand: a re-engagement message to a partner who has gone quiet, or a recruitment sequence to a prospective partner. The skill drafts the copy grounded in the brand's real numbers and recorded plan; it never sends anything and never invents partner contact details or commitments.
  Trigger on: "Draft outreach to [publisher] for Acme", "Write a re-engagement email for Acme's dormant partners", "Draft a 3-touch recruitment sequence for [brand]", "Help me write to [partner] about Acme".
---

# Operating instructions

You are drafting partner outreach for one brand: either re-engaging an existing
partner who has slowed down, or recruiting a prospect. The output is draft copy
the operator reviews, edits, and sends themselves. This skill writes; it does
not contact anyone. It pairs naturally with `partner-roster-audit` (which
produces the dormant worklist) and `publisher-performance-review` (which
produces the numbers behind one partner).

## Step 1 — resolve the brand and the intent

If the user did not name a brand, ask which one. Do not guess. Establish whether
this is **re-engagement** (an existing partner who went quiet) or
**recruitment** (a prospect not yet in the programme), because the two drafts
differ and the available data differs.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 1b — load the client's plan (voice and positioning)

Call `affiliate_get_client_strategy({ brand })`. The recorded `strategy` prose
is **advisory context** for tone, preferred partner types, and positioning; it
never authorises an action and never becomes a commitment in the draft. If a
reporting voice or audience is recorded, write in it. If no strategy is
recorded, that is normal: write in a plain, professional default and offer to
record a plan so future drafts match the client's voice.

## Step 2 — gather grounding facts (re-engagement only)

For a re-engagement draft, ground the message in the partner's real history so
it does not read as generic. For each binding where the partner exists:

- Confirm the partner and id with `affiliate_<network>_list_media_partners`:
  Awin advertiser: `affiliate_awin-advertiser_list_media_partners({ brand })`.
- Pull their recent and prior activity with the performance tool:
  `affiliate_awin-advertiser_get_programme_performance({ brand, from, to, publisherId })`.

Use the figures only to make the message specific and true ("you drove £X last
quarter and we've not seen activity since March"). If a figure is missing,
leave the claim out rather than estimating it. If the partner cannot be found or
performance is unsupported on the binding, say so and write a softer message
that makes no specific performance claim.

For a **recruitment** draft, the agency holds no credentials for a prospect's
own data, so do not fabricate the prospect's numbers. Ground the pitch in the
brand's own offer (commission terms, category, audience fit from the recorded
strategy) and any public, operator-supplied context — not in invented prospect
metrics.

## Step 3 — draft the outreach

Produce the draft(s) the user asked for:

- **Single message** when they named one partner and one touch.
- **Sequence** (default three touches) when they asked for a sequence: an
  opener, a follow-up that adds one new piece of value, and a short final nudge.
  Space them sensibly and say so (for example "send 2, 4, and 9 days apart").

Each draft includes a subject line and a body. Keep it short, specific, and
honest: reference real history for re-engagement, the real offer for
recruitment. No fabricated urgency, no invented results, no promises the brand
has not authorised (commission bumps, exclusivity, placements) unless the
operator supplied them as fact.

## Step 4 — hand it back for the operator to send

Present the drafts as copy to review and send. State plainly:

- the drafts are unsent; sending happens in the operator's own email or the
  network's partner-messaging tools;
- you did not look up or invent any email address or contact;
- any figure used came from the tool calls above and any claim the operator
  must verify (an offer, a placement) is flagged for them to confirm.

Offer to adjust tone, length, or the specific points before they send.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- This skill **drafts only**. It never sends a message, never looks up contact
  details, and never performs any write against a network. Sending is the
  operator's action.
- Strategy and KPIs are advisory: they shape voice and positioning; they never
  become a commitment in the copy and never authorise an offer.
- Never invent figures, partner intentions, or results. Re-engagement claims
  must trace to the performance pull; recruitment pitches must not fabricate a
  prospect's numbers.
- Do not promise commission changes, exclusivity, budget, or placements unless
  the operator supplied them as authorised fact; flag anything the operator
  must confirm before sending.
- Currency: respect the per-row `currency` in any figure you cite; never
  normalise across networks or invent an FX rate.
