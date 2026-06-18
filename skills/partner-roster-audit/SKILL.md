---
name: partner-roster-audit
description: |
  Use this skill when an agency operator wants the partner roster for a brand split by relationship status, plus the active partners who have gone quiet so they can be chased or reactivated. The output is a read-only worklist; the outreach itself happens outside this skill.
  Trigger on: "Who's gone quiet on Acme?", "Acme's partner roster health", "Which partners have gone dormant on [brand]?", "Build a reactivation list for Acme", "Show me Acme's roster by status".
---

# Operating instructions

You are auditing one brand's partner roster: the full relationship list split by
status, and the dormant partners (active relationship, little or no recent
activity) that are worth reactivating. This is distinct from
`programme-performance-report` (which ranks the partners who *are* producing) and
from `publisher-performance-review` (one named partner). Here the outcome is a
roster-level worklist of who to look at, not a performance ranking.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — read each network's capabilities

Call `affiliate_list_networks` once and retain the metadata for the brand's
bindings. Use each network's supported operations and `knownLimitations` to
decide two things:

- whether the network exposes `list_media_partners` at all (without it there is
  no roster to audit on that binding — report the gap and continue);
- whether partner `status` is genuinely reported or inferred, and whether
  clicks or other activity metrics are normalised to zero when unavailable. Do
  not read a normalised zero as observed inactivity.

## Step 3 — pull the roster per binding

For each `(brand, network)` binding, call the roster tool. Tool names follow
`affiliate_<network>_list_media_partners`:

- Awin advertiser: `affiliate_awin-advertiser_list_media_partners({ brand })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. Each call
returns `MediaPartner[]` with `id`, `name`, and `status` (`active` / `pending` /
`inactive` / `unknown`). Keep the per-network roster separate; partner ids are
network-specific and the same partner may appear on more than one binding under
different ids.

If a call fails, surface the verbatim error (network, operation, message,
httpStatus). Do not treat a failure as an empty roster. Continue with the
remaining bindings and flag the gap at the top.

## Step 4 — find the dormant partners

For each binding, call the performance tool over a recent activity window to see
who has actually transacted. Default window: the last 90 days, ending today;
honour an explicit window.

- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to })`

Each call returns `ProgrammePerformanceRow[]` with `publisherId`, `clicks`,
`conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up by
`publisherId`. A partner is **dormant** when its relationship `status` is
`active` but it has no conversions (and, where clicks are genuinely reported, no
clicks) in the window. Where the network's limitations say clicks are
unavailable, base dormancy on conversions alone and say so.

If `get_programme_performance` is unsupported on a binding, you can still report
the roster split for that binding; say plainly that dormancy cannot be computed
there because no activity data is available.

## Step 5 — present the audit

Output in this order, per network binding:

1. **Brand, network, and window**: the activity window as `from YYYY-MM-DD to YYYY-MM-DD` (with day count).
2. **Roster split**: a count by status (`active` / `pending` / `inactive` / `unknown`). If status is inferred or unsupported on this network, label it as such rather than presenting it as confirmed.
3. **Dormant worklist**: active partners with no recent activity, listed by name with their last observed activity if the data shows it (otherwise "no activity in window"). This is the reactivation candidate list.
4. **Pending and inactive notes**: a short line on partners awaiting a decision (point the user at `partner-application-queue` for the full queue) and partners already marked inactive.
5. **Failures and gaps (if any)**: per-network verbatim error, and any binding where the roster or activity data was unavailable.

End with a one-line pointer: the dormant list is a worklist, not an action. To
draft re-engagement messages from it, use the `partner-outreach` skill; the
approve/decline of applications and any sending happens in the network dashboard.

Matter-of-fact tone, UK spelling, no hype. Keep tables compact.

## Constraints

- Read-only. This skill produces a worklist; it never approves, declines, or
  contacts a partner. Do not imply a write is available.
- Never invent figures or roster entries. A missing roster is "unavailable on
  this network", not an empty list presented as fact.
- Do not read a normalised-zero click or conversion count as observed inactivity
  when the network's `knownLimitations` say the metric is unavailable; base
  dormancy on what is genuinely reported and say which signal you used.
- Partner status coverage varies by adapter. Report inferred or unsupported
  status as such; never upgrade an unknown status to `active` to pad the roster.
- Currency: respect the per-row `currency`; never normalise across networks or
  invent an FX rate.
- Keep each network's roster separate; do not merge partner ids across networks.
