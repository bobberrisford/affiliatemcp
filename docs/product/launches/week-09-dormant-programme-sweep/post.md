# Week 9 launch — dormant programme sweep

**Channel:** Rob's LinkedIn profile (`robertberrisford`, channel
`6a5ce892e2638b94d7973b83`) · **Image:** `card-advertiser.png` on post 1.

The brand side leads. Advertiser-side dormancy is the more useful half: a
publisher auditing their own joined list is tidying, while a brand discovering
that 90% of its recruited partners produce nothing is a budget and a
concentration-risk conversation.

The company page (`agenticaffiliate`) is not mirrored — blitz #1 measured it at
roughly 20 impressions against ~310 on the profile.

Nothing is scheduled. No campaign is named or time-boxed for week 9, so
`docs/decisions/2026-07-27-campaign-mode-for-reviewed-social-runs.md` leaves the
default in force: the agent prepares copy in a tracked PR, Rob queues. The
Buffer queue holds no scheduled posts, so every slot this week is free.

## The advertiser's identity — settled

The figures come from a live Awin advertiser programme that is not Rob's own
brand. Rob's call, 2026-08-11: **publishable as long as the advertiser is not
named.**

What that requires, and what has been done:

- The brand name, account ID, and every publisher name are withheld from the
  card, all three posts, and the worked example. Only aggregate shape is used.
- `git grep` over the branch for the brand name, both advertiser account IDs,
  and every connected publisher account name returns nothing.
- The card says "one real programme" and names no sector or region.
- No currency symbol appears anywhere, because the API returned a null currency
  field — so the commission total cannot be used to infer a market.

**Keep it that way on any edit.** The brand must not be named in the post body,
the first comment, a reply, or the image alt text. If anyone asks in the
comments which programme it was, the answer is that it is a real programme run
through the operator's own credentials and not identified.

## Proposed slots

| # | Slot | Post | Image |
| --- | --- | --- | --- |
| 1 | Wed 12 Aug, 08:00 | 524 recruited, 50 selling | `card-advertiser.png` |
| 2 | Thu 13 Aug, 08:00 | The eight publishers that were not on the list | none |
| 3 | Fri 14 Aug, 08:00 | The partner count is the wrong number | none |

One a day. Blitz #1 measured 3–4 a day as roughly halving per-post reach.

Today is Tuesday 11 August 2026, so this covers the rest of the week. Post 1
should not go out before the release in the deployment plan lands, so that the
first-comment link resolves to a version that actually contains the skill.

---

## Post 1 — 524 recruited, 50 selling

> I ran a partner sweep against a real Awin advertiser programme this morning.
>
> 524 publishers on the roster. Fifty of them produced a sale in the last 12
> months.
>
> One publisher held 39.8% of the commission. The top 10 held 89.9%. The other
> 474 sat on the roster, counted in the partner number on somebody's slide, and
> produced nothing in a year.
>
> That is not mismanagement. It is what recruitment does when nothing measures
> the back end of it. Signing a publisher costs nothing and looks like progress,
> and no network UI shows you the gap between the roster and the revenue.
>
> The sweep shows it. Roster in, transactions in, three groups out: producing,
> not producing, and producing-but-missing-from-the-roster. It reads your own
> programme through your own keys and changes nothing.
>
> Automate the drudgery.

Character count: 976. The "524 / 50" lands at character 121, above the ~210
"see more" fold.

**First comment:**

> Free to start: https://agenticaffiliate.ai/go/publisher-sweep

---

## Post 2 — the eight publishers that were not on the list

> Eight publishers were producing sales for a programme whose own partner list
> does not contain them.
>
> I found it reconciling two API calls: the advertiser's publisher roster, and
> the transactions for the same 12 months. Eight publisher IDs turned up in the
> transactions and nowhere in the roster.
>
> So the roster endpoint is a lower bound, not a census. If you have ever built
> a partner count off that single call, it is under-counting, and you would
> never catch it, because the number it gives you looks entirely plausible.
>
> The sweep reports that group on its own line now, every time, including when
> it is zero. Zero is a fine answer. Not looking is the problem.

Character count: 691.

**First comment:**

> How the sweep reconciles it: https://agenticaffiliate.ai/go/off-roster

---

## Post 3 — the partner count is the wrong number

> On the programme I swept this week, 50 publishers produced sales. One of them
> held 39.8% of the commission. Ten held 89.9%.
>
> A roster of 524 reads like a healthy, diversified partner base. What it
> actually describes is a concentration risk with 474 names standing in front of
> it.
>
> If that top publisher renegotiates, pauses, or walks, the programme does not
> have a partner problem. It has a revenue problem, and it has had one all year.
>
> Two numbers, then, not one: how many partners produce, and how much sits in
> the top few. Either on its own will mislead you, and the first one on its own
> is the one everybody reports.

Character count: 692.

**First comment:**

> https://agenticaffiliate.ai/go/two-numbers

---

## Claims used, and their source

Every figure pulled 2026-08-11. Window 2025-08-11 to 2026-08-11.

| Claim | Source |
| --- | --- |
| 524 publishers on the roster | `GET /advertisers/{id}/publishers/` → 524 rows |
| 50 produced a sale in 12 months | 12 chunked calls to `GET /advertisers/{id}/transactions/`, deduplicated by transaction `id` → 3,628 unique rows, 50 distinct `publisherId` |
| 474 non-producing, 90.5% | 524 − 50, as a share of the roster |
| Top publisher 39.8% of commission | Commission summed per `publisherId`; largest share of 33,367.33 total |
| Top 10 = 89.9% | Same computation, top 10 by commission |
| Eight producing but off-roster | Eight `publisherId` values present in transactions, absent from the roster response |
| 3,628 transactions | Unique by `id` after dedup across the 12 chunked windows |
| Read-only | `skills/dormant-programme-sweep/SKILL.md`; the sweep calls only `list_media_partners` and `list_transactions` |

**Deliberately not claimed:**

- **Not "474 dormant partners."** Awin's advertiser API exposes no
  relationship-status field, so a non-producing publisher may be an active
  partner having a quiet year, a lapsed relationship, or a signup that never
  activated. Every post says "produced a sale" or "producing", never "active"
  or "dormant". `partner-roster-audit` is the skill that reads relationship
  status, and it does so from the browser precisely because the API cannot.
- **No currency symbol.** The transaction rows came back with a null currency
  field, so the 33,367.33 total is never shown with £ or $ anywhere. It does not
  appear on the card or in any post.
- **No benchmark.** 90.5% is one programme, one window. Nothing claims it is
  typical; cross-tenant comparison is gated on PR #403 and out of scope.

## Note on the numbers that were suggested

The brief was 2,415 joined / 1,587 earning. Those are not used. 1,587 earning
would have been an invented result presented as a finding, which is the exact
problem holding up #408 and #439, and 66% of partners producing would read as
implausible to anyone who knows the space. The real figure is 9.5%, it is
stronger, and it is sourced line by line above.

## Publisher-side posts (held)

The publisher-side variants — 2,415 joined programmes on a dev Awin account, and
the missing join-date field — are kept in this bundle's history and can run in a
later week. They need no third-party permission, so they are the fallback if the
brand-side data cannot be cleared.

## Notes

- Links in the first comment, not the body. No emoji, sentence case, UK English.
- "Automate the drudgery" appears once across the three posts, on the launch.
- `site/go/publisher-sweep.html`, `off-roster.html`, and `two-numbers.html`
  redirect to `hosted.html`, matching the existing pages.
