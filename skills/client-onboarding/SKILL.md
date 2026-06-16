---
name: client-onboarding
description: |
  Use this skill when an operator wants to record, review, or change a client's affiliate strategy and KPI targets so reports can be judged against the client's own plan. Capture is conversational: the operator pastes an existing brief, deck, or email, or just describes the client in their own words, and this skill drafts the strategy and KPI files, reads them back in plain English, and saves them only after the operator confirms. Thereafter it edits them through chat.
  Trigger on: "set up a strategy for Acme", "record Acme's KPIs", "onboard a new client", "what are we aiming for with Acme?", "raise Acme's Q3 revenue target to 400k", "Acme prefers premium partners, no coupon sites", "save this client brief".
---

# Operating instructions

You capture and maintain a client's advisory strategy and KPI targets. The
record is two local markdown files per client, keyed by the brand slug from
`brands.json`:

- `Strategy.md` — free prose: objectives for the period, preferred and
  deprioritised partner types, brand-safety and compliance rules, seasonal
  focus, reporting voice and cadence, and what to escalate to a human.
- `KPI.md` — free prose plus one fenced ` ```kpi ` block of measurable targets.

These files are **advisory**. They shape how reports read and what gets
flagged; they never authorise a network write or change any spending or payout
limit. Never imply otherwise.

You never ask the operator to learn a grammar or edit markdown. They give you
intent; you do the structuring; you confirm in plain English; the tool writes.

## Step 1 — identify the client

If the operator did not name a client, ask which one.

Call `affiliate_resolve_brand` (no arguments) to see registered brands. Match
the named client to a slug.

- If the slug is registered, continue.
- If it is not registered, say so and explain that strategy is keyed to the
  brand slug in `brands.json`. Ask the operator to confirm the lowercase slug
  to use. Offer to continue anyway (the files will be saved but flagged as an
  **orphan** until the brand is bound) or to set up the brand binding first. Do
  not invent a binding.

Call `affiliate_get_client_strategy({ brand })` to load anything already
recorded.

- If `orphan` is true, explain that a client-strategy directory exists but the
  slug has no current `brands.json` binding. You may maintain the advisory
  files after confirmation, but do not imply any network data is available for
  that slug until it is bound.
- If `kpi.parseErrors` is non-empty, show the parser's line/reason output in
  plain English before making changes. Do not overwrite the KPI file unless the
  operator confirms a corrected replacement.
- If `strategy.present` or `kpi.present` is true, you are editing, not
  creating — see Step 5.
- If neither is present, this is a new advisory record.

## Step 2 — gather intent (pick whatever the operator offers)

Lowest friction first. Do not force an interview when the operator already has
the answer written down.

1. **Ingest an existing artefact.** If the operator pastes a kickoff brief,
   QBR deck, statement of work, email thread, or a list of targets, read it and
   extract: objectives, preferred and deprioritised partner types, brand-safety
   rules, seasonal notes, reporting cadence and audience, and any numeric
   targets. Pull out what is there; do not invent the rest.
2. **Interview.** If they would rather talk, ask a short, plain set of
   questions: what does success look like this period; which partner types they
   want more or less of; any brand-safety or compliance rules; who the report is
   for and how often; what must be escalated immediately; and the numbers they
   are held to (revenue, conversions, EPC, AOV, reversal rate, approval rate).
   Ask only for what you do not already have.
3. **Vertical template.** If the client is brand new and the operator has
   little to give, propose a sensible starter set for their vertical (for
   example retail, finance, or travel) and let them adjust it. Make clear these
   are starting defaults, not their real numbers.

Whatever the route, you are filling in the same two files.

## Step 3 — draft the files

Draft `Strategy.md` as plain prose under clear headings. Keep it the operator's
voice and only as long as it needs to be.

Draft `KPI.md` with a short prose preamble and exactly one fenced ` ```kpi `
block. Emit the block yourself — the operator never types it. One target per
line, in this shape:

```kpi
# targets: metric: comparator value [unit] [per period]
version: 1
revenue: >= 400000 GBP per quarter
conversions: >= 1200 per month
epc: >= 0.45 GBP
aov: >= 65 GBP
reversal_rate: <= 8% per month
approval_rate: >= 90% per month
```

Rules you must follow when writing the block:

- `version: 1` is the first entry, always.
- Use only these metrics: `revenue`, `conversions`, `commission`, `epc`,
  `aov`, `reversal_rate`, `approval_rate`. If the operator wants a target on
  something not in this list, tell them it cannot be recorded as a measurable
  target yet and keep it as prose in `Strategy.md` instead.
- Monetary metrics (`revenue`, `commission`, `epc`, `aov`) take a 3-letter
  currency code; rate metrics (`reversal_rate`, `approval_rate`) take `%`;
  `conversions` takes no unit.
- Period is optional and one of `day`, `week`, `month`, `quarter`, `year`.
- Do not guess a number the operator did not give. Leave it out and say you
  left it out.

## Step 4 — read back, confirm, then write

Read the draft back in **plain English**, never as raw markdown. For example:

> For Acme I have: revenue target £400k per quarter, at least 1,200 conversions
> a month, EPC at or above £0.45, reversals under 8% a month. Strategy: premium
> content partners preferred, no coupon or incentive sites, strict brand
> safety, weekly report to Jane, escalate any drop over 20% immediately.
> Save this for Acme?

Treat `affiliate_set_client_strategy` as a side-effecting local-config write.
Only after the operator confirms, call
`affiliate_set_client_strategy({ brand, strategyMarkdown, kpiMarkdown })`.

- If the result is `written: false` with `parseErrors`, a target line was
  malformed. Fix the named line and call again. Never report success on a
  failed write.
- If the result is `written: false` with a `reason`, relay it plainly.
- On success, confirm what was saved and where it is keyed (the brand slug).

## Step 5 — edit through chat thereafter

When the operator asks to change something ("raise Acme's Q3 target to £450k",
"drop the coupon ban", "report fortnightly now"):

1. Call `affiliate_get_client_strategy({ brand })` to load the current files.
2. For a `Strategy.md` change, patch `strategy.markdown`, leaving everything
   else exactly as it was.
3. For a KPI target change, use `kpi.targets` as the source of truth and build
   a fresh `KPI.md` block with the edited target plus the unchanged valid
   targets. `affiliate_get_client_strategy` returns parsed targets and parse
   errors, not raw KPI markdown, so do not claim you are preserving handwritten
   KPI prose. Tell the operator when the save will replace `KPI.md` with a
   normalised block.
4. If `kpi.parseErrors` is non-empty, stop and ask whether to replace the KPI
   file with a corrected block. Do not silently drop malformed targets.
5. Read the change back in plain English and confirm.
6. Call `affiliate_set_client_strategy` with only the file(s) that changed.

The markdown files are the source of truth; the operator may also edit them by
hand. Chat is the convenience, not the only path.

## Surfacing the gap

If the operator asks "which clients still need a strategy?", call
`affiliate_list_client_strategies` and report the registered brands where
`hasStrategy` or `hasKpi` is false, plus any `orphan` directories. Reporting
skills also prompt to set one up when a brand has none.

## Constraints

- Advisory only. Strategy and KPIs never authorise a network write or change a
  spending, payout, or write-eligibility limit.
- Never invent a target the operator did not give.
- Local-first. These files stay on the operator's machine; they are not sent to
  any project service.
- UK spelling, matter-of-fact tone.
