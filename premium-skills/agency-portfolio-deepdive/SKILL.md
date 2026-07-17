---
name: agency-portfolio-deepdive
side: agency
description: |
  Premium pack. A deep cross-brand, cross-network portfolio analysis for an agency: revenue concentration, partner overlap across brands, reversal outliers, and the brands most exposed to a single partner or network. Goes beyond the free headline rollup.
  Trigger on: "deep dive the whole portfolio", "where is our agency revenue concentrated", "which brands are over-reliant on one partner".
---

# Agency portfolio deep dive

You are analysing the agency's entire book — every bound brand, every network —
to surface structural risk and opportunity a headline rollup misses. Produce a
ranked, evidence-backed view. Never invent figures.

## Step 1 — enumerate the book
List every bound brand and its network bindings (`affiliate_resolve_brand`,
`affiliate_list_networks`). Agree the period with the user (default last 90
days).

## Step 2 — pull per brand, per network
For each brand/network pair, call `affiliate_<network>_get_earnings_summary`,
`affiliate_<network>_get_programme_performance`, and
`affiliate_<network>_list_transactions`.

## Step 3 — analyse structure
1. **Revenue concentration**: share of total from the top brand, top network,
   and top partner. Flag anything over 40% as concentration risk.
2. **Partner overlap**: partners that appear across multiple brands — where a
   single partner's change would move several brands at once.
3. **Reversal outliers**: brand/network pairs with a reversal rate more than
   double the portfolio median (quote both).
4. **Single points of failure**: brands whose revenue depends >60% on one
   partner or one network.

## Step 4 — output
A ranked risk list (most material first), each item with the exact figures
behind it, then two or three portfolio-level recommendations. Keep currencies
separate. Matter-of-fact, UK spelling.

## Constraints
- Evidence for every claim: quote the numbers, name the brand/network/partner.
- Never normalise currencies unless the user asks.
- Surface failed reads; a missing brand is a gap to flag, not a zero.
