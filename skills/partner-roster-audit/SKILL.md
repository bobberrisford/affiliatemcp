---
name: partner-roster-audit
description: |
  Use this skill when an agency operator wants the partner roster for a brand split by relationship status, plus the active partners who have gone quiet so they can be chased or reactivated. The output is a read-only worklist; the outreach itself happens outside this skill. How a partner's relationship status is read depends on the network. Some advertiser networks report it through the API. Awin does not: its advertiser API returns only already-joined publishers with no relationship-status field, so every Awin row maps to unknown and neither the roster split nor the dormant worklist can be derived from the API. Awin's roster and per-partner relationship status are read from the operator's own authenticated Awin session (new UI, app.awin.com) through Claude-in-Chrome, read-only. Awin Classic (ui.awin.com) accounts have no equivalent and are detected and stopped.
  Trigger on: "Who's gone quiet on Acme?", "Acme's partner roster health", "Which partners have gone dormant on [brand]?", "Build a reactivation list for Acme", "Show me Acme's roster by status".
---

# Operating instructions

You are auditing one brand's partner roster: the full relationship list split by
status, and the dormant partners (active relationship, little or no recent
activity) that are worth reactivating. This is distinct from
`programme-performance-report` (which ranks the partners who *are* producing) and
from `publisher-performance-review` (one named partner). Here the outcome is a
roster-level worklist of who to look at, not a performance ranking.

This skill is read-only. It produces a worklist; it never approves, declines, or
contacts a partner. To draft re-engagement messages from the dormant list, use
`partner-outreach`. For the pending slice of the roster (applications awaiting a
decision), use `partner-application-queue`; to work through Awin's pending
publishers under a single human confirmation, use
`awin-application-auto-approval`.

How relationship status is read depends on the network:

- **Most advertiser networks** that support `list_media_partners` report a
  relationship status the adapter can map to `active` / `pending` / `inactive`,
  so the roster split is read through the API.
- **Awin advertiser** does not. Its advertiser API endpoint
  (`GET /advertisers/{id}/publishers/`, behind
  `affiliate_awin-advertiser_list_media_partners`) returns only publishers that
  have already joined the programme and carries no relationship-status field.
  The adapter's status mapping therefore returns `unknown` for every row, so the
  API roster split is entirely `unknown` and dormancy (which keys on an `active`
  relationship) never fires. Awin's roster and per-partner relationship status
  live only in the new Awin UI (the partnerships page), so they are read in the
  browser, read-only. Do not present the API roster as a status split for Awin.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — read each network's capabilities

Call `affiliate_run_diagnostic` for the brand's bound networks and retain the
operation matrix. Call `affiliate_list_networks` once and retain each binding's
metadata, including `knownLimitations` and any per-operation claim-status
overrides. Use the diagnostic operation support plus the metadata to decide,
per binding:

- **Awin advertiser**: treat the API as unable to report relationship status,
  for the reason above. The roster split and the set of active relationships are
  read in the browser in Step 3, not through `list_media_partners`. Do not roll
  up `affiliate_awin-advertiser_list_media_partners` by `status`: every row maps
  to `unknown`, so the split would be entirely `unknown` and the dormant
  worklist (which keys on an `active` relationship) would always be empty,
  misrepresenting an unreadable roster as a clean one.
- **Every other network**: whether the network supports `listMediaPartners` /
  `list_media_partners` at all (without it there is no roster to audit on that
  binding — report the gap and continue); whether the network supports
  `getProgrammePerformance` / `get_programme_performance` for dormancy (without
  it you can still show the roster split, but not the dormant worklist); whether
  partner `status` is genuinely reported or inferred, and whether clicks or
  other activity metrics are normalised to zero when unavailable (do not read a
  normalised zero as observed inactivity); and whether either relevant operation
  is `partial` or `experimental`, in which case surface that caveat in the
  gaps/coverage notes instead of presenting the worklist as fully proven.

## Step 3 — pull the roster per binding

Keep each binding's roster separate; partner ids are network-specific and the
same partner may appear on more than one binding under different ids. If a read
fails, surface the verbatim error (network, operation, message, httpStatus). Do
not treat a failure as an empty roster. Continue with the remaining bindings and
flag the gap at the top.

### 3a — Awin advertiser (browser, new UI only, read-only)

Take the brand's `networkBrandId` for `awin-advertiser` from the Step 1 result.
This is the Awin advertiser accountId (the advertiserId).

Navigate (Claude-in-Chrome) to
`https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`, using
`mcp__Claude_in_Chrome__navigate` with that advertiserId. Dismiss the "Welcome to
your new Awin" modal if it is present. Handle the cookie banner
privacy-preservingly: choose Reject or decline non-essential cookies, not Accept
all.

