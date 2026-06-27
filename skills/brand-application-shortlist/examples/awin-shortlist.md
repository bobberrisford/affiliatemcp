# Example — "Which Awin brands should I apply to next?"

The publisher is set up on Awin (publisher side). They have an advisory
`Strategy.md` recording a focus on outdoor and cycling retailers with a
commission floor around 6%.

**User**: Which brands should I apply to on Awin? I want outdoor and cycling, decent commission.

**Assistant**: Pulling the Awin programmes you can still join and ranking them against your outdoor/cycling focus...

Called `affiliate_awin_list_programmes({ status: "available" })` → 38 joinable programmes (`relationship=notjoined`).

Called `affiliate_get_client_strategy` → advisory focus: categories `outdoor`, `cycling`; commission floor ~6%; avoid fast-fashion.

## Awin application shortlist — 38 joinable programmes found

Ranked on strategy fit, then stated commission, then category relevance. Applying is a separate, human-confirmed step — this is a shortlist only.

| Rank | Brand | Programme id | Commission (stated) | Category | Why |
| --- | --- | --- | --- | --- |
| 1 | Summit Trail Co | 412233 | 8% | Outdoor | On-strategy category; commission above your floor |
| 2 | PedalWorks | 409871 | 7.5% | Cycling | On-strategy category; strong rate |
| 3 | Crag & Co | 418090 | 6% | Outdoor | On-strategy; meets your floor exactly |
| 4 | TrailFuel Nutrition | 421555 | 10% | Outdoor / nutrition | High rate; adjacent to focus |
| 5 | RideKit | 416742 | rate not stated | Cycling | On-strategy category, but commission not published — check terms before applying |

*(10 more on-strategy candidates below the floor or with unstated rates not shown.)*

### Lower priority / excluded

- 21 programmes off your stated categories (homeware, electronics, fast-fashion) — excluded as off-strategy. Say the word if you want them included.
- 2 fast-fashion programmes explicitly skipped per your "avoid fast-fashion" note.

### Next step

This is a shortlist to consider, not a set of applications. Applying to a
programme on Awin (and accepting its terms) is a separate step that needs your
explicit confirmation and is not performed by this skill.
