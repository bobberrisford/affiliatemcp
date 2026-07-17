# Skills, prompts, and examples audit

Semantic audit of every shipped skill, MCP prompt, and user-facing example
against the generated tool surface and a concrete affiliate customer journey.
Tracks GitHub issue #204.

## Why this exists

Issue #204 asked for one semantic audit, not just a tool-name spell-check. A
citation can be syntactically valid (the tool exists) yet still describe a
journey the product does not actually serve, or carry a stale network
assumption. This document records, for each artifact: the customer journey, the
target cohort, the host expectation, the concrete tools it cites, whether those
citations match the current surface, and any duplicate, gap, or unsupported
assumption.

The factual-name slice was completed in PR #210 (stale tool names and the
registered-versus-configured network wording). This audit covers the remaining
semantic validation and the prompt/skill ownership question.

## Method

- Inventoried `skills/` (10 skills), `src/prompts/generate.ts` (5 prompts), and
  `examples/` (Claude Desktop config plus its walkthrough).
- Derived the canonical tool surface from `src/tools/generate.ts` (the shared
  operation specs and meta-tools) and the per-network custom tools in
  `src/networks/awin/tools.ts` and `src/networks/tradedoubler/tools.ts`.
- Checked each cited tool or operation against that surface and judged whether
  the surrounding workflow describes a journey the tool actually supports.

## Canonical tool surface (reference)

Per-network operations generated for every adapter that declares support, named
`affiliate_<slug>_<snake_case_op>`:

- Publisher and advertiser: `list_programmes`, `get_programme`,
  `list_transactions`, `list_clicks`, `generate_tracking_link`, `verify_auth`.
- Publisher: `get_earnings_summary`.
- Advertiser only: `list_media_partners`, `get_programme_performance`.

Three always-present meta-tools: `affiliate_list_networks`,
`affiliate_run_diagnostic`, `affiliate_resolve_brand`.

Network-specific custom tools beyond the shared surface:

- Awin: a richer publisher toolset including `get_advertiser_performance`,
  `list_offers`, `get_link_builder_quota`, `get_programme_details`,
  `generate_tracking_links`, `get_transactions_by_id`,
  `list_transaction_queries`, `list_commission_groups`, `list_accounts`,
  and more (see `src/networks/awin/tools.ts`).
- Tradedoubler: `list_publisher_sources`.

These custom tools are real and correctly wired, but they exist for one network
only. A workflow that names them is network-specific by definition.

## Skill-by-skill audit

| Skill | Cohort | Customer journey | Host expectation | Cited tools | Verified | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| affiliate-earnings-report | Publisher | "How much did I earn across all my networks?" | Claude Desktop / Code with publisher credentials configured | `affiliate_<slug>_get_earnings_summary`, `affiliate_<slug>_list_transactions` | Yes | Canonical. Iterates configured publisher networks. |
| affiliate-network-status | Publisher / operator | "Is my affiliate setup working?" | Any MCP host; pairs with `doctor` CLI | `affiliate_run_diagnostic`, `affiliate_<slug>_verify_auth` | Yes | Canonical. Diagnostic is the authority on credential state. |
| affiliate-network-setup-help | Semi-technical operator | "Help me get credentials for network X." | Host with repo `docs/networks/` available; setup wizard CLI | `affiliate_list_networks`, `affiliate_run_diagnostic` | Yes | PR #210 made `affiliate_list_networks` the authoritative list; four launch networks framed as hand-written walkthroughs, not the supported set. No further repair needed. |
| audit-affiliate-links | Publisher | "Are the affiliate links on my site still tracking?" | Host that can read a pasted doc or sitemap | `affiliate_list_networks`, `affiliate_<slug>_get_programme`, `affiliate_<slug>_list_programmes`, `affiliate_<slug>_generate_tracking_link` | Yes | Tool citations canonical. Scope-framing fix needed: Step 1 implies the server supports only the four networks whose host patterns are listed. See Finding 1. |
| chase-unpaid-commissions | Publisher | "Chase commissions validated but unpaid past a term." | Publisher host; drafts a per-network chase email | `affiliate_list_networks`, `affiliate_<slug>_get_earnings_summary`, `affiliate_<slug>_list_transactions` | Yes | Canonical. Correctly limits to publisher-side adapters and uses the `minAgeDays` filter. |
| programme-performance-report | Agency / advertiser | "Per-publisher performance report for one brand." | Advertiser-side credentials; cadence profiles (daily/weekly/QBR) | `affiliate_resolve_brand`, `affiliate_<network>_get_programme_performance`, `affiliate_<network>_list_transactions`, `affiliate_<network>_list_media_partners` | Yes | Canonical advertiser operations. Impact-advertiser used only as a templated example. |
| publisher-performance-review | Agency / advertiser | "Single-publisher deep dive for a brand." | Advertiser-side credentials | `affiliate_resolve_brand`, `affiliate_list_networks`, `affiliate_<network>_list_media_partners`, `affiliate_<network>_get_programme_performance` | Yes | Canonical. Advises runtime capability checks. |
| programme-reversal-report | Agency / advertiser | "Why are this brand's commissions being declined?" | Advertiser-side credentials | `affiliate_resolve_brand`, `affiliate_list_networks`, `affiliate_<network>_list_transactions` | Yes | Canonical. Checks network support at runtime rather than assuming. |
| agency-portfolio-rollup | Agency | "How is the whole book doing this week?" | Advertiser-side credentials across brands; scheduled or on-demand | `affiliate_resolve_brand`, `affiliate_<network>_get_programme_performance` | Yes | Canonical. |
| programme-anomaly-watch | Agency | "Flag week-over-week anomalies before clients notice." | Advertiser-side credentials; designed for scheduled runs | `affiliate_resolve_brand`, `affiliate_<network>_get_programme_performance` | Yes | Canonical. |

