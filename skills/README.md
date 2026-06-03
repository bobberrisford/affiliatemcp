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

### Agency autopilot (scheduled, with memory)

The autopilot turns the agency-side watching into an unattended loop.
See [`docs/product/agency-autopilot.md`](../docs/product/agency-autopilot.md).

- [`autopilot-run/`](./autopilot-run) — the scheduled payload. Fans out
  across the book, judges each client's numbers against the targets they
  recorded, and reports only what is new, worsening, or resolved since
  the last run (it remembers, via a local snapshot).
- [`client-onboarding/`](./client-onboarding) — record or edit a
  client's strategy and KPI thresholds by chat, so the loop judges
  against what each client actually wants.
- [`autopilot-setup/`](./autopilot-setup) — walk through creating the
  Claude Desktop scheduled task that fires the autopilot run.

Adding a skill is one of the contribution paths in
[`.claude/skills/contribute/SKILL.md`](../../.claude/skills/contribute/SKILL.md).
