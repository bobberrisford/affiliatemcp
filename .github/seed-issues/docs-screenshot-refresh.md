# [docs] Refresh screenshots for all four per-network setup docs

**Which file or section:** `docs/networks/awin.md`, `docs/networks/cj.md`,
`docs/networks/impact.md`, `docs/networks/rakuten.md`.

**What is wrong:** The current setup docs use `[SCREENSHOT: …]` placeholders
in place of real images. They are correct as instructions but harder for a
first-time setup user to follow than annotated screenshots.

**Suggested correction:** Replace each placeholder with a real PNG under
`docs/networks/images/<slug>-<step>.png`. Keep the alt text describing what
the screenshot shows, so the doc remains useful when images fail to load.

**Notes:**

- Capture at a sensible width (around 1200px) so they read on both desktop
  and mobile.
- Redact any account-identifying data before committing.
- File one PR per network to keep diffs reviewable.
