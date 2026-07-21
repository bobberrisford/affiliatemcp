---
name: programme-leakage-audit
description: |
  Use this skill when a brand or agency operator wants a "money the programme is leaking" audit: reversal concentration by reason, including the share with no stated reason, plus the stale validation queue, per brand binding — with an agency mode that sweeps the whole client book. It reads advertiser transactions directly so reversal reasons and ages are visible.
  Trigger on: "audit Acme's programme for leakage", "run a leakage audit", "where is our programme leaking money?", "how big is our validation backlog?", "sweep the whole book for reversal problems".
---

# Operating instructions

You are auditing one brand's programme — or, in agency mode, every brand in
the book — for commission leakage the network's own records show: reversals
concentrated on reasons the brand cannot explain, and a validation queue old
enough to be a publisher-trust liability. The audit surfaces the problem; it
does not change any transaction. The advertiser side is read-only —
approving, re-opening, or disputing a reversal happens in the network
dashboard. Say so if the user expects an action.

This is a PARTIAL capability: it is useful only for bindings whose advertiser
adapter supports `listTransactions`, and reversal-reason coverage varies by
network.

Data path: this skill calls the advertiser adapter's transaction list
directly (for example `affiliate_awin-advertiser_list_transactions`) and does
**not** use `affiliate_build_brand_snapshot` or the brand-data query views,
because those rows do not carry `reversalReason`, `dateApproved`, or
`datePaid`, and the persisted store only covers a rolling 30-day window.

## Step 1 — resolve scope

Single-brand mode: if the user named a brand, call `affiliate_resolve_brand`
(pass `{ network: "<slug>" }` if they also named a network) and reduce the
result to the bindings whose `brand` matches. If none remain, tell the user
the brand is not registered, suggest `affiliate_resolve_brand` with no args
to see what is, and stop.

Agency mode: if the user asked for the whole book, call
`affiliate_resolve_brand` with no arguments and audit every binding, grouped
by brand.

Either way, call `affiliate_list_networks` once and retain the metadata for
the in-scope bindings. Check whether each advertiser adapter supports
`listTransactions`. Report unsupported bindings as coverage gaps; never call
them, and never interpret them as zero leakage.

## Step 2 — pick the windows

Reversal window: the last 30 complete days, ending yesterday, unless the user
named a period. State all dates as ISO `YYYY-MM-DD` at the top.

Validation-queue window: a queue is dominated by old rows, so default to
pulling pending transactions over the last 180 days and say so. Honour an
explicit user window for either pull.

## Step 3 — reversal concentration per binding

For each supported `(brand, network)` binding:

```
affiliate_<network>_list_transactions({ brand, from, to, status: "reversed" })
```

For example: `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-06-20", to: "2026-07-19", status: "reversed" })`.
If a network does not accept a `status` filter, pull the window once and
filter to reversed rows client-side; the finding is defined on row fields,
not request parameters.

Group the reversed rows by `reversalReason`. Rows with no reason form the
**"unspecified"** bucket. For each reason: count, commission at stake per
currency, and share of all reversals. Call out the unspecified share
explicitly — a large unspecified share is itself a finding: commission is
being clawed back without the records saying why.

Compute a reversal *rate* only from a confirmed-complete denominator for the
same window (a full unfiltered pull); otherwise report absolute figures and
label the rate unavailable — the same rule as `programme-reversal-report`.
For the full by-publisher decline investigation, hand off to
`programme-reversal-report` rather than duplicating it here.

## Step 4 — stale validation queue per binding

```
affiliate_<network>_list_transactions({ brand, from, to, status: "pending" })
```

Client-side filter fallback as above. Bucket the pending rows by `ageDays`:
0–30, 31–60, 61–90, 90+. For each bucket: count and commission per currency,
plus the oldest pending age overall. Frame the queue as publisher-trust
liability: this is money partners are waiting on, sitting in the brand's
validation queue — the same numbers a publisher-side audit would hold against
the programme.

## Step 5 — report

Output in this order:

1. **Windows**: reversal window and validation-queue window, ISO dates.
2. **Coverage**: bindings included, unsupported bindings, failed calls with
   the verbatim error, and whether each rate uses a confirmed-complete set.
   In agency mode, a per-brand coverage line — never silently under-count a
   brand.
3. **Per-brand findings**: the reason table (with the unspecified share
   called out), then the pending age-distribution table. Per currency
   throughout; a binding spanning multiple currencies reports each
   separately.
4. **Agency mode only — needs attention**: the brands with the largest
   unspecified-reversal commission and the largest 90+ pending bucket, per
   currency. Never a cross-currency total.
5. **What to raise**: plain next steps the data supports — read-only, things
   to take up with the network or the partner, for example "ask the network
   why 41% of reversed commission carries no reason" or "clear the 90+
   validation bucket before partners start chasing".
6. **Failures (if any)**: per-binding verbatim error from the envelope.

Matter-of-fact tone, UK spelling. Reversals and validation queues are normal;
report the shape, don't alarm.

## Excluded scope (v1)

Duplicate-order detection and voucher-code attribution checks are out of
scope: the canonical transaction shape carries no order reference or voucher
code, so a cross-network check would have to guess from per-network raw
payloads. If the user asks for them, say they are not supported yet rather
than approximating with transaction-id heuristics.

## Constraints

- Read-only, advertiser side. Approving, disputing, or re-opening happens in
  the network dashboard.
- Never invent figures or reasons. No reason means "unspecified". Never infer
  fraud, tracking failure, duplicate firing, or genuine returns from a reason
  label alone.
- Per-currency only. Per-brand and book-level figures stay per currency;
  never normalise or convert.
- A rate needs a confirmed-complete denominator. Otherwise report absolute
  figures and say the rate is unavailable.
- Quote the verbatim upstream error on any failed call. A failed binding is
  never zero leakage.
- State the windows and the age-bucket boundaries used.
- Compose, don't duplicate: `programme-reversal-report` for the by-publisher
  decline deep dive, `programme-performance-report` for overall performance,
  `agency-portfolio-rollup` for revenue headlines.
- If the operator wants a shareable recap card, hand the per-currency
  findings to the `affiliate-mcp-design` card kit; figures must be real
  anonymised data or explicitly a sample.
