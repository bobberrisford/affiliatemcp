---
name: autopilot-setup
description: |
  Use this skill to turn on the agency autopilot: it checks the prerequisites, then walks the operator through creating a Claude Desktop scheduled task that fires the autopilot-run skill on a cadence. It cannot create the schedule itself — Claude Desktop owns the calendar — so it hands over the exact prompt and settings to use.
  Trigger on: "Turn on the autopilot", "Schedule the weekly agency check", "Set up the autopilot", "Automate the anomaly watch".
---

# Operating instructions

You are helping the operator switch on the scheduled autopilot loop. The loop
runs as a Claude Desktop scheduled task: each fire is a fresh local session that
runs the `autopilot-run` skill. UK spelling.

## Step 1 — check prerequisites

Call `affiliate_autopilot_load_context({ loop: "weekly" })`:

- If `bindings` is empty, stop and say the book is empty — run
  `affiliate-networks-mcp setup` to register brands first.
- Report how many `clients` have intent recorded vs none. It is fine to schedule
  with zero intent (the loop falls back to default thresholds), but tell the
  operator that recording intent via the `client-onboarding` skill makes the
  digest judge against each client's own targets. Offer to do that first.

## Step 2 — pick the cadence and loop name

Offer two common shapes:

- **Weekly brief** (loop `weekly`, the default) — a Monday-morning digest.
- **Daily pulse** (loop `daily`) — shorter, for fast-moving books.

The loop name is just a lowercase label; the same name must be used when
scheduling and is what keeps each cadence's run-state separate.

## Step 3 — hand over the schedule (you cannot create it)

Tell the operator, in Claude Desktop, to open scheduled tasks and create one
with:

- **Prompt:** `/autopilot-run weekly` (match the loop name chosen above).
- **Frequency:** e.g. every Monday 08:00, or daily.

Make the awake-only limitation explicit: a Desktop scheduled task only fires
while the app is running and the machine is awake; a run scheduled while the
machine is asleep is skipped. If they need always-on overnight coverage, that is
a later option (Cloud Routines), not this local path.

## Step 4 — prime the baseline

Suggest running `/autopilot-run weekly` once by hand now. The first run sets the
baseline snapshot, so the first *scheduled* run can report changes rather than
treating everything as new.

## Constraints

- Do not claim to have created the schedule — you cannot; the operator creates it
  in Claude Desktop. Confirm what they should enter and verify prerequisites.
- Keep the loop name consistent between this setup and the scheduled prompt.
