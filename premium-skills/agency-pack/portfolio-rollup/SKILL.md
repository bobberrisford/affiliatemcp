---
name: portfolio-rollup
description: |
  Use this skill when an agency operator wants more than this week's headline across the book: a multi-period trend per client, each client benchmarked against the book's own average, and which single publisher shows up across multiple clients so a concentration risk in one partner is visible book-wide. This is the premium extension of the free `agency-portfolio-rollup` skill, not a replacement for it.
  Trigger on: "How has the whole book trended over the last few months?", "Which clients are underperforming the book average?", "Is any one publisher overexposed across our clients?", "Give me a benchmarked view of the book, not just this week".
---

# Premium scope note

The free `agency-portfolio-rollup` skill already produces the book's
single-period headline: current vs. comparison window, per-brand deltas, a
needs-attention subsection, and portfolio totals. Run that skill first for
the standard weekly view; this premium skill does not repeat it.

This premium skill adds three things the free rollup does not do:

1. **Multi-period trend per client** (typically the last six months, by
   calendar month), so a client's direction of travel is visible beyond one
   week-over-week delta.
2. **Peer benchmarking**: each client's current-period growth rate compared
   against the book's own average and median growth rate, so "down 5%" reads
   differently against a book average of "+10%" than against "-8%".
3. **Cross-client partner concentration**: which named publishers appear
   across more than one client's roster, and what share of the book's total
   commission a single publisher represents when summed across every client
   it touches. The free rollup only looks at revenue per brand; it never
   looks across brands at the partner level.

## Assumptions and requirements

- At least one brand is registered via `affiliate_resolve_brand`. If none
  are, stop and point the user at `affiliate-networks-mcp setup`.
- Credentials for bound networks are configured; recommend
  `affiliate-networks-mcp doctor <slug>` when credential state is uncertain.
- Cross-client partner concentration requires `listMediaPartners` support on
  the bound advertiser adapters. Report the gap for any binding that does
  not support it rather than omitting that client from the analysis
  silently.
- Publisher identity across networks is matched on `MediaPartner.name` (the
  canonical fields carry no cross-network partner id). Treat name matches as
  a strong hint, not a certainty: state this limitation in the output.

## Step 1 — enumerate the book

Call `affiliate_resolve_brand` with no arguments. Group by `brand`. If empty,
stop and point the user at setup.

## Step 2 — pull each client's monthly trend

For each brand, call the bound networks' performance tool once per of the
last six complete calendar months. Tool names follow
`affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from: <month-start>, to: <month-end> })`
- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from: <month-start>, to: <month-end> })`

Sum `grossSale` per brand per month per currency. If a binding's history does
not reach back that far, or a call fails, say so for that month rather than
treating it as zero.

## Step 3 — compute growth rates and the book average

For each brand, compute month-over-month growth for the most recent complete
month against the prior one, per currency. Compute the book's own average and
median growth rate across every brand that has a valid comparison (same
currency cohort; do not average across currencies). For each brand, state
its growth rate against the book average/median: "ahead of the book average"
/ "roughly in line" / "behind the book average", with both numbers shown.

A brand recently onboarded with fewer than two comparable months is excluded
from the benchmark and noted as "too new to benchmark" rather than given a
misleading comparison.

## Step 4 — cross-client partner concentration

For each brand's advertiser bindings that support it, call
`affiliate_<network>_list_media_partners({ brand })`, for example
`affiliate_impact-advertiser_list_media_partners({ brand })` or
`affiliate_awin-advertiser_list_media_partners({ brand })`. Build a map of
partner name to the list of clients whose roster includes it. For a partner
name appearing in more than one client's roster, cross-reference the
per-publisher commission from Step 2's underlying rows (or a fresh
`publisherId`-scoped `get_programme_performance` call if the roster call
alone does not carry commission) to compute that partner's combined share of
the book's total commission across every client it touches.

Report the top three to five cross-client partners by combined share, each
with: the clients it appears in, its combined commission, and its share of
book-wide commission. Flag any partner above roughly 15% of book-wide
commission as a concentration risk, since a problem at that partner (a
tracking failure, a policy change, a de-listing) would affect multiple
clients at once, not just one.

For any binding that does not support `listMediaPartners`, list the client
under "excluded from partner-concentration analysis: <reason>" rather than
silently leaving it out with no explanation.

## Step 5 — present the report

Output in this order:

1. **Coverage**: brands included, brands too new to benchmark, brands
   excluded from partner-concentration analysis and why, and any failed
   calls (verbatim).
2. **Monthly trend per client**: compact table, one row per brand, one
   column per month, `grossSale` per currency.
3. **Peer benchmark**: one row per brand: this month's growth rate, book
   average, book median, and the plain-language comparison.
4. **Cross-client partner concentration**: the top partners by combined
   share, per Step 4, with the concentration flag where applicable.
5. **What this adds to the weekly rollup**: one line pointing back at the
   free `agency-portfolio-rollup` for the current week's headline and
   needs-attention list, so the two reports are read together, not as
   duplicates.

Matter-of-fact tone, UK spelling. Keep tables compact.

## Constraints

- Never invent figures, months, or partner names. A gap in history or a
  failed call is stated, not backfilled.
- Currency: never blend currencies in a trend or benchmark; compute growth
  rates and averages within a currency cohort only.
- Partner name matching across networks is best-effort; always disclose it
  as such rather than presenting cross-client identity as confirmed.
- This is a read-only analytical report. It does not authorise, recommend
  dropping, or contact any partner; any action based on the concentration
  flag happens outside this skill.
- Pair with the free `agency-portfolio-rollup` for the current week's
  headline and with `publisher-performance-review` when the user wants to
  drill into one concentrated partner.
