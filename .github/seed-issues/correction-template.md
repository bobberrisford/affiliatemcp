# [correction] EXAMPLE — Rakuten click latency in REPORT.md

This is a placeholder showing the shape of a good `correction` issue. The
maintainer should close or delete it before public launch.

**Which file or section:** `REPORT.md` > "Rakuten Advertising" > "Clicks".

**What is wrong:**

> "Click data is delayed by up to 24 hours."

This is no longer accurate based on Rakuten's October 2026 changelog, which
notes click events now stream into the reporting API within 30 minutes for
approved publishers.

**Source / evidence:** Link to Rakuten's developer changelog entry (would be
included in a real issue). Plus an HTTP trace showing a click made at
`14:02 UTC` appearing in `list_clicks` results at `14:21 UTC`.

**Suggested correction:**

> "Click data is typically available in `list_clicks` within 30 minutes for
> approved publishers; backfills for the previous day complete by 06:00 UTC."

The underlying finding should be updated in
`docs/findings/rakuten.md`, not in `REPORT.md` directly, then
`REPORT.md` regenerated.
