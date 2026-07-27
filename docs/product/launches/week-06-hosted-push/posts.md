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

And one about content: **founder voice and candour beat feature posts about
2:1.** The five best performers were all first-person, and three of them were
about a problem rather than a capability. The run below is ordered accordingly —
the honest posts lead, the feature posts follow.

## Rules for this run

- Line 1 does all the work. LinkedIn truncates after roughly two lines.
- Links go in the **first comment**, never the post body.
- UK English. No emoji. Sentence case. No "Thoughts?" at the end.
- One real number per post. Anything illustrative is labelled a demo **in the
  post body**, not just in the alt text.
- Networks are partners. Nothing here punches at Awin, CJ, Impact or Rakuten.
- Name the drudgery, not the dashboard.

## UTM convention

```
https://agenticaffiliate.ai/hosted.html?utm_source=linkedin&utm_medium=social&utm_campaign=hosted-jul26&utm_content=<slug>
```

---

## 1 · Wed 29 Jul, 08:00 — the contradiction
`utm_content=why-i-hosted-it`

> I spent months making sure this software never touched anyone's affiliate credentials.
>
> Then I built the thing that holds them.
>
> The local server is free, open source, and runs on your own machine. Your keys never leave it. That is not changing, and it covers anyone who can follow a terminal.
>
> It does not cover the agency account manager with eight brands who is not allowed to install anything. It does not cover the publisher whose Monday report needs to exist before they have opened the laptop. Those are the people the drudgery costs the most, and local-first was quietly telling them to go away.
>
> So there is a hosted tier now. You connect a network in an encrypted dashboard, and the reports run whether your machine is on or not. Your keys sit in a per-user encrypted vault. Claude never receives them — it gets a scoped session, and that is all it gets.
>
> I am not going to pretend the trade-off disappeared. Choosing hosted means I hold your keys. The security page now says exactly what that means, including the parts that lose me deals.
>
> Three reports a week, free, no card.
>
> Automate the drudgery.

**First comment:** `Hosted, and what it does and doesn't do: <hosted.html?…why-i-hosted-it>`

---

## 2 · Thu 30 Jul, 08:00 — the security page was wrong
`utm_content=security-page-was-wrong`

> Our security page told brands we had no hosted service. We had already launched one.
>
> It is the page an agency reads before they trust you with anything. It said, in as many words: no hosted service, no account, the vendor never receives your credentials. Meanwhile the hosted tier was live and holding network API keys in a vault.
>
> Nobody complained. That is the part worth sitting with — the people it would have mattered most to were the ones who read it, believed it, and quietly moved on.
>
> It is rewritten. Every answer is now given twice, once for local and once for hosted, and the hosted column includes the things I would rather not print: the vault master key is a Worker secret rather than a KMS. There is no SOC 2. There is no ISO 27001. There is no DPA on offer. Self-serve export is not built yet.
>
> If your procurement needs any of those, use the local server. It does the same job with no vendor relationship at all, and it is free.
>
> A security page that only contains good news is not a security page. It is marketing with a padlock on it.

**First comment:** `The rewritten page, both tiers: <security.html?…security-page-was-wrong>`

---

## 3 · Thu 30 Jul, 16:30 — your keys never reach the model
`utm_content=keys-never-reach-claude`

> The most common question about hosted affiliate tooling is the right one: does the AI get my API keys?
>
> No. And it is worth explaining how, because "we take security seriously" is not an answer.
>
> Your network keys go into an encrypted dashboard. Each account gets its own AES-256-GCM data key. Credentials are decrypted in memory, at the moment a call runs, and never written back anywhere in plaintext.
>
> When you add the connector in Claude, Claude does an OAuth handshake and receives a short-lived, scoped session token. Not a key. Not a copy of a key. A token that lets it ask this service for your data, which the service then fetches using credentials Claude cannot see.
>
> There is no token to paste anywhere either, in either direction. Pasting secrets between browser tabs is how they end up in chat logs.
>
> You can revoke the network key from that network's own dashboard at any time, which cuts access regardless of anything on my side. That is the part I would want if I were you.

**First comment:** `How the flow actually works, with a diagram: <security.html?…keys-never-reach-claude>`

---

## 4 · Fri 31 Jul, 08:00 — no card, no call
`utm_content=three-reports-no-card`

> Three reports a week. No card. No demo call. No "book a slot with our team".
>
> The free tier on hosted exists because I think you should watch your own data come back before you pay anyone anything. Not a sandbox. Not sample numbers. Your Awin account, your commissions, in Claude, in about five minutes.
>
> A report is one 30-minute working session, not one question. Open a window, ask as much as you like inside it. Three of those a week, on a rolling seven days.
>
> If it is useful, the paid tiers lift the cap and add the scheduled work — the anomaly watch, the unpaid-commission digest, the things that only pay off when they run without you.
>
> If it is not useful, you have lost five minutes and given nobody your card details.
>
> I have sat through enough affiliate tooling demos to know which of those two things vendors are usually optimising for.

**First comment:** `Start free: <hosted.html?…three-reports-no-card>`

---

## 5 · Mon 3 Aug, 08:00 — four networks, and the line
`utm_content=four-networks`

> Hosted supports four networks. The local server supports dozens. That gap is deliberate and it is going to annoy people.
>
> Awin, CJ Affiliate, Impact, and Rakuten Advertising are the four I will hold keys for. They are the ones whose terms I have actually checked and whose adapters are mature enough to run unattended, on a schedule, without me watching.
>
> Everything else stays local-only. Not because those networks are worse — several have perfectly good APIs — but because "I built an adapter" and "I will take custody of your credentials for this" are different sentences, and I am not going to blur them to make a pricing page look better.
>
> There is a related thing worth saying out loud. All four of these networks issue full-access API tokens rather than scoped read-only ones. That is their limitation rather than my choice, and it is why the guidance is to generate a key dedicated to this connection, so you can revoke it without disturbing anything else.
>
> If your network is not on that list, the free local server covers it today, and it always will.

**First comment:** `The four, and what each one supports: <hosted.html?…four-networks>`

---

## 6 · Mon 3 Aug, 16:30 — the laptop-shut problem
`utm_content=laptop-shut`

> Every piece of affiliate reporting automation has the same failure mode: it only runs when you are already at your desk.
>
> Which means it is not automation. It is a faster version of you doing it.
>
> The Monday brief that matters is the one that already exists when you open the laptop. The reversal spike you want to hear about is the one caught on Saturday, not the one you find on Tuesday while looking for something else. Neither of those works if the thing doing the checking lives on a machine that is asleep.
>
> That is the entire reason hosted exists. Not more features. The same server, the same open-source adapters, the same seven operations — running somewhere that does not close its lid.
>
> The local server is still the right answer for most people, and it is free. But if your reporting has ever been late because you were on a train, that is the wall, and it is not a discipline problem.

**First comment:** `<hosted.html?…laptop-shut>`

---

## 7 · Tue 4 Aug, 08:00 — demo
`utm_content=demo-unpaid`

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

**First comment:** `Run it on your own numbers, free: <hosted.html?…demo-unpaid>`

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
