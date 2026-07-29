# Blitz #2 — hosted push

**Channel:** Rob's LinkedIn profile only (`robertberrisford`). The Agentic
Affiliate company page is **not** used this run.

**Cadence:** 10 posts over 5 working days, never more than 2 a day.

Seven hosted posts plus three build-in-public posts. Blitz #1's two best
performers (591 and 577 impressions) were both founder posts about the work
itself, beating the feature posts roughly 2:1, so the genre earns its slots.

## Why this shape

Blitz #1 (20–24 July) is measurable, and it argues for a smaller run:

| | Rob's profile | Company page |
| --- | --- | --- |
| Posts | 20 | 20 |
| Impressions | 129–591, mean ~310 | 2–48, mean ~20 |
| Best post | 591 ("Why is this my job? I'm one developer") | 48 |
| By Friday | 129–189 | 2–5 |

Two findings drive blitz #2:

1. **The company page has no audience yet.** Twenty posts earned it a mean of
   ~20 impressions, decaying to 2 by Friday. Mirroring every post there doubled
   the review burden for nothing. Dropped until the page has followers.
2. **Frequency burned reach.** At 3–4 posts a day, profile impressions roughly
   halved across the week. This run is 1–2 a day.

And one about content, which is also why this run is written the way it is:
**founder voice and candour beat feature posts about 2:1.** The five best performers were all first-person, and three of them were
about a problem rather than a capability. The run below is ordered accordingly —
the honest posts lead, the feature posts follow.

## Rules for this run

- **Value, not features.** Every post names the work the reader stops doing,
  not the mechanism that does it. Encryption, OAuth, vaults and network counts
  appear only where they answer an objection, never as the subject. If a post
  could be summarised as "here is a thing we built", it is rewritten.
- **350 to 500 characters, 600 ceiling.** The first draft of this run came in
  at 900 to 1,100 and was rejected as too long and AI sloppy. See the "How a
  post is written" section of `.claude/skills/affiliate-mcp-marketing/SKILL.md`
  for the banned constructions; the short version is no em dashes, no
  semicolons, no "it isn't X, it's Y", contractions throughout.
- Line 1 is an outcome or a story, never a spec. It also does all the work,
  because LinkedIn truncates after roughly two lines.
- Links go in the **first comment**, never the post body.
- UK English. No emoji. Sentence case. No "Thoughts?" at the end.
- One real number per post. Anything illustrative is labelled a demo **in the
  post body**, not just in the alt text.
- Networks are partners. Nothing here punches at Awin, CJ, Impact or Rakuten.
- Name the drudgery, not the dashboard.
- Hosted is the call to action in every post. Local is mentioned where honesty
  requires it, and never as the thing being sold.

## Attribution: one link per post, no tracking parameters

Cloudflare Web Analytics deliberately does not log query strings, so a
`?utm_content=` scheme would have given us nothing. Each post instead gets its
own path, which redirects to the destination. Cloudflare reports paths, so the
path *is* the attribution — and nothing follows the reader around.

```
https://agenticaffiliate.ai/go/<slug>
```

| # | link | lands on |
| --- | --- | --- |
| 1 | `/go/why-i-hosted-it` | hosted.html |
| 2 | `/go/security-page-was-wrong` | security.html |
| 3 | `/go/answered-in-the-thread` | hosted.html |
| 4 | `/go/three-reports-no-card` | hosted.html |
| 5 | `/go/networks-i-turned-down` | hosted.html |
| 6 | `/go/laptop-shut` | hosted.html |
| 7 | `/go/demo-unpaid` | hosted.html |

Built in PR #419. Each page is `noindex` with a canonical to its destination.

---

## 1 · Wed 29 Jul, 08:00 — the contradiction
link: `agenticaffiliate.ai/go/why-i-hosted-it`

> Spent months making sure this never touched anyone's API keys.
>
> Then I built the bit that holds them.
>
> The local server is still free, still open source, keys never leave your machine. That covers anyone who can use a terminal.
>
> It doesn't cover the agency AM with eight brands who isn't allowed to install anything. That's who hosted is for.
>
> And yes, it means I hold your keys. The security page says exactly what that's worth, including the parts that lose me deals.
>
> Three reports a week, free, no card.
>
> Automate the drudgery.

**First comment:** `Hosted, and what it does and doesn't do: https://agenticaffiliate.ai/go/why-i-hosted-it`

---

## 2 · Thu 30 Jul, 08:00 — the security page was wrong
link: `agenticaffiliate.ai/go/security-page-was-wrong`

