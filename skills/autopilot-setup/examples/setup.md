# Example: turning on the weekly autopilot

**Operator:** "Turn on the autopilot — weekly is fine."

## What the skill does

1. `affiliate_autopilot_load_context({ loop: "weekly" })` → 3 brands bound, 2 with
   intent recorded.
2. Reports: "3 brands in the book; Acme and Globex have targets set, Initech does
   not — it'll use default thresholds until you record some via the
   client-onboarding skill. Schedule anyway?"
3. Operator confirms weekly.

## What the skill tells the operator to do

> In Claude Desktop, create a scheduled task:
> - **Prompt:** `/autopilot-run weekly`
> - **Frequency:** every Monday at 08:00
>
> Note: the task only fires while Claude Desktop is running and your machine is
> awake — a run scheduled during sleep is skipped.

## Priming the baseline

> Run `/autopilot-run weekly` once now so the first scheduled run reports
> *changes* rather than flagging everything as new.
