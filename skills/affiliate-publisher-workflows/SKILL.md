---
name: affiliate-publisher-workflows
description: |
  Use this skill when a publisher wants a deeper single-network workflow than a consolidated earnings total: a performance brief, finding offers or vouchers, building a tracking link, investigating transactions, or scanning programmes to promote. Works across any configured network and uses richer network-specific tools where they exist.
  Trigger on: "affiliate performance brief", "find affiliate offers", "build an affiliate link", "investigate my transactions", "what programmes should I promote", "affiliate opportunity scan".
---

# Operating instructions

These are publisher depth workflows. They run against **any configured network**
using the shared operation surface, and they use richer network-specific tools
**only when that network exposes them**.

## How capability detection works

Two layers, do not skip them:

1. The **shared surface** is available for every registered adapter:
   `affiliate_<slug>_get_earnings_summary`, `_list_programmes`, `_get_programme`,
   `_list_transactions`, `_list_clicks`, `_generate_tracking_link`,
   `_verify_auth`. Build the core of every workflow on these so it works on all
   networks.
2. Some networks expose **extra operations** beyond the shared surface. These
   appear as additional `affiliate_<slug>_<op>` tools in your available tool
   list, and only for the networks that implement them. Today Awin is the only
   network with the rich set (`list_offers`, `get_link_builder_quota`,
   `list_transaction_queries`, `list_commission_groups`, `get_programme_details`,
   `get_advertiser_performance`, `get_transactions_by_id`,
   `generate_tracking_links`). Treat any such tool as an enhancement: use it when
   it is present, and fall back to the shared surface when it is not.

When unsure whether a network supports an operation, call
`affiliate_run_diagnostic` for that network. It returns the network's
capabilities and is the authority on what is actually supported. Do not assume a
capability exists because another network has it, and never invent a tool name
of the form `affiliate_<slug>_list_offers` for a network whose tool list does
not contain it.

Always run `affiliate_<slug>_verify_auth` first if a network's credentials have
not been checked this session. If it fails, surface the verbatim envelope error
and move on or stop; do not guess at data.

This skill is for single-network depth. For a consolidated cross-network
earnings total defer to `affiliate-earnings-report`; for chasing validated but
unpaid commissions defer to `chase-unpaid-commissions`; for site link health
defer to `audit-affiliate-links`.

## Workflow 1 — performance brief

Trigger: "performance brief for <network>", "how did <network> do this week".

- Core (all networks): `affiliate_<slug>_get_earnings_summary` for the period
  (default last 30 days to today) plus `affiliate_<slug>_list_transactions` for
  the same window. Summarise commission, sales, top programmes, biggest changes,
  and pending or reversed watch-outs.
- Enhanced where supported: if `affiliate_<slug>_get_advertiser_performance`
  exists (Awin today), use it for advertiser-level breakdowns.

Treat an empty `200` response as valid: say there was no activity, do not invent
zeros.

## Workflow 2 — find offers and vouchers

Trigger: "find offers", "any vouchers for X".

- This depends on an offers operation that is **not** part of the shared surface.
  Only run it for a network whose tool list includes
  `affiliate_<slug>_list_offers` (Awin today). Filter or rank by the advertiser
  or topic the user named, and keep limitations visible: some voucher codes are
  hidden, and not-joined advertisers cannot be promoted until the user joins.
- If the user's network has no offers tool, say so plainly and point them at the
  programme scan (Workflow 5) as the closest supported alternative, rather than
  pretending offers data exists.

## Workflow 3 — build a tracking link

Trigger: "build an affiliate link", "deeplink this advertiser".

- Core (all networks): identify the programme with
  `affiliate_<slug>_list_programmes` if you do not have its id, confirm
  membership, then `affiliate_<slug>_generate_tracking_link` with the programme
  id and destination URL.
- Enhanced where supported: if `affiliate_<slug>_get_link_builder_quota` or
  `affiliate_<slug>_get_programme_details` exist (Awin today), check quota and
  deeplink support before generating, and use the batch
  `affiliate_<slug>_generate_tracking_links` if present.

Return the tracking URL, any deeplink-support warning, and whether the programme
is joined. If `generate_tracking_link` returns a `NotImplementedError` or an
upstream error, surface it verbatim and tell the user to build the link in the
network dashboard.

## Workflow 4 — investigate transactions

Trigger: "investigate my transactions", "why was this sale reversed".

- Core (all networks): `affiliate_<slug>_list_transactions` filtered by status
  (default pending or reversed) and period. Explain status, age, commission,
  programme, and any reversal reason the network exposes.
- Enhanced where supported: if `affiliate_<slug>_get_transactions_by_id` exists,
  use it when the user has specific ids; if
  `affiliate_<slug>_list_transaction_queries` exists (Awin today), use it for
  missing, incorrect, or declined transactions.

Preserve uncertainty: when a network does not expose a field, say so rather than
filling it in.

## Workflow 5 — programme opportunity scan

Trigger: "what programmes should I promote", "opportunity scan".

- Core (all networks): `affiliate_<slug>_list_programmes` with a relationship
  status (default `joined`) and an optional search term, then
  `affiliate_<slug>_get_programme` for the best candidates.
- Enhanced where supported: if `affiliate_<slug>_get_programme_details`,
  `affiliate_<slug>_list_commission_groups`, or
  `affiliate_<slug>_get_advertiser_performance` exist (Awin today), use them to
  rank by commission potential, KPI signals, and operational risk.

Rank by fit, commission potential, deeplink availability, and risk such as
pending or suspended membership, using whatever signals the network actually
returns.

## Constraints

- Network-honest. Only call a network-specific tool that appears in your
  available tool list for that network. Never imply a network supports offers,
  quota, transaction queries, or commission groups when its tools do not include
  them. State the gap.
- Never invent figures or statuses. If a tool errors, surface the verbatim
  envelope error (network, operation, message, HTTP status) and continue or stop
  as appropriate.
- Respect each network's currency and fields as returned; do not normalise or
  convert.
- UK spelling throughout.
- On Awin, the shipped `awin_*` MCP prompts pre-fill these workflows and are the
  quickest route; this skill runs the same tools directly for every other
  network.