> Our security page told brands we had no hosted service.
>
> We'd already launched one.
>
> That's the page an agency reads before they trust you with anything. Nobody complained. They just quietly went elsewhere, which is worse.
>
> It's rewritten. Every answer twice, local and hosted, including the parts I'd rather not print. Master key is a Worker secret, not a KMS. No SOC 2. No ISO 27001. No DPA.
>
> Need any of those? Use the local server. It's free and I hold nothing.
>
> A security page with only good news isn't a security page.

**First comment:** `The rewritten page, both tiers: https://agenticaffiliate.ai/go/security-page-was-wrong`

---

## 3 · Thu 30 Jul, 16:30 — answered before the call ended
link: `agenticaffiliate.ai/go/answered-in-the-thread`

> A client asks how their programme's doing.
>
> There goes your afternoon. Log in, set the range, export, remember this one counts reversals differently, build the comparison, spot a number that looks wrong, go back and check it, write it up.
>
> Ask Claude instead and you get the revenue, the trend, which partners moved it, and a draft of what you'd actually say. Live data. No export.
>
> Strange side effect. You start asking the questions you were only mildly curious about, and that's where the useful stuff turns out to be.
>
> Three sessions a week, free, no card.

**First comment:** `Ask your own data: https://agenticaffiliate.ai/go/answered-in-the-thread`

---

## 4 · Fri 31 Jul, 08:00 — no card, no call
link: `agenticaffiliate.ai/go/three-reports-no-card`

> I've never once come out of a software demo thinking that was a good use of an afternoon.
>
> So there isn't one.
>
> Three reports a week. Free. No card. No quick chat with the team.
>
> A report is a 30 minute session, not one question. Ask as much as you want inside it.
>
> If it's useful, paid lifts the cap and adds the scheduled work. If it isn't, you've lost five minutes and given nobody your card details.

**First comment:** `Start free: https://agenticaffiliate.ai/go/three-reports-no-card`

---

## 5 · Mon 3 Aug, 08:00 — the networks I turned down
link: `agenticaffiliate.ai/go/networks-i-turned-down`

> I turned down more networks than I turned on.
>
> Hosted does four. Awin, CJ, Impact, Rakuten. The local server does dozens.
>
> Those four are the ones whose terms I've actually read, and whose adapters I'd trust to run unattended.
>
> "I built an adapter" and "I'll take custody of your credentials" are different sentences. I'm not blurring them to make a pricing page look fuller.
>
> Worth knowing: all four only issue full-access tokens. Their limitation, not my choice. Generate a dedicated key so you can revoke it cleanly.
>
> Not on the list? Local covers it. Free, and always will.

**First comment:** `The four, and why: https://agenticaffiliate.ai/go/networks-i-turned-down`

---

## 6 · Mon 3 Aug, 16:30 — the laptop-shut problem
link: `agenticaffiliate.ai/go/laptop-shut`

> Most affiliate reporting automation only runs when you're already at your desk.
>
> That isn't automation. That's you, slightly faster.
>
> The Monday brief worth having is the one already sitting there when you open the laptop. The reversal spike worth catching is the Saturday one.
>
> Neither happens if the thing doing the checking is asleep in your bag.
>
> That's the whole reason hosted exists. Same server, same adapters, somewhere that doesn't shut its lid.

**First comment:** `https://agenticaffiliate.ai/go/laptop-shut`

---

## 7 · Tue 4 Aug, 08:00 — demo
link: `agenticaffiliate.ai/go/demo-unpaid`

> "How much am I owed right now?"
>
> Most people can't answer that in under an hour. Not because they're disorganised. The answer is split across every network they work with and none of them add up.
>
> The card below is a demo with sample numbers. I'm not passing invented figures off as a real account.
>
> What's real is the shape. One question, every network swept, itemised per network and currency. Anything that failed to respond gets listed, not quietly dropped from the total.
>
> Then it drafts the chase emails. Sending is still you.

**First comment:** `Run it on your own numbers, free: https://agenticaffiliate.ai/go/demo-unpaid`

---

## 8 · Wed 29 Jul, 16:30 — build in public: the green CI
link: `agenticaffiliate.ai/go/green-ci`

> My CI has been green every day for a week.
>
> Today I read the logs properly. It was skipping the test.
>
> A secret wasn't set, so the job printed "not provisioned, skipping" and exited zero. Green tick, nothing run. Six days of that.
>
> The badge wasn't lying. It just wasn't saying what I assumed it said.
>
> Go and open one of your green runs. Read it, don't glance at it.

