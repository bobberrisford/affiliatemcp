# Blitz #2 — hosted push

**Channel:** Rob's LinkedIn profile only (`robertberrisford`). The Agentic
Affiliate company page is **not** used this run.

**Cadence:** 7 posts over 5 days, 1–2 a day.

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
- Line 1 is an outcome or a story, never a spec. It also does all the work —
  LinkedIn truncates after roughly two lines.
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

> I spent months making sure this software never touched anyone's affiliate credentials.
>
> Then I built the thing that holds them.
>
> The local server is free, open source, and runs on your own machine. Your keys never leave it. That is not changing, and it covers anyone who can follow a terminal.
>
> It does not cover the agency account manager with eight brands who is not allowed to install anything. It does not cover the publisher whose Monday report needs to exist before they have opened the laptop. Those are the people the drudgery costs the most, and local-first was quietly telling them to go away.
>
> So there is a hosted tier now. You ask what you earned, what you are owed, or what moved this week, and it answers from your own live data — with nothing installed, and whether or not your machine happens to be on.
>
> I am not going to pretend the trade-off disappeared. Doing that for you means I hold your keys. The security page now says exactly what that means, including the parts that lose me deals.
>
> Three reports a week, free, no card.
>
> Automate the drudgery.

**First comment:** `Hosted, and what it does and doesn't do: https://agenticaffiliate.ai/go/why-i-hosted-it`

---

## 2 · Thu 30 Jul, 08:00 — the security page was wrong
link: `agenticaffiliate.ai/go/security-page-was-wrong`

> Our security page told brands we had no hosted service. We had already launched one.
>
> It is the page an agency reads before they trust you with anything. It said, in as many words: no hosted service, no account, the vendor never receives your credentials. Meanwhile the hosted tier was live and holding network API keys in a vault.
>
> No one raised it with me, which is the part worth sitting with. A page like that does not generate complaints. The people it matters most to read it, believe it, and quietly go elsewhere.
>
> It is rewritten. Every answer is now given twice, once for local and once for hosted, and the hosted column includes the things I would rather not print: the vault master key is a Worker secret rather than a KMS. There is no SOC 2. There is no ISO 27001. There is no DPA on offer. Self-serve export is not built yet.
>
> If your procurement needs any of those, use the local server. It does the same job with no vendor relationship at all, and it is free.
>
> A security page that only contains good news is not a security page. It is marketing with a padlock on it.

**First comment:** `The rewritten page, both tiers: https://agenticaffiliate.ai/go/security-page-was-wrong`

---

## 3 · Thu 30 Jul, 16:30 — answered before the call ended
link: `agenticaffiliate.ai/go/answered-in-the-thread`

> A client asks how their programme is doing. Right now that question costs you the rest of the afternoon.
>
> Log into the network, set the date range, export, open the export, remember that this one reports reversals differently, build the comparison against last quarter, spot a number that looks wrong, go back and check it, write the summary, send it. By which point they have half-forgotten they asked.
>
> Point the question at Claude instead and it comes back with the revenue, the trend against the previous window, which partners moved it, and a first draft of what you would actually say to them. From live data. No export step, because there is no export step.
>
> The part I did not expect is that it changes which questions get asked at all. When an answer costs forty minutes you only ask the ones you have to. When it costs twenty seconds you start asking the ones you were merely curious about, and that is where the useful stuff turns out to be.
>
> Free tier is three of those sessions a week, no card. That is enough to find out whether your Monday looks different.

**First comment:** `Ask your own data: https://agenticaffiliate.ai/go/answered-in-the-thread`

---

## 4 · Fri 31 Jul, 08:00 — no card, no call
link: `agenticaffiliate.ai/go/three-reports-no-card`

> I have never once come away from a software demo call thinking that was a good use of my afternoon.
>
> So there isn't one. Three reports a week, free, no card, no "book a slot with our team". The free tier exists because you should watch your own data come back before you pay anyone anything. Not a sandbox. Not sample numbers. Your Awin account, your commissions, in Claude, in about five minutes.
>
> A report is one 30-minute working session, not one question. Open a window, ask as much as you like inside it. Three of those a week, on a rolling seven days.
>
> If it is useful, the paid tiers lift the cap and add the scheduled work — the anomaly watch, the unpaid-commission digest, the things that only pay off when they run without you.
>
> If it is not useful, you have lost five minutes and given nobody your card details.
>
> I have sat through enough affiliate tooling demos to know which of those two things vendors are usually optimising for.

**First comment:** `Start free: https://agenticaffiliate.ai/go/three-reports-no-card`

---

## 5 · Mon 3 Aug, 08:00 — the networks I turned down
link: `agenticaffiliate.ai/go/networks-i-turned-down`

> I turned down more networks than I turned on, and it is going to annoy people.
>
> Hosted supports four. The local server supports dozens. Awin, CJ Affiliate, Impact, and Rakuten Advertising are the four I will hold keys for. They are the ones whose terms I have actually checked and whose adapters are mature enough to run unattended, on a schedule, without me watching.
>
> Everything else stays local-only. Not because those networks are worse — several have perfectly good APIs — but because "I built an adapter" and "I will take custody of your credentials for this" are different sentences, and I am not going to blur them to make a pricing page look better.
>
> There is a related thing worth saying out loud. All four of these networks issue full-access API tokens rather than scoped read-only ones. That is their limitation rather than my choice, and it is why the guidance is to generate a key dedicated to this connection, so you can revoke it without disturbing anything else.
>
> If your network is not on that list, the free local server covers it today, and it always will.

**First comment:** `The four, and why: https://agenticaffiliate.ai/go/networks-i-turned-down`

---

## 6 · Mon 3 Aug, 16:30 — the laptop-shut problem
link: `agenticaffiliate.ai/go/laptop-shut`

> Every piece of affiliate reporting automation has the same failure mode: it only runs when you are already at your desk.
>
> Which means it is not automation. It is a faster version of you doing it.
>
> The Monday brief that matters is the one that already exists when you open the laptop. The reversal spike you want to hear about is the one caught on Saturday, not the one you find on Tuesday while looking for something else. Neither of those works if the thing doing the checking lives on a machine that is asleep.
>
> That is the entire reason hosted exists. Not more features. The same server, the same open-source adapters, the same seven operations — running somewhere that does not close its lid.
>
> The local server is still the right answer for most people, and it is free. But if your reporting has ever been late because you were on a train, that is the wall, and it is not a discipline problem.

**First comment:** `https://agenticaffiliate.ai/go/laptop-shut`

---

## 7 · Tue 4 Aug, 08:00 — demo
link: `agenticaffiliate.ai/go/demo-unpaid`

> "How much am I owed right now that I have not been paid?"
>
> Most operators cannot answer that in under an hour, and it is not because they are disorganised. The answer is spread across every network they work with, each one showing its own slice, none of them adding up.
>
> The card below is a demo, with sample figures — I am not passing off invented numbers as a real account. What is real is the shape of it: one question, every connected network swept, commissions classified by what the networks' own records say, itemised per network and per currency. Any network that failed to respond is listed at the top rather than quietly dropped from the total, because a wrong total is worse than a short one.
>
> Then it drafts the chase email for each one. Sending stays with you.
>
> That is the whole pitch. Not a prettier view of your data. The work you were going to do on Thursday, done, waiting for you to approve it.
>
> Automate the drudgery.

**First comment:** `Run it on your own numbers, free: https://agenticaffiliate.ai/go/demo-unpaid`

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
