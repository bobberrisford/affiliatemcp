# Week 7 launch bundle — new MCP spec, served on day one

Timely news launch: the MCP spec revision 2026-07-28 made sessions optional,
and the hosted connector served it in production the day after the
announcement, verified by four unauthenticated live checks. Prepared for Rob
to review under campaign mode
(`docs/decisions/2026-07-27-campaign-mode-for-reviewed-social-runs.md`);
nothing is scheduled until he approves this copy.

| | |
|---|---|
| **Week** | 7 (news post inside the blitz #2 window) |
| **Cohort** | Both, developer-leaning, founder voice |
| **Feature** | Hosted transport serving MCP revision 2026-07-28 |
| **Proof** | Live probe run 30523987206, 4/4 pass, 2026-07-30 |
| **Gating** | None. All figures real; no demo framing required |

## Contents

- `card.html` — branded, self-contained 1080×1080 artifact (local brand fonts,
  no external fetches).
- `card.png` — the shareable image (2160×2160, retina).
- `post.md` — the LinkedIn post, first comment, slot proposal, and claims table.

## Hook

"The MCP spec changed. Did my connector break?" — no, and it already speaks
the new revision. The card is the live verification receipt, not a mock-up.

## Before publishing

- The proposed slot displaces blitz #2 post 3 by a week; see `post.md`.
- Publishing is Rob's decision. Campaign mode allows scheduling only after he
  has reviewed this copy in the tracked PR and explicitly authorised the run.
