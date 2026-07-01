---
name: vertical-benchmark-pack
side: agency
description: |
  Premium pack. Benchmark one brand's affiliate programme against the other brands you manage in the same vertical: commission competitiveness, partner mix, reversal rate, and AOV, with a gap list the account manager can act on.
  Trigger on: "benchmark Acme against its vertical", "how does this brand compare to peers we manage", "is our commission competitive for this category".
---

# Vertical benchmark

You are benchmarking one target brand against the other brands the agency
manages in the same vertical. Only compare brands the user confirms share a
vertical — never assume a category. Never invent figures.

## Step 1 — define the peer set
Ask the user for the target brand and which of the managed brands count as its
vertical peers. Resolve bindings with `affiliate_resolve_brand`. Agree the
period (default last 90 days).

## Step 2 — pull comparable metrics
For the target and each peer, across their networks, call
`affiliate_<network>_get_programme_performance`,
`affiliate_<network>_get_earnings_summary`, and
`affiliate_<network>_list_transactions`.

## Step 3 — compare like for like
Build a table with one row per brand:
- commission rate / effective commission where available;
- reversal rate;
- average order value;
- partner count and top-partner concentration.

Mark the target's position (above / at / below the peer median) on each metric,
quoting the target figure and the peer median.

## Step 4 — gap list
List where the target trails its peers, most material first, each with the two
figures behind it, and a suggested action (e.g. review commission, recruit in an
under-covered partner type). Matter-of-fact, UK spelling.

## Constraints
- Peers are user-confirmed, same vertical, same agency book only.
- Keep currencies separate; do not invent FX.
- Quote both the target and the peer benchmark for every gap.
- Surface failed reads; never fill a gap with a zero.
