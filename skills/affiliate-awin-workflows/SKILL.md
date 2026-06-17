---
name: affiliate-awin-workflows
description: |
  Use this skill when an Awin user wants a richer Awin-specific workflow than the shared seven-operation surface: a daily performance brief, finding offers or vouchers, building a tracking link, investigating transactions, or scanning programmes to promote.
  Trigger on: "Awin daily brief", "find Awin offers", "build an Awin link", "investigate my Awin transactions", "what Awin programmes should I promote", "Awin opportunity scan".
---

# Operating instructions

This skill is **Awin only**. It exists because Awin's adapter exposes a richer
toolset than the shared cross-network surface, and because the server ships five
Awin-specific MCP prompts that are otherwise hard to discover. Other networks do
not have these capabilities; do not imply they do.

If your MCP client lists prompts, the matching `awin_*` prompt pre-fills each
workflow below and is the most direct route. If your client does not surface
prompts, run the same Awin tools directly as described here. Either way the tool
calls are identical.

Always run `affiliate_awin_verify_auth` first if Awin credentials have not been
checked in this session. If it fails, surface the verbatim envelope error and
stop; do not guess at data.

## Workflow 1 — daily performance brief

Trigger: "Awin daily brief", "how did Awin do this week".
Prompt: `awin_daily_performance_brief`.

1. `affiliate_awin_get_advertiser_performance` for the period (default last 30
   days to today, region `GB` unless the user says otherwise).
2. `affiliate_awin_list_transactions` for the same period.
3. Summarise total commission, sales, clicks when available, top advertisers,
   biggest changes or risks, and pending or reversed watch-outs.

Treat an empty `200` response as valid: say there was no activity for the
period rather than inventing zeros.

## Workflow 2 — find offers and vouchers

Trigger: "find Awin offers", "any Awin vouchers for X".
Prompt: `awin_offer_finder`.

1. `affiliate_awin_list_offers` with `membership` (default `joined`),
   `regionCodes` (default `["GB"]`), and `type` or `exclusiveOnly` when the user
   asks.
2. Rank or filter by the advertiser or topic the user named.

Return a short shortlist: advertiser, offer title, type, dates, voucher
visibility, destination URL, tracking URL when present. Keep limitations
visible: some voucher codes are hidden, and not-joined advertisers cannot be
promoted until the user joins.

## Workflow 3 — build a tracking link

Trigger: "build an Awin link", "deeplink this Awin advertiser".
Prompt: `awin_link_builder_workflow`.

1. If the advertiser ID is unknown, `affiliate_awin_list_programmes` to find it.
2. `affiliate_awin_get_link_builder_quota` to check remaining quota.
3. `affiliate_awin_get_programme_details` for the advertiser, to confirm
   membership and deeplink support before generating.
4. `affiliate_awin_generate_tracking_links` with the destination URL (and an
   optional campaign parameter).

Return the long tracking URL, a short URL only if Awin returned one, any
deeplink-support warning, quota context, and whether the advertiser is joined.
Do not generate a link for an advertiser the user has not joined without saying
so.

## Workflow 4 — investigate transactions

Trigger: "investigate my Awin transactions", "why was this Awin sale reversed".
Prompt: `awin_transaction_investigation`.

1. If the user has specific IDs, `affiliate_awin_get_transactions_by_id`.
2. Otherwise `affiliate_awin_list_transactions` filtered by status (default
   pending or reversed) and period.
3. If the question is about missing, incorrect, or declined transactions, also
   `affiliate_awin_list_transaction_queries`.

Explain status, age, commission, advertiser, click or order references when
Awin exposes them, and reversal reasons. Preserve uncertainty: when Awin does
not expose a field, say so rather than filling it in.

## Workflow 5 — programme opportunity scan

Trigger: "what Awin programmes should I promote", "Awin opportunity scan".
Prompt: `awin_programme_opportunity_scan`.

1. `affiliate_awin_list_programmes` with a relationship status (default
   `joined`) and an optional search term.
2. For the best candidates, `affiliate_awin_get_programme_details` and
   `affiliate_awin_list_commission_groups`.
3. `affiliate_awin_get_advertiser_performance` where there is existing activity.

Rank by fit, commission potential, EPC or KPI signals when present, deeplink
availability, offer availability, and operational risk such as pending or
suspended membership.

## Constraints

- Awin only. Never imply another network supports offers, link-builder quota,
  transaction queries, or commission groups. Those are Awin custom tools.
- Never invent figures or statuses. If a tool errors, surface the verbatim
  envelope error (network, operation, message, HTTP status) and continue or
  stop as appropriate.
- Respect Awin's currency and fields as returned; do not normalise or convert.
- UK spelling throughout.
- For consolidated cross-network earnings or link audits, defer to
  `affiliate-earnings-report` and `audit-affiliate-links`; this skill is for
  Awin-depth work the shared surface cannot express.
