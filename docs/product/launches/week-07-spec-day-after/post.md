# Week 7 launch — new MCP spec, served on day one

**Channel:** Rob's LinkedIn profile (`robertberrisford`) · **Cohort:** both
(developer-leaning, founder voice) · **Image:** `card.png`

This is a timely news post, not an evergreen feature post. Its value decays
with the news cycle, so the proposed slot is the earliest one that keeps the
blitz #2 cap of two posts a day.

## Proposed slot, and the cadence conflict

Blitz #2 already fills Thu 30 Jul with posts 2 (08:00) and 3 (16:30).
Proposal: this post takes **Thu 30 Jul, 16:30**, and blitz post 3 ("answered
before the call ended", fully evergreen) moves to **Wed 5 Aug, 08:00**. That
keeps the two-a-day cap and costs the evergreen post nothing. Rob decides;
nothing is scheduled until he does.

## Post

> The MCP spec changed yesterday. Our hosted connector already speaks it in
> production.
>
> The new revision makes sessions optional. Fewer moving parts between your
> affiliate data and your AI, and nothing changes for anyone on the old
> protocol.
>
> Verified live this morning. Four independent checks, four passes, a day
> after the announcement.
>
> Protocols move. The point of a hosted connector is that it moves with them
> so you don't have to care.
>
> Automate the drudgery.

Character count: 464. Ceiling 600.

## First comment

> The connector, free to start: https://agenticaffiliate.ai/go/new-mcp-spec

## Claims used, and their source

| Claim | Source |
| --- | --- |
| Serving the 2026-07-28 revision in production | `containers/wrangler.toml` `HOSTED_STATELESS_2026 = "1"`, deployed in run 30519441603 |
| Four independent live checks, four passes | Hosted live probe run 30523987206 (2026-07-30 07:45 UTC): metadata 200, health 200, legacy challenge intact, stateless path live |
| Sessions optional in the new revision | MCP spec revision 2026-07-28; adapter in `containers/src/stateless.ts` |
| Nothing changes on the old protocol | Same probe run: legacy `/mcp` answers exactly as before; conformance baseline green in CI |
| "A day after the announcement" | Spec announced 29 Jul 2026; launch flag merged and verified live 30 Jul 2026 |

All figures on the card are real. No demo framing needed.

## Notes

- Founder-voice news post: blitz #1 measured this genre at roughly 2:1 over
  feature posts, and being a day behind the spec is the story.
- "Among the first MCP servers in production on the new revision" was
  deliberately weakened to what we can prove: *our* day-one timeline. We
  cannot enumerate every other server, so we do not claim a ranking.
- Links go in the first comment, not the post body.
