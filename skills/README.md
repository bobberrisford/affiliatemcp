# `skills/`

User-facing Claude skills — pre-written conversation patterns Claude
picks up automatically when a user asks the right kind of question.
Each skill is a folder with a `SKILL.md` (YAML frontmatter + prose)
and optional supporting files.

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

### Brand / agency side

- [`programme-performance-report/`](./programme-performance-report) —
  single-brand report across that brand's bound networks. Top
  publishers, status splits, period-over-period delta.
- [`agency-portfolio-rollup/`](./agency-portfolio-rollup) — portfolio
  rollup, brand-aggregated, with a "needs attention" subsection for
  brands trending down.
- [`programme-anomaly-watch/`](./programme-anomaly-watch) —
  week-over-week scan for revenue drops, reversal spikes, top-10
  dropouts, dead programmes. Designed to run on a schedule.

### Browser-driven (operator side)

- [`publisher-application-approvals/`](./publisher-application-approvals) —
  works through a network's pending publisher application queue,
  judges each applicant against an editable appropriateness rubric,
  auto-actions the clear-cut cases and escalates the borderline ones.
  Unlike the other skills it drives the live dashboard (Awin first) in
  the operator's own signed-in browser session — there is no API for
  actioning applications. See
  [`docs/product/publisher-approvals-automation.md`](../docs/product/publisher-approvals-automation.md).

Adding a skill is one of the contribution paths in
[`.claude/skills/contribute/SKILL.md`](../../.claude/skills/contribute/SKILL.md).
