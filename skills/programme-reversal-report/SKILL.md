---
name: programme-reversal-report
description: |
  Use this skill when an agency operator wants to understand why a brand's commissions are being declined: the reversed transactions over a period, grouped by reason and by publisher, with the value at stake and how the reversal rate is trending.
  Trigger on: "Why are Acme's commissions being declined?", "Acme's reversals this month", "What's getting rejected on [brand]?", "Show me the decline report for [brand]".
---

# Operating instructions

You are producing a reversal and decline report for one brand: which conversions
were reversed, why, and which publishers they came from, so the account manager
can see where commission is leaking and take it up with the network or the
partner. This report surfaces the problem; it does not change any transaction.
The advertiser side is read-only — approving, re-opening, or disputing a reversal
happens in the network dashboard, not here. Say so if the user expects an action.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — pick the window

Default period: the last 30 days, ending today. Honour explicit windows ("this month", "Q1", named dates). Optionally compute a same-length prior window so you can show whether the reversal rate is rising. Express all dates as ISO `YYYY-MM-DD` and state them at the top.

## Step 3 — fetch transactions per binding

For each `(brand, network)` binding, list the reversed transactions. Tool names follow `affiliate_<network>_list_transactions`:

- Awin advertiser: `affiliate_awin-advertiser_list_transactions({ brand, from, to, status: "reversed" })`

To compute the reversal rate (reversed value as a share of the total), also pull the full set for the window (`affiliate_awin-advertiser_list_transactions({ brand, from, to })`) or reuse an approved/pending pull if you already have one. If a network does not accept a `status` filter, pull the window once and filter to reversed rows client-side.

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. Each transaction carries `id`, `status`, `amount`, `commission`, `dateClicked`, `dateConverted`, `ageDays`, the publisher, and a reversal reason field where the network provides one.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap at the top.

## Step 4 — write the report

Output in this order:

1. **Window**: current `from YYYY-MM-DD to YYYY-MM-DD`, and the comparison window if you pulled one.
2. **Headline**: count and total commission of reversed transactions, and the reversal rate (reversed commission ÷ total commission) for the window. If you pulled a comparison window, show the rate then and now. Per-currency lines where the brand spans currencies; never invent an FX rate.
3. **By reason**: group reversed transactions by the network's reversal reason. For each reason: count, total commission at stake, and share of all reversals. Where the network gives no reason, label it "unspecified" rather than guessing.
4. **By publisher**: the publishers with the most reversed commission. For each: count, commission at stake, and — if you have it — that publisher's reversal rate, so a partner with a structurally high decline rate stands out from one with a single large reversal.
5. **Notable cases**: the few largest individual reversals by commission (id, publisher, amount, reason, age), since one big reversal can dominate the total.
6. **What to do**: plain next steps the data supports — e.g. "query the 'duplicate order' cluster with the network", "ask [publisher] about the rise in 'returned goods'". Read-only: these are things to raise, not actions this skill performs.
7. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling. Reversals are normal; report the shape, don't alarm.

## Constraints

- Never invent figures or reasons. Where the network gives no reversal reason, say "unspecified".
- This skill is read-only. It cannot approve, dispute, or re-open a transaction; direct the user to the network dashboard for that.
- Currency: respect the per-row `currency`. If a binding spans multiple currencies, output each separately. Don't normalise across networks.
- A reversal rate needs the total, not just the reversed set. If you could not pull the total, report the reversed figures and say the rate is not available.
- For the full per-publisher performance picture (not just declines) use `programme-performance-report`.
