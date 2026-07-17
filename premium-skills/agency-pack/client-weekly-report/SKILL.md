---
name: client-weekly-report
description: |
  Use this skill when an agency operator wants the Monday weekly note produced for every client in the book in one pass, each in the client's own recorded voice and escalation thresholds, rather than one brand at a time. This is the premium batch extension of the free `programme-performance-report` skill's weekly-client-note output profile, not a replacement for it.
  Trigger on: "Give me this week's client notes for the whole book", "Run the Monday reports for every client", "Batch the weekly notes for all clients", "Send-ready weekly notes for the book".
---

# Premium scope note

The free `programme-performance-report` skill already produces the weekly
client note for **one named brand**: a short, pasteable verdict, a headline
table, and top risers/fallers. This premium skill does not change that
profile's content or its rules; it adds two things:

1. **Batching**: run the weekly-client-note profile for every registered
   brand in the book in one pass, instead of the operator asking brand by
   brand.
2. **Voice-matched, send-ready formatting**: apply each brand's recorded
   strategy voice, audience, and escalation threshold (from
   `affiliate_get_client_strategy`) to its own note, and format every note
   as a ready-to-paste email draft with a consistent subject-line
   convention, so a Monday morning produces N send-ready drafts rather than
   N separate conversations.

It is not a headline-only rollup (that is the free `agency-portfolio-rollup`
skill, or this pack's `portfolio-rollup`); it produces the actual
per-client narrative text.

## Assumptions and requirements

- At least one brand is registered via `affiliate_resolve_brand`. If none
  are, stop and point the user at `affiliate-networks-mcp setup`.
- Credentials for bound networks are configured; recommend
  `affiliate-networks-mcp doctor <slug>` when credential state is uncertain.
- Client strategy files are optional per brand. A brand with no recorded
  strategy still gets a note, in a neutral default voice, with no escalation
  threshold applied.
- This produces email-ready drafts, never sends them. Sending is a separate
  action outside any tool this skill uses.

## Step 1 — enumerate the book

Call `affiliate_resolve_brand` with no arguments. The response is an array of
`{ brand, network, networkBrandId }`. Group by `brand` to get the book's
distinct client list. If empty, tell the user no brands are registered and
stop.

## Step 2 — load each brand's plan

Call `affiliate_list_client_strategies` once. For each brand with
`hasStrategy` or `hasKpi`, call
`affiliate_get_client_strategy({ brand })` to load its `strategy` prose (for
voice, audience, and escalation threshold) and `kpi.targets` (for the
verdict). Brands with neither are noted as "no recorded voice; using the
default weekly-note format" and proceed without a custom voice.

## Step 3 — pull each brand's week

For each brand, run the free weekly-client-note logic exactly as
`programme-performance-report` specifies it: prefer
`affiliate_build_brand_snapshot({ brand })` for the standard `last7d` window,
falling back to per-network
`affiliate_<network>_get_programme_performance({ brand, from, to })` calls
for a custom window or per-publisher detail. For example:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })`

If a brand's binding fails, capture the verbatim error and still produce
notes for the remaining brands. Never let one brand's failure block the rest
of the batch.

## Step 4 — write one note per brand

For each brand, produce exactly the weekly-client-note shape the free skill
defines: a one-line plain-language verdict leading with direction of travel,
a small headline table per network, and the top three risers and top three
fallers by gross sale week-on-week. Apply that brand's recorded voice and
audience from Step 2 if present; otherwise use a neutral, matter-of-fact
default. Surface anything crossing a recorded escalation threshold at the
top of that brand's note, in bold or its own line, whatever the format.

Format each as a ready-to-paste email draft:

1. **Subject** — `Weekly update — <Brand> — week of <Monday date>`.
2. **Body** — the note content from above.

Never invent contact details or a recipient; leave `[client contact]` as a
placeholder unless the user supplies one.

## Step 5 — present the batch

Above the drafts, give a short ledger: brands processed, brands with a
recorded voice applied, brands using the default format, brands that
crossed their escalation threshold this week, and brands that failed
(verbatim error). Then present the drafts, one per brand, in book order or
sorted by whichever brand needs the most attention first (a breached
threshold or the largest negative delta).

## Large accounts

Follow the free skill's large-account guidance: prefer
`affiliate_build_brand_snapshot` and `affiliate_query_brand_data` over raw
row pulls, and respect any `truncated: true` or `result_too_large` result by
following its hint rather than treating a partial pull as complete.

## Constraints

- Never invent figures, a brand's voice, or an escalation threshold. Read
  each from `affiliate_get_client_strategy`'s output only.
- Currency: respect each network's currency per brand; never blend currencies
  or invent an FX rate across the batch.
- This is a batch of drafts. Sending any of them is the user's action; this
  skill never sends.
- If a brand's KPI file has `parseErrors`, report each verbatim in that
  brand's note and exclude the malformed line from its verdict, exactly as
  the free skill requires.
- Pair with `client-onboarding` to record a voice/threshold for a brand
  currently defaulting.