All skill tool citations match the current surface. The one remaining semantic
repair is the scope framing in audit-affiliate-links (Finding 1).

## MCP prompts audit

`src/prompts/generate.ts` ships five prompts, all Awin-specific:

| Prompt | Journey | Cited tools | Verified |
| --- | --- | --- | --- |
| awin_daily_performance_brief | Awin publisher daily brief | `affiliate_awin_verify_auth`, `affiliate_awin_get_advertiser_performance`, `affiliate_awin_list_transactions` | Yes |
| awin_offer_finder | Find Awin promotions/vouchers for a campaign | `affiliate_awin_list_offers` | Yes |
| awin_link_builder_workflow | Generate an Awin tracking link with quota and membership checks | `affiliate_awin_list_programmes`, `affiliate_awin_get_link_builder_quota`, `affiliate_awin_get_programme_details`, `affiliate_awin_generate_tracking_links` | Yes |
| awin_transaction_investigation | Investigate pending/reversed/specific Awin transactions | `affiliate_awin_get_transactions_by_id`, `affiliate_awin_list_transactions`, `affiliate_awin_list_transaction_queries` | Yes |
| awin_programme_opportunity_scan | Assess Awin programmes before promoting | `affiliate_awin_list_programmes`, `affiliate_awin_get_programme_details`, `affiliate_awin_list_commission_groups`, `affiliate_awin_get_advertiser_performance` | Yes |

Every cited tool exists and is correctly wired. These prompts are healthy and
network-honest: they name Awin in the title and only call Awin tools.

The gap is ownership, not correctness. Five Awin prompts ship with no skill or
user-facing documentation explaining when an operator would reach for them, and
no other network has an equivalent. This is the prompt/skill ownership
follow-up named in #204. See Finding 2.

## Examples audit

- `examples/claude-desktop-config.json`: configuration only, no tool citations.
  Uses Awin env vars as the worked example. Honest as an illustrative starting
  point.
- `examples/claude-desktop-config.md`: references `affiliate_list_networks` as
  the meta-tool that should fire on first connection. Correct.

No drift in examples.

## Findings and dispositions

### Finding 1 (repair in this slice): audit-affiliate-links scope framing

`skills/audit-affiliate-links/SKILL.md` Step 1 introduces the four host-pattern
families with "The networks this server supports use these host patterns",
which reads as though the server supports only Awin, CJ, Impact, and Rakuten.
The server supports many more networks; links from those will not match a listed
host pattern and currently fall straight into "could not classify" with no
explanation that this is expected.

Disposition: small skills-only repair. Reframe so the four families are
described as the well-known host patterns the skill can classify by host, make
clear the server supports more networks (`affiliate_list_networks`), and direct
unmatched-but-affiliate links to the id-based lookup in Step 2 or to a user
confirmation rather than a dead end. Does not change the tool surface.

### Finding 2 (recommendation, follow-up phase): own the Awin prompts as a skill

The five Awin prompts deliver real publisher workflows (daily brief, offer
finder, link builder, transaction investigation, opportunity scan) that the
shared seven-operation surface cannot express, but they are undiscoverable
without reading source. Recommendation: ship an `affiliate-awin-workflows`
skill that documents these journeys and points at the prompts and Awin custom
tools, so an Awin publisher can find them conversationally.

This is a new skill, so it is a separate, scoped piece of work rather than part
of the factual-repair slice. Sketch:

- Cohort: Awin publishers (and Awin advertiser users for the performance views).
- Triggers: "Awin daily brief", "find Awin offers", "build an Awin link",
  "investigate my Awin transactions", "what Awin programmes should I promote".
- Body: map each trigger to the matching prompt and the Awin custom tools it
  calls; keep network limitations visible (deeplink support, quota, voucher
  visibility, fields Awin does not expose).
- Boundary: explicitly Awin-only. Does not imply other networks have these
  capabilities.

### Non-issues (recorded, no action)

- `list_clicks` is generated for every supporting adapter but cited in no skill.
  It is a specialist traffic-debugging operation, discoverable via
  `affiliate_list_networks`. No skill trigger is warranted.
- `affiliate_tradedoubler_list_publisher_sources` is generated but cited
  nowhere. Discoverable via `affiliate_list_networks`; note it in Tradedoubler's
  network doc only if it becomes load-bearing for setup.
- The four launch networks in affiliate-network-setup-help are now correctly
  framed as hand-written walkthroughs over an authoritative
  `affiliate_list_networks`; no repair needed (already addressed in PR #210).

## Outcome against #204 acceptance criteria

- Every shipped skill, prompt, and example has an identified customer journey
  and host expectation: recorded above.
- Every concrete tool citation checked against the current surface: all match.
- Known stale claims corrected or captured: the one remaining scope-framing
  issue is repaired as a focused follow-up (Finding 1); the prompt ownership gap
  is captured as a recommendation (Finding 2).
- Unsupported and unverified assumptions remain visible: the audit names the
  Awin-only nature of the custom tools and prompts rather than hiding it.
- Fixes split into independently reviewable outcomes: this audit, the Finding 1
  repair, and the Finding 2 skill are separate pieces of work.
