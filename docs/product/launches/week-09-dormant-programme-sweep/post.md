# Week 9 launch — dormant programme sweep (publisher)

**Channel:** Rob's LinkedIn profile (`robertberrisford`, channel
`6a5ce892e2638b94d7973b83`) · **Cohort:** publishers / creators · **Image:**
`card.png` on post 1 only.

Three posts across the week, one a day, profile only. The company page
(`agenticaffiliate`) is deliberately not mirrored: blitz #1 measured it at
roughly 20 impressions against ~310 on the profile.

Nothing here is scheduled. No campaign is named or time-boxed for week 9, so
`docs/decisions/2026-07-27-campaign-mode-for-reviewed-social-runs.md` leaves the
default in force: the agent prepares copy in a tracked PR, Rob queues or
publishes. The Buffer queue currently holds no scheduled posts, so any slot this
week is free.

## Proposed slots

| # | Slot | Post | Image |
| --- | --- | --- | --- |
| 1 | Tue 12 Aug, 08:00 | The sweep | `card.png` |
| 2 | Thu 14 Aug, 08:00 | What the API will not tell you | none |
| 3 | Fri 15 Aug, 08:00 | Two piles | none |

One a day. Blitz #1 measured 3–4 posts a day as roughly halving per-post reach.

---

## Post 1 — the sweep

> I pointed the agent at the Awin account I develop against and asked a question
> I could not answer myself: how many programmes have I joined?
>
> 2,415. Across 73 sectors and six currencies.
>
> Joining is close to a one-way door. You join for a campaign, a season, a
> client that has since moved on, and nothing ever prunes the list. The count
> only goes up. No dashboard shows you the gap between what you joined and what
> still pays you.
>
> The sweep shows that gap. It reads your joined list, reads what actually
> earned over a window you pick, and hands back two worklists: programmes that
> earned once and stopped, and programmes that never earned at all. Earnings on
> a dev account are a flat zero, so this one is all inventory and no revenue.
> On a trafficking account the split is the whole point.
>
> Read-only. It does not leave a programme or email a merchant. That stays with
> you.
>
> Automate the drudgery.

Character count: 1,042. LinkedIn ceiling 3,000; the "see more" fold is ~210
characters, and the 2,415 lands at 118.

**First comment:**

> Free to start: https://agenticaffiliate.ai/go/dormant-sweep

---

## Post 2 — what the API will not tell you

> Small thing I hit building this week's sweep.
>
> Awin's publisher programmes endpoint returns plenty per programme: name,
> currency, status, region, sector, description, logo, valid domains. It does
> not return the date you joined.
>
> Which kills the column every operator would actually want. How long has this
> dead programme been sitting in my list? Not answerable from the API. You can
> leave the cell blank and say why, or you can put something plausible in it and
> hope nobody checks.
>
> We leave it blank. The skill's own instructions say never invent a
> last-earned date, and a blank cell with a reason under it travels better than
> a number nobody can source.
>
> A lot of the work in wiring 72 networks to an agent turns out to be deciding
> what it is not allowed to say.

Character count: 806.

**First comment:**

> The sweep, and the rest of it: https://agenticaffiliate.ai/go/no-join-date

---

## Post 3 — two piles

> When you audit joined affiliate programmes, the split that matters is "earned
> once and stopped" against "never earned at all".
>
> The first pile is a relationship that worked and then something changed. The
> link came off the page. The commission group moved. The merchant paused the
> feed and nobody said. Those are worth an email.
>
> The second pile is inventory you took on and never used. Worth clearing, so
> the first pile is the only thing you have to look at on a Monday.
>
> Most reporting collapses the two into one dormant count. That number is
> accurate and does nothing for you.

Character count: 604.

**First comment:**

> https://agenticaffiliate.ai/go/two-piles

---

## Claims used, and their source

| Claim | Source |
| --- | --- |
| 2,415 joined programmes | `GET /publishers/{id}/programmes?relationship=joined`, run 2026-08-11; 2,415 rows |
| 73 sectors | Distinct `primarySector` across the same response |
| Six currencies | Distinct `currencyCode`: USD 1,339, EUR 587, GBP 398, BRL 22, PLN 20, CAD 13 |
| Zero earned in 12 months | `affiliate_awin_get_earnings_summary({from:"2025-08-11",to:"2026-08-11"})` → `totalEarnings: 0`, `byProgramme: []` |
| The zero is real, not a failed call | `GET /publishers/{id}/transactions/` for Jul 2026 returned HTTP 200 with `[]`. An auth or permission failure would not return 200 |
| Absence from `byProgramme` proves zero on Awin | `src/networks/awin/adapter.ts` folds every transaction in the window into `byProgrammeMap`; it is not a top-N ranking |
| No join date in the API | Programme rows carry exactly: `id`, `name`, `currencyCode`, `status`, `primaryRegion`, `primarySector`, `description`, `displayUrl`, `clickThroughUrl`, `logoUrl`, `validDomains` |
| Read-only | `skills/dormant-programme-sweep/SKILL.md` constraints; the skill calls only `list_programmes` and `get_earnings_summary` |
| 72 networks | `AGENTS.md`: 86 adapters across 72 affiliate-network families |
| Company page ~20 vs profile ~310 impressions | Blitz #1 measured results |

Every figure on the card and in post 1 is real and was pulled on 11 August 2026.
No demo framing is required, and no sample-data watermark is needed.

## The one framing call for Rob

Post 1 says the earnings side is zero and attributes that to it being the
account he develops against. That is accurate as far as the credentials go —
`AWIN_PUBLISHER_ID` in the local env is that account, and it has no
transactions. But only Rob knows the account's actual history and whether he
wants a public "zero" attached to it at all.

Three options:

1. **Ship as written.** The zero is explained in the same breath as it appears,
   and the 2,415 is the number people will repeat.
2. **Swap the account.** If another of the connected publisher accounts has real
   revenue, re-run the sweep against it and re-capture the card. The lapsed
   versus never-earned split would then be real too, which is a better demo.
3. **Drop the zero from the card.** Keep 2,415 / 73 / 6, cut the "earned in 12
   months · 0" line and the "100% dormant" badge, and let the post carry the
   earnings point.

Recommendation: option 1. The zero is what makes it a receipt rather than a
mock-up, and weeks 5 and 8 are both stuck in review precisely because their
cards carry invented figures instead.

## Notes

- Links go in the first comment, not the post body.
- No emoji, sentence case, UK English, Oxford comma. "Automate the drudgery"
  appears once across the three posts, on the launch.
- Post 2 is developer-leaning founder voice, which blitz #1 measured at roughly
  2:1 over feature posts.
- `site/go/dormant-sweep.html`, `no-join-date.html`, and `two-piles.html` are
  added in this PR and redirect to `hosted.html`, matching the existing pages.