**First comment:** `Open source, so you can check mine: https://agenticaffiliate.ai/go/green-ci`

---

## 9 · Fri 31 Jul, 16:30 — build in public: the analytics plan that couldn't work
link: `agenticaffiliate.ai/go/utm-doesnt-work`

> Wrote a whole analytics plan around UTM tags. Got as far as building it before I checked whether it worked.
>
> Cloudflare Web Analytics doesn't log query strings. On purpose, for privacy. So every utm_content I'd planned would have recorded precisely nothing.
>
> The fix is better than the original. Each post links to its own path instead. Cloudflare reports paths, so the path is the attribution, and nothing follows the reader around.
>
> The privacy default I nearly worked around turned out to be the better design.

**First comment:** `The decision record, including the correction: https://agenticaffiliate.ai/go/utm-doesnt-work`

---

## 10 · Tue 4 Aug, 16:30 — build in public: the wrong number
link: `agenticaffiliate.ai/go/wrong-number`

> My own homepage had the wrong number on it.
>
> It said 64 networks. The README said 72 networks, 86 adapters. Both had been sitting there for weeks.
>
> Counted the directories today. 86 adapters across 72 network families. One production, three partial, the rest experimental.
>
> Nobody had pulled me up on it. That's the thing about a number on a marketing page. It doesn't get checked, it gets repeated.

**First comment:** `The full per-network list: https://agenticaffiliate.ai/go/wrong-number`

---

## Before scheduling — blockers

- [ ] **Stripe gate.** Posts 1, 4 and 5 reference the paid tiers. If Stripe is
      still on test keys, posts 4 and 5 need the paid sentence cut and post 1's
      "three reports a week, free" stands on its own.
- [ ] **Post 2 is contingent on PR #415 merging.** It says the security page is
      rewritten. Do not post it while the live page still says "no hosted
      service".
- [ ] **Post 7 needs a card.** Either the week-03 unpaid-commission card,
      re-captioned so "demo" is in the post body as written above, or a new
      1080×1080 under `docs/product/launches/week-06-hosted-push/`.
- [ ] **Posts 1, 3, 5, 6 would each benefit from a card.** Text-only is
      acceptable — two of blitz #1's better posts were text-only — but cards
      correlated with the top performers.
- [ ] **No network count claim.** Deliberately avoided: `site/index.html` renders
      `TOTAL=64` while the README badges say 72 networks / 86 adapters. Reconcile
      against `REPORT.md` before any post uses a total.
- [ ] **Do not market benchmarks.** The decision is accepted, the feature is not
      built, and the trust copy is unmerged.

## Claims used, and their source

| Claim | Source |
| --- | --- |
| Four hosted networks: Awin, CJ, Impact, Rakuten | `hosted/src/networks.ts` |
| Those four issue full-access tokens only | `site/hosted.html`, "the honest bits" |
| 3 reports/week, rolling 7 days, no card | `hosted/src/meter.ts` (`FREE_WINDOWS_PER_WEEK = 3`) |
| A report is one 30-minute session | `hosted/src/meter.ts` (`WINDOW_MS`) |
| Per-user AES-256-GCM, decrypted in memory only | `hosted/src/vault.ts` |
| Master key is a Worker secret, not KMS | `hosted/README.md`, vault threat model |
| No SOC 2 / ISO 27001 / DPA; no self-serve export | `docs/decisions/2026-07-27-hosted-trust-surface-and-web-analytics.md` |
| Scoped OAuth session, no token to paste | `hosted/src/oauth.ts`, `hosted/src/token.ts` |
| Local server free, open source, MIT | `LICENCE`, `README.md` |

## Claims deliberately not used

Carried over from blitz #1's own "confirm before posting" list, and still
unverified: the "three hours every Monday" figure, "a beta user told me I built
it backwards", the "first wave of operators this month" scarcity line, and the
claim that Everflow has shipped MCP. None appear above.

Two more were caught in drafting this run and rewritten rather than shipped:

- Post 3 was first written as "a client asked me and I answered on the call".
  There is no such client and no such call. It is now a second-person scenario,
  which makes the same point without inventing a customer.
- Post 2 said "nobody complained". Not knowable — an absence of complaints is
  not evidence of anything. Reworded to say what is actually true: a page like
  that does not generate complaints, it generates quiet departures.

The only first-person claims left are ones Rob can stand behind: that he built
the project local-first and then added hosted custody (documented in
`docs/decisions/2026-07-12-hosted-credential-custody.md`), that hosted supports
four networks out of 86 adapters, and an opinion about demo calls.
