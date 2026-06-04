# LinkedIn content plan — affiliate-mcp

A practical, evidence-based plan for growing awareness of `affiliate-mcp`
on LinkedIn. It covers what actually moves the needle on the platform in
2026, maps that to our three audiences, and lays out content pillars,
formats, a posting cadence, a 6-week starter calendar, reusable hooks,
and how we measure whether any of it is working.

This is a living document. Treat the calendar as a starting set, not a
contract — keep what earns saves and comments, cut what doesn't.

---

## 1. What works on LinkedIn in 2026

The platform changed in ways that happen to suit a project like ours
(technical, honest, niche). The short version, drawn from current
algorithm analysis:

- **Dwell time is the master signal.** LinkedIn scores *how long* people
  engage, not just whether they clicked. Posts that hold attention for
  61+ seconds see roughly **13x** the engagement of posts skimmed in
  under 3 seconds. Everything below follows from this.
- **Saves > comments > likes.** A save drives ~5x more reach than a like
  and ~2x more than a comment, because it signals lasting reference
  value. Reference-grade content (checklists, "how X actually works",
  setup walkthroughs) is exactly what we can produce credibly.
- **Comments are the strongest interaction signal.** Comment threads
  trigger reach expansion; specific, substantive comments carry 3–5x the
  weight of generic praise. Posts that *invite reflection or a reply*
  beat announcements.
- **Document/PDF carousels lead on engagement** (~6.6% average, the
  highest of any format) because every swipe is another retention
  signal. Native video (15s–2min, captioned) and medium-length text
  posts (150–400 words) follow.
- **External links are penalised (~60% reach cut).** Put links in the
  first comment or in a "link in comments" line, not the post body.
- **Engagement bait and pods are penalised / shadowbanned.** No "comment
  YES if you agree", no reciprocal-engagement rings. Ask *real*
  questions instead.
- **Educational content out-reaches promotion 3–5x.** Teach, don't sell.
- **Personal profiles get ~8x the engagement of company pages.** The
  founder/maintainer voice is the primary channel; the project page is a
  supporting asset.
- **Consistency beats volume.** 3–5 strong posts/week, fewer-but-better,
  outperforms daily filler.

### What this means for us specifically

We are an open-source, local-first, "honest about limitations" developer
tool sitting in a niche (affiliate operations) that has *no* AI-native
tooling yet. That is a gift for LinkedIn in 2026:

- Our natural content — setup walkthroughs, "what dashboards bury",
  network API teardowns, build-in-public notes — is inherently
  **save-worthy and dwell-heavy**, not promotional.
- We have **three distinct, reachable audiences** (publishers, brand/
  agency affiliate managers, affiliate-network staff) who live on
  LinkedIn and rarely get content aimed at them.
- "Bring your own keys, runs locally, no telemetry, MIT" is a **point of
  view** worth posting, not just a feature list — POV posts earn
  comments.

---

## 2. Audiences and the message that lands for each

| Audience | Who they are | What they want to hear | Primary CTA |
| --- | --- | --- | --- |
| **Publishers / affiliate creators** | Solo and small-team publishers earning across Awin, CJ, Impact, eBay, Rakuten, etc. | "Stop tab-hopping between 5 dashboards. Ask one question, get every network." | Try it: `npx affiliate-networks-mcp setup` |
| **Brand / agency affiliate managers** | In-house programme managers and agencies running multiple brands | "One question fans out across every brand × network. Catch the reversal spike before the QBR." | Try the brand-side skills; book a look |
| **Affiliate-network employees** | PMs, devs, partnerships staff at networks | "Your network has no AI workspace integration. Adopt the adapter; own how your API shows up." | Adopt your adapter (`adopt-this-network` issues) |
| **MCP / AI-dev community** | Builders curious about MCP, local-first AI tooling | "Here's a real-world MCP server: design choices, read-only safety, honest adapters." | Star the repo, contribute |

The first three are buyers/users; the fourth is amplification (they
reshare, star, and contribute, which feeds the algorithm and the repo).

---

## 3. Content pillars

Five pillars, rotated so no single week is all one note. Each maps to a
proven-performing format and at least one audience.

1. **Teach the workflow (40%)** — "How to audit every affiliate link in
   your sitemap in one prompt", "Find commissions pending >90 days
   across all networks". *Educational, save-worthy. Carousels + short
   video demos.* → Publishers, brands.
2. **Build in public (20%)** — release notes, a new network adapter
   shipped, a tricky API quirk we hit and how we handled it, contributor
   shout-outs. *Authentic, comment-friendly.* → MCP/dev community,
   network staff.
3. **Point of view (15%)** — local-first vs hosted, "why we refuse to
   fake unsupported endpoints", AI-native vs dashboard clones, the
   manifesto themes. *Opinion → discussion.* → All, especially network
   staff.
