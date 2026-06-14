---
name: programme-weekly-report
description: |
  Use this skill when an agency operator wants the weekly client-facing update for one brand: last completed week against the week before, headline numbers, top movers, and a short note they can paste into an email. Designed to run on a schedule every Monday.
  Trigger on: "Acme's weekly report", "How did Acme do this week?", "Send me the weekly update for [brand]", "Weekly affiliate report for [brand]".
---

# Operating instructions

You are producing a concise, client-ready weekly update for one brand across the
networks it is bound to. This is the recurring Monday-morning artefact an account
manager sends to a client, not a deep internal audit. Keep it short: a one-line
narrative, a small headline table, and the top movers. If the user wants the full
per-publisher breakdown and status split, point them at the
`programme-performance-report` skill instead.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — pick the week

Default period: the **most recent complete week**, Monday to Sunday, ending before today. Do not include the current partial week unless the user explicitly asks for "this week so far".

Compute the prior complete week (the seven days immediately before) as the comparison window. Express all dates as ISO `YYYY-MM-DD`. State both week ranges at the top so the client can confirm.

When this skill runs on a schedule, the default already does the right thing: each Monday it reports the week that just ended against the week before.

## Step 3 — fetch per-publisher performance per binding

For each `(brand, network)` binding from step 1, call the network's performance tool twice — the reported week and the prior week. Tool names follow `affiliate_<network>_get_programme_performance`:

- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. The chassis resolves it to the right `networkBrandId` before the call goes out.

Each call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up rows by `publisherId` for the movers; sum across publishers for the headline.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap at the top of the report.

## Step 4 — write the update

Keep it tight enough to paste into an email. Output in this order:

1. **Week**: reported `Mon YYYY-MM-DD to Sun YYYY-MM-DD` vs prior `Mon YYYY-MM-DD to Sun YYYY-MM-DD`.
2. **One-line summary**: plain-language verdict, e.g. "Revenue up 12% week-on-week, driven by two cashback partners; clicks flat." Lead with the direction of travel.
3. **Headline table** per network: `grossSale`, `commission`, `conversions`, `clicks`, each with the prior-week figure and the delta in absolute currency and percent. If a binding produced rows in more than one currency, list each currency on its own line — never invent an FX rate.
4. **Top movers**: the three partners that gained the most and the three that fell the most by `grossSale` week-on-week. Name, this week, last week, delta. Skip this section if there are fewer than four active partners.
5. **Watch items (only if present)**: anything worth a heads-up — a partner that went from material revenue to zero, a week that is >50% reversed, a programme with zero clicks all week.
6. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling, no hype. A flat week is a flat week; say so.

## Constraints

- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Report the most recent **complete** week by default; do not mix in the current partial week unless asked.
- Currency: respect the per-row `currency`. If a single binding spans multiple currencies, output each currency separately. Don't normalise across networks.
- This is a summary, not an audit. For the full per-publisher rollup and status split, defer to `programme-performance-report`; for the whole book at once, defer to `agency-portfolio-rollup`.
- If the user asks who else could be promoting them, `affiliate_awin-advertiser_list_media_partners({ brand })` includes inactive partners that won't appear in the performance rollup.
