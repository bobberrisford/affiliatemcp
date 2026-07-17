# `skills/`

User-facing workflow skills — pre-written conversation patterns Claude-style
hosts can pick up automatically when a user asks the right kind of question.
Each skill is a folder with a `SKILL.md` (YAML frontmatter + prose)
and optional supporting files.

These are not network adapters and they are not MCP prompts. Adapters expose
typed per-network operations through the MCP server. Skills compose those tools
into affiliate jobs such as reports, setup help, anomaly checks, and client
onboarding. MCP prompts currently ship separately and are Awin-specific.

### Publisher side

- [`affiliate-earnings-report/`](./affiliate-earnings-report) — pulls
  a consolidated earnings report across every configured network and
  flags transactions sitting unpaid for more than 90 days.
- [`affiliate-network-status/`](./affiliate-network-status) — one-shot
  health check: auth working, API reachable, which operations the
  network supports.
- [`affiliate-network-setup-help/`](./affiliate-network-setup-help) —
  conversational credential setup for one of the bundled networks,
  with dashboard menu paths quoted verbatim.
- [`audit-affiliate-links/`](./audit-affiliate-links) — classifies the
  affiliate links in a sitemap or document by network and flags dead
  or declined programmes.
- [`chase-unpaid-commissions/`](./chase-unpaid-commissions) — pulls
  commissions a network validated but has not paid past a term (90
  days by default) and drafts a per-network chase email with the
  unpaid sales attached as a CSV.

### Brand / agency side

- [`programme-performance-report/`](./programme-performance-report) —
  single-brand report across that brand's bound networks. Top
  publishers, status splits, period-over-period delta. Also the one
  reporting workflow behind the cadence deliverables: daily snapshot,
  weekly client note, month-close, and quarterly business review (QBR)
  output profiles.
- [`publisher-performance-review/`](./publisher-performance-review) —
  single-publisher deep dive for a brand: clicks, conversions, EPC,
  AOV, status split, trend, and call talking points.
- [`programme-reversal-report/`](./programme-reversal-report) — why a
  brand's commissions are being declined: reversed transactions grouped
  by reason and publisher, value at stake, and reversal-rate trend.
- [`agency-portfolio-rollup/`](./agency-portfolio-rollup) — portfolio
  rollup, brand-aggregated, with a "needs attention" subsection for
  brands trending down.
- [`programme-anomaly-watch/`](./programme-anomaly-watch) —
  week-over-week scan for revenue drops, reversal spikes, top-10
  dropouts, dead programmes. Designed to run on a schedule.
- [`client-onboarding/`](./client-onboarding) — capture and maintain a
  client's advisory strategy and KPI targets from a pasted brief, an
  interview, or a vertical template. Confirms in plain English before
  saving, and edits through chat thereafter. Recorded targets let the
  reporting skills judge a delta against the client's own plan.
- [`partner-roster-audit/`](./partner-roster-audit) — a brand's partner
  roster split by status, plus the active partners that have gone quiet:
  a read-only dormant/reactivation worklist.
- [`partner-application-queue/`](./partner-application-queue) — the
  partners sitting in a brand's application queue, pending a decision.
  Read-only; the approve/decline happens in the network dashboard.
- [`programme-health-check/`](./programme-health-check) — one-off
  handover/kick-off diagnostic across every supported read operation for
  a brand: connection, capability matrix, data presence, and gaps.
- [`partner-outreach/`](./partner-outreach) — draft re-engagement or
  recruitment outreach for a brand, grounded in real performance figures
  and the recorded plan. Drafts only; never sends and never invents
  contact details.

A capability-aware roadmap of brand/agency deliverables, including which
outcomes should extend shipped skills rather than create new ones, lives in
[`docs/product/agency-account-manager-deliverables.md`](../docs/product/agency-account-manager-deliverables.md).

Adding a skill is one of the contribution paths in
[`.claude/skills/contribute/SKILL.md`](../.claude/skills/contribute/SKILL.md).