4. **Network teardowns (15%)** — "What Awin's public API actually
   exposes (and what it doesn't)", per-network setup gotchas. *Reference-
   grade, highly saveable.* → Publishers, network staff.
5. **Proof & stories (10%)** — anonymised "dashboards bury this"
   examples (dead deeplinks, reversal spikes, dead programmes), before/
   after of a real question answered in chat. → Brands, publishers.

---

## 4. Format strategy

Lead with the formats the algorithm currently rewards:

- **PDF / document carousels (highest priority).** 6–10 slides. Use for
  workflow teaching and network teardowns. Slide 1 = the hook, last
  slide = a soft CTA (repo URL spoken, link in comments). Design simple,
  high-contrast, one idea per slide.
- **Native video / screen-capture demos (30–90s, captioned).** Show the
  actual prompt → answer flow in Claude/Codex. Nothing sells a
  conversational tool like watching it answer a real question. Always
  add captions; many watch muted.
- **Medium text posts (150–400 words).** POV and build-in-public. Strong
  first 2–3 lines (the part shown before "see more"), one idea, end with
  a genuine question.
- **Single strong image / diagram.** Architecture sketches ("one
  question → 5 networks in parallel"), the data flow, "where your keys
  live".

Rules that apply to every post:

- **Links go in the first comment**, never the body. Post body can say
  "repo + setup in the comments".
- **First line is a hook**, not a preamble. Earn the "see more" click.
- **End with a real question** tied to the audience's world ("Which
  network's dashboard wastes the most of your time?").
- **Caption every video.**

---

## 5. Cadence and roles

- **Frequency:** 3–4 posts/week to start (Tue–Thu skew, mornings UK
  time), scaling to 5 only if quality holds.
- **Primary channel:** the maintainer's **personal profile** (8x the
  reach of a page). Posts written first-person.
- **Project page:** reshares maintainer posts, hosts release
  announcements and the canonical "what is affiliate-mcp" pinned post.
  Don't expect it to carry reach on its own.
- **Amplification:** a small set of contributors / friendly affiliate
  folks who genuinely find a post useful and comment substantively — not
  a pod. Real comments only.
- **Engagement window:** spend 20–30 min replying to comments in the
  first 90 minutes after posting; comment replies are themselves a reach
  signal.

A realistic weekly mix:

- 1× workflow carousel (pillar 1)
- 1× build-in-public or POV text post (pillar 2 or 3)
- 1× video demo or network teardown (pillar 1/4)
- 1× lighter story/proof or community reshare (pillar 5)

---

## 6. Six-week starter calendar

Three posts/week (Tue/Wed/Thu). Adjust freely once data comes in.

### Week 1 — Establish what this is

- **Tue · POV/text:** "Affiliate work is spread across 5 dashboards, 3
  spreadsheets and an inbox. AI workspaces are where work happens now —
  but affiliate data is stuck outside. Here's what we built." (manifesto
  framing) → Q: where does *your* affiliate data live?
- **Wed · Video demo (60s):** screen capture — "What did I earn across
  every network last month?" asked once, answered live.
- **Thu · Carousel (8 slides):** "5 questions you can finally ask your
  affiliate data" (one per slide, publisher-side).

### Week 2 — Publisher value

- **Tue · Carousel:** "Audit every affiliate link in your sitemap in one
  prompt" — the link-audit skill, step by step.
- **Wed · Text/POV:** "Your commission isn't 'missing' — it's pending 94
  days and no dashboard told you." → Q: what's the longest you've waited?
- **Thu · Video:** "Are all my affiliate networks healthy?" one-shot
  status check demo.

### Week 3 — Brand / agency side

- **Tue · Carousel:** "Running affiliate programmes for 6 brands? Ask one
  question, get all of them." (portfolio rollup)
- **Wed · Story/proof:** anonymised "the reversal spike the dashboard
  buried" — what an anomaly scan surfaced. → Q for agency folks.
- **Thu · Text/POV:** "Why our brand-side adapters are read-only on
  purpose" (the safety stance — refuses any non-GET before it leaves
  your machine).

### Week 4 — Build in public + trust

- **Tue · Text:** "Local-first, bring-your-own-keys, no telemetry, MIT.
  Here's exactly where your credentials live and why we won't host
  them." → strong POV, expect comments.
- **Wed · Build-in-public:** a real API quirk we hit (e.g. pagination,
  gated click data) and how the adapter handles it honestly.
- **Thu · Carousel:** "What Awin's public API actually exposes (and what
  it doesn't)" — first network teardown.

### Week 5 — Network teardowns + community

- **Tue · Carousel:** teardown #2 (CJ or Impact) — same template as
  Awin.
- **Wed · Build-in-public / call to action:** "Affiliate networks: you
  have no AI-workspace integration. Adopt your adapter and own how your
  API shows up." → tag the `adopt-this-network` path.
