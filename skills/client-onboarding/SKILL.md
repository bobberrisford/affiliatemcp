---
name: client-onboarding
description: |
  Use this skill to record or edit a client's affiliate strategy and KPI targets by chat, so the autopilot loop can judge that client's numbers against what they actually want. It interviews the operator, drafts the two intent files, confirms, and saves them — and handles later one-line edits too.
  Trigger on: "Set up a new client", "Record Acme's strategy", "Set a target for Globex", "Add a reversal alert for Acme", "Onboard a client".
---

# Operating instructions

You maintain each client's **intent** — two living markdown files the autopilot
loop reads. `strategy.md` is prose (priorities, voice, what to escalate);
`kpi.md` is prose plus one fenced block of machine-readable thresholds. Both are
keyed by the same brand slug used in `brands.json`. UK spelling.

Your job is to make recording intent feel like a short conversation, never a
form. Never present an empty file.

## Step 1 — identify the client

Ask which client, or take it from the request. Call
`affiliate_resolve_brand({ network })` (or with no argument) to confirm the slug
is in the book and see which networks it is bound to. If the slug is not
registered, say so and point to `affiliate-networks-mcp setup`.

## Step 2 — load anything already recorded

Call `affiliate_autopilot_load_context({ loop: "weekly" })` and find this client
in `clients`. If it already has `strategyMd` / `kpiMd`, you are editing, not
creating — show the current values before changing them.

## Step 3 — interview (creating) or target the edit

**Creating:** ask a short, plain interview — objectives this period; partner
types to grow vs limit; brand-safety/compliance rules; seasonal peaks; how they
like updates; what must be escalated immediately; and the measurable targets
(revenue, EPC, AOV), acceptable reversal rate, and alert thresholds.

**Seed from data, never blank:** if the client has recent numbers (from a prior
autopilot run's snapshot, or a quick `get_programme_performance` call), propose
realistic targets — "Acme did about £310k last quarter; set the target there or
higher?" — rather than asking them to invent a figure.

**Editing:** target only the section or threshold named ("raise Acme's target to
£400k", "add a reversal alert above 10%", "deprioritise cashback for Globex").

## Step 4 — draft, validate, confirm

Draft `strategy.md` (prose) and `kpi.md`. The `kpi.md` thresholds MUST live in a
fenced block whose first line is the marker, simple `key: value` lines, numbers
unquoted:

````
# affiliate-mcp:thresholds
revenue_drop_wow_pct: 15
reversal_rate_max_pct: 8
quarterly_revenue_target_gbp: 400000
````

Keep currency in the key (`_gbp`, `_usd`) rather than a nested object. Add a
short commented example line so a hand-editor sees the menu. Sanity-check
values: if a reversal ceiling is entered as 80 when 2–5% is typical, query it
before saving — a fat-fingered threshold silently disables the alert. Show the
drafted files and confirm before writing.

## Step 5 — save

Call `affiliate_autopilot_save_intent({ slug, strategy, kpi })`, passing only the
file(s) you changed. Confirm the paths it returns. Tell the operator the
autopilot loop will use the new intent on its next run, and that the files are
plain markdown they can also edit by hand.

## Constraints

- Confirm before writing — this overwrites the named file.
- Never invent a client's strategy; if they are vague, record less, not guesses.
- Thresholds are the contract the loop checks; keep keys stable and documented.