Then check the final URL. If it has redirected to `ui.awin.com` (Awin Classic),
STOP the Awin path and record for that binding: "this account is on Awin Classic;
its partner roster and relationship status are not readable here." Awin Classic
has no equivalent partnerships page. Do not attempt a Classic flow, and do not
fall back to the API roster, which carries no relationship status.

On the new UI, read the partnerships list using
`mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__get_page_text`, or
`mcp__Claude_in_Chrome__find`. For each partnership, capture what the page shows:
name, publisher id, and the relationship status the page presents (for example
active, pending, or paused/inactive). This is the Awin roster and the source of
the status split for that binding. Read only; do not click any approve, decline,
or other control on the page.

### 3b — other advertiser networks (API)

For each non-Awin `(brand, network)` binding, call the roster tool. Tool names
follow `affiliate_<network>_list_media_partners`. Pass `brand` exactly as it came
back from `affiliate_resolve_brand`. Each call returns `MediaPartner[]` with
`id`, `name`, and `status` (`active` / `pending` / `inactive` / `unknown`). Keep
the per-network roster separate.

## Step 4 — find the dormant partners

Dormancy needs two inputs per partner: that the relationship is **active**, and
that there has been no recent activity. The active-relationship set comes from
Step 3 — the API roster for non-Awin bindings, and the browser-read partnerships
page for Awin (the API status is `unknown` for every Awin row and cannot supply
it). The activity signal comes from the performance tool.

For each binding, call the performance tool over a recent activity window to see
who has actually transacted. Default window: the last 90 days, ending today;
honour an explicit window.

- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to })`

Each call returns `ProgrammePerformanceRow[]` with `publisherId`, `clicks`,
`conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up by
`publisherId`. A partner is **dormant** when its relationship is `active` (from
the Step 3 source for that binding) but it has no conversions (and, where clicks
are genuinely reported, no clicks) in the window. Where the network's
limitations say clicks are unavailable, base dormancy on conversions alone and
say so. For Awin, match the browser-read partners to performance rows by
publisher id.

If the active-relationship set could not be read (an Awin Classic account, or a
binding where the browser read failed), do not compute dormancy there: say
plainly the roster and dormant worklist are unavailable for that binding. If
`get_programme_performance` is unsupported on a binding whose roster you did
read, you can still report the roster split; say plainly that dormancy cannot be
computed there because no activity data is available.

## Step 5 — present the audit

Output in this order, per network binding:

1. **Brand, network, and window**: the activity window as `from YYYY-MM-DD to YYYY-MM-DD` (with day count), and how the roster was read (API, or browser read of the new Awin UI).
2. **Roster split**: a count by status (`active` / `pending` / `inactive` / `unknown`). If status is inferred or unsupported on this network, label it as such rather than presenting it as confirmed. For Awin, present the split from the browser-read partnerships page; never present the API roster (all `unknown`) as a status split.
3. **Dormant worklist**: active partners with no recent activity, listed by name with their last observed activity if the data shows it (otherwise "no activity in window"). This is the reactivation candidate list.
4. **Pending and inactive notes**: a short line on partners awaiting a decision (point the user at `partner-application-queue` for the full queue) and partners already marked inactive.
5. **Failures and gaps (if any)**: per-network verbatim error, and any binding where the roster or activity data was unavailable. This includes Awin Classic accounts, whose roster and relationship status are not readable, and any Awin binding where the browser read failed.

End with a one-line pointer: the dormant list is a worklist, not an action. To
draft re-engagement messages from it, use the `partner-outreach` skill; the
approve/decline of applications and any sending happens in the network dashboard.

Matter-of-fact tone, UK spelling, no hype. Keep tables compact.

## Constraints

- Read-only. This skill produces a worklist; it never approves, declines, or
  contacts a partner. For Awin the roster read is a browser navigation that
  touches no approve, decline, or other control. Do not imply a write is
  available.
- Awin's relationship status is not API-readable. The Awin advertiser API
  returns only joined publishers with no relationship-status field, so every row
  maps to `unknown`. Never roll up `affiliate_awin-advertiser_list_media_partners`
  by `status` and present it as the roster split, and never derive the dormant
  worklist from it: the split would be all `unknown` and dormancy (which keys on
  an `active` relationship) would never fire. Read the roster and status from the
  new-UI partnerships page instead.
- Awin Classic (ui.awin.com) accounts have no partnerships page; detect the
  redirect and report the roster as unreadable for that binding rather than
  guessing or falling back to the status-less API roster.
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