- **Thu · Video:** "Compare my earnings month on month" → turned into a
  sheet/artifact, showing the "do the next piece of work" angle.

### Week 6 — MCP/dev community + recap

- **Tue · Text (dev-leaning):** "Building a real MCP server: typed tools,
  honest adapters, read-only safety. What we learned." → MCP community.
- **Wed · Carousel:** "From 17 dashboards to one conversation" — the
  full network list and what each side supports.
- **Thu · Recap/POV:** "6 weeks of posting about AI-native affiliate
  data — here's what resonated and what's next." (meta, build-in-public,
  invites follows).

After week 6, double down on whichever pillar earned the most saves and
comments, and start recycling top performers into new formats (a carousel
that did well becomes a video; a video becomes a text breakdown).

---

## 7. Reusable hooks (first lines)

The first 2–3 lines decide everything. A bank to adapt:

- "You have 5 affiliate dashboards open right now. You only needed one
  question answered."
- "Your commission isn't missing. It's been pending 94 days and nothing
  told you."
- "Affiliate managers: the reversal spike that ruins your QBR is already
  in your data. Your dashboard just won't show it to you."
- "We refuse to fake support for endpoints that don't exist. Here's
  why that's a feature."
- "Bring your own keys. Runs on your machine. No telemetry. MIT. Here's
  where your credentials actually live."
- "I asked my affiliate data one question. It hit 5 networks in parallel
  and answered in 8 seconds."
- "If you work at an affiliate network: you have no AI-workspace
  integration. None of your competitors do either. Yet."

---

## 8. Measurement

Track weekly, in a simple sheet (or — fittingly — by asking Claude over
an export):

- **Leading signals:** saves per post (most important), comments (and
  whether they're substantive), dwell/impressions ratio, follower growth.
- **Mid signals:** profile views, repo traffic referred from LinkedIn
  (GitHub Insights → Traffic → Referring sites), `npx` install spikes
  after a post.
- **Lagging signals:** GitHub stars, new issues/PRs, `adopt-this-network`
  interest from actual network staff.

Review every 2 weeks. Promote the pillar/format with the best
saves-per-impression; retire the worst. Keep a running "greatest hits"
list to recycle.

### Definition of "working"

In the first 90 days, success looks like: a repeatable 3–4 posts/week
habit, a clear top-2 pillars by saves, measurable LinkedIn→GitHub
referral traffic, and at least one inbound from a network employee or
agency. Reach/followers are secondary to those.

---

## 9. Guardrails

- No engagement bait ("comment YES…"), no pods, no reciprocal rings.
- Links in the first comment, not the body.
- Never overstate the project: it's a public beta with `experimental`
  and `partial` adapters. Honesty is the brand — say "beta", say "read-
  only", say "this network doesn't expose clicks". That honesty is
  itself the differentiator and it earns trust-driven comments.
- Anonymise any real performance numbers in stories/proof posts.
- UK English in copy ("programme", "optimise"), matching the repo.
- Don't post the same asset to profile and page the same hour — reshare
  from page a day later.

---

## 10. Quick-start checklist

- [ ] Pick the maintainer profile as primary channel; optimise the
      headline + featured section to point at the repo.
- [ ] Create the project page; pin a "what is affiliate-mcp" post.
- [ ] Build the first 3 assets (Week 1: text, video demo, carousel).
- [ ] Set up a one-row-per-post tracking sheet (date, pillar, format,
      saves, comments, link clicks).
- [ ] Post Tue/Wed/Thu; reply to every comment within 90 min.
- [ ] Review after 2 weeks; keep what earns saves.

---

## Sources

LinkedIn algorithm and format research used to ground this plan:

- [LinkedIn Algorithm 2026: Engagement Strategy Guide — Digital Applied](https://www.digitalapplied.com/blog/linkedin-algorithm-2026-engagement-strategy-guide)
- [How the LinkedIn Algorithm Works (Updated for 2026) — Sprout Social](https://sproutsocial.com/insights/linkedin-algorithm/)
- [LinkedIn Algorithm Explained 2026: Dwell Time, Comments — meet-lea](https://meet-lea.com/en/blog/linkedin-algorithm-explained)
- [LinkedIn Algorithm 2026: What Works Now (Documents, Newsletters, Video) — Dataslayer](https://www.dataslayer.ai/blog/linkedin-algorithm-february-2026-whats-working-now)
- [LinkedIn Marketing Strategy 2026: Complete B2B Guide — La Growth Machine](https://lagrowthmachine.com/linkedin-marketing-strategy-2026/)
- [75 LinkedIn Content Ideas for B2B Brands (2026) — Linkboost](https://www.linkboost.co/blog/linkedin-content-ideas-b2b-brands-2026/)
- [LinkedIn Content Strategy for UK B2B Businesses — Softomate Solutions](https://www.softomatesolutions.com/blog/linkedin-content-strategy-uk-b2b/)
