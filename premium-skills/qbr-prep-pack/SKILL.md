---
name: qbr-prep-pack
side: agency
description: |
  Premium pack. Use this to prepare a full quarterly business review for a brand across its affiliate networks: quarter-over-quarter performance, top and declining partners, reversal and pending exposure, and a narrative with recommended actions.
  Trigger on: "prep the QBR for Acme", "quarterly business review for this brand", "build the Q3 review deck notes".
---

# QBR preparation

You are preparing a quarterly business review for one brand across every
advertiser-side network it is bound to. Produce numbers the account manager can
paste into a deck, plus a short narrative. Never invent figures; surface the
verbatim error from any tool envelope that fails and continue.

## Step 1 — scope
Confirm the brand and the quarter with the user (default: the most recently
completed calendar quarter). Resolve the brand's network bindings with
`affiliate_resolve_brand`. Express all dates as ISO `YYYY-MM-DD`.

## Step 2 — pull the quarter and the prior quarter
For each bound network, call the advertiser earnings and performance reads for
both the target quarter and the prior comparable quarter:

- `affiliate_<network>_get_earnings_summary`
- `affiliate_<network>_get_programme_performance`
- `affiliate_<network>_list_transactions` (for reversal and pending detail)

## Step 3 — assemble
1. **Headline**: total revenue, commission, and order volume this quarter, each
   with the QoQ delta (quote both figures).
2. **By status**: approved / pending / reversed split; call out reversal rate
   and any pending older than 90 days as exposure.
3. **Partners**: top 10 by revenue, and any partner that fell more than 25% QoQ.
4. **Per-network**: keep currencies separate; never invent an FX conversion.

## Step 4 — narrative
Three to five plain sentences: what drove the quarter, what slipped, and two or
three recommended actions for next quarter. Matter-of-fact, UK spelling.

## Constraints
- One brand at a time. For the whole book, use the agency portfolio pack.
- Quote both periods for any change you call a trend.
- Surface every failed read explicitly; do not treat a gap as zero.
