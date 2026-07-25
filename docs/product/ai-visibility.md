# AI visibility: the cross-reference layer

> Status: Proposal. Direction only. It does not authorise implementation. The
> boundary questions it raises are recorded in
> [`../decisions/2026-07-25-ai-visibility-boundary.md`](../decisions/2026-07-25-ai-visibility-boundary.md),
> which must be accepted before any code lands.

## The problem, stated as a channel problem

LLMs scrape and cite publisher pages. Those citations influence purchases. Almost
none of it appears in affiliate tracking, because there is no click to attribute.

The size of the gap is now measured, not speculated. Partnerize's 2026 Zero-Click
Commerce Index compared publisher influence inside AI-generated answers against
activity captured by conventional click-based affiliate tracking, and found
publisher influence through Google AI Overviews averaged **3.84 times** the
activity visible through traditional attribution. LQ Digital's Q1 2026 analysis
of more than 100,000 AI-generated responses across Google AI Overviews, ChatGPT,
Claude, Gemini, and Perplexity found **18.7%** of cited sources are directly
influenceable by brands through affiliate and content partnerships.

So this is not an SEO topic that happens to touch affiliate. Click-based
affiliate attribution systematically undercounts what publishers actually
contribute, and the undercounted portion is the part brands can influence through
the affiliate channel specifically.

## Citation data is arriving. Nobody is joining it up.

Several parties are already producing citation data:

- **Networks.** Partnerize publishes the Zero-Click Commerce Index with a
  proprietary HaloIndex metric. impact.com published analysis in January 2026 on
  offsite content and AI citation. More networks will follow, each with its own
  metric, its own dashboard, and its own definition.
- **Agencies.** Acceleration Partners published guidance in May 2026 on using AI
  citation data to recruit, brief, and prioritise affiliate publishers, reporting
  that 28% of a travel brand's active affiliate partners appeared in AI citation
  data within a single measurement week.
- **GEO vendors.** Profound, Peec AI, Otterly, and others track brand and domain
  citations across engines and sell it as a subscription.

Every one of these produces citation data in an incompatible shape, scoped to one
network or one vendor's prompt set, and none of them holds the operator's full
programme roster across networks.

**That join is our role.** This repo already exists because affiliate truth is
scattered across 86 adapters in incompatible shapes and somebody has to normalise
it. Citation data is the same problem arriving one layer up. We are the place
where "these domains get cited" meets "here is every partner I have, on every
network, and what each one earns me".

## What we should build

### 1. The cross-reference, via multi-MCP composition

We do not need to acquire citation data to join it. The MCP client can hold more
than one server, and the GEO vendors are already exposing themselves that way:
Peec AI ships an MCP server for querying AI search visibility in natural
language, and Otterly lists MCP alongside its API on its features page.

So the pattern is: the operator runs their GEO vendor's MCP server alongside
affiliate-mcp, and the assistant joins the two. The vendor supplies citations. We
supply the roster and the commercial truth. Neither product depends on the other,
the operator keeps whichever vendor they already pay for, and we add no
dependency, no vendor contract, and no credential custody.

Our job in that arrangement is to be **joinable**: stable domain keys, honest
coverage, and a workflow that knows what to do with the result. The output is
three buckets:

| Bucket | Meaning | Affiliate action |
| --- | --- | --- |
| Cited, active partner | Already producing, and assistants surface them | Protect; consider a commission uplift or exclusive offer |
| Cited, dormant or pending partner | Relationship exists but is inactive or undecided | Reactivate, or decide the pending application |
| Cited, not in the programme | Assistants recommend them, we have no relationship | Recruitment list, ranked by citation frequency |

This composes existing tools only: `affiliate_resolve_brand`,
`affiliate_list_networks`, `affiliate_run_diagnostic`,
`affiliate_<network>_list_media_partners`, and
`affiliate_<network>_get_programme_performance`. No new MCP tool surface.

Where the operator has no GEO vendor, the host assistant's own web access is the
zero-setup fallback. It is a weaker sample, and must be labelled as one. The
precedent exists: `skills/audit-affiliate-links/SKILL.md` already offloads
sitemap and document reading to the host and uses `affiliate_*_get_programme`
only for verification.

### 2. Network citation data, when networks ship an API

Partnerize is furthest along, and others will follow. When a network exposes AI
citation data through an API, it belongs behind the same typed adapter contract
as everything else, with the same claim-status honesty.

We should not add a canonical operation for it yet. The standing repo rule is not
to create a cross-network abstraction until at least two networks prove the
concept is genuinely shared, and right now the metrics are proprietary and
mutually incomparable. Partnerize's HaloIndex is not impact.com's analysis is not
a vendor's share of voice. Normalising them prematurely would invent
comparability that does not exist.

The right posture is to watch for the second network, keep the shape in mind, and
in the meantime treat network citation reports as per-network surfaces.

### 3. Close the attribution gap where we already can

Two concrete pieces of plumbing, both useful beyond AI visibility.

**Referrer classification, where the data exists.** `Click.referrer`
(`src/shared/types.ts:316`) can be classified against assistant origins
(`chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `gemini.google.com`,
`copilot.microsoft.com`, `claude.ai`, and comparable). This works on ten of
eighty-six adapters. See the table below.

**Sub-id reads, which reach the large networks.** Several networks let a
publisher stamp their own identifier on a link at generation time. A publisher
who tags links placed in AI-facing content can self-attribute AI traffic on
networks that expose no referrer at all, Awin included. This is currently
half-built: sub-ids are write-side or raw-only everywhere, and no adapter reads
one back onto a `Click` or `Transaction`.

- Awin's `clickRef` round-trip is incomplete. `src/networks/awin/endpoints/links.ts`
  sets `clickref1` to `clickref6` on generation and
  `endpoints/transactions.ts` filters `listTransactionQueries` by `clickRefs`,
  but `AwinTransactionRaw` never reads a `clickRef` back, so the value Awin does
  return is dropped.
- Impact's `listClicks` already calls an endpoint supporting `SubId1`, `SubId2`,
  and `SharedId`, and does not request them.
- `BrandTxnRow.subId` (`src/brand-data/model.ts:74`) is declared and documented as
  best-effort, but `normalise.ts` never sets it. It is a dead field.

Other networks with sub-id support that is write-side only: Tradedoubler
`epi1` / `epi2`, Skimlinks `customId`, Admitad `subid`, AdCell `subId`, Webgains
`clickref`, Coupang Partners `subId`.

Completing the read side is the better investment of the two, because it reaches
the networks that matter most.

## Data availability: the honest table

**Ten of eighty-six adapters implement `listClicks` at all, and all ten populate
`referrer`.** The remaining seventy-six throw `NotImplementedError`.

| Adapter | Side | Upstream referrer field |
| --- | --- | --- |
| `impact` | publisher | `ReferringUrl` (also `LandingPageUrl`) |
| `partnerize` | publisher | `referer` |
| `everflow` | publisher | `referer` |
| `everflow-advertiser` | advertiser | `referer` |
| `scaleo` | publisher | `referer` / `referrer` |
| `ehub` | publisher | `referer` / `referrer` |
| `yieldkit` | publisher | `referrer` / `source` |
| `addrevenue` | publisher | `referrer` / `referrerUrl` |
| `ebay` | publisher | `referrerUrl` |
| `tradetracker` | publisher | `refererUrl` |

Only Impact and Partnerize carry meaningful publisher-side scale. Every large
network is structurally unable: Awin, CJ, Rakuten, ShareASale, Skimlinks,
Tradedoubler, Admitad, Webgains, Daisycon, and FlexOffers all decline click rows.
Awin's own wording is "Awin does not expose click-level data via the public
publisher API"; adservice's is "aggregate click counts only; no row-level
click-event endpoint (per-click timestamp/referrer)". Networks publish click
*counts*, not click *rows*.

Two further constraints:

- `Transaction` carries no referrer, URL, or traffic-source field on any network,
  by design. `dateClicked` is the only click-side link, so a referral-to-revenue
  join is by date, not identity.
- `ClickQuery` (`src/shared/types.ts:437`) has no referrer filter, so detection is
  a client-side scan over a full pull, bounded by the 800 KB result budget in
  `src/tools/result-guard.ts` and per-network window caps, for example Everflow's
  fourteen-day maximum, 5,000 clicks per request, and three-month retention.

Note the asymmetry this creates. Referrer classification is weakest on the
networks where the roster cross-reference is strongest, because the cross-reference
needs `listMediaPartners` rather than clicks. The two parts of this proposal
complement each other rather than stacking.

## The join key problem

Cross-referencing citations against partners means matching a domain to a partner,
and that is not a lookup. `MediaPartner` (`src/shared/types.ts:377`) is
`{ id, name, status, rawNetworkData }` with no website or domain field.

A `registrableDomain` helper (eTLD+1, `www` stripped) already exists per-adapter,
for example `src/networks/awin-advertiser/adapter.ts:413`, and its own comment says
the PSL-accurate version belongs in the shared brand resolver. Promoting it into
`src/shared/brand-resolver.ts` and reading partner domains from `rawNetworkData`
per network is the right move. `src/shared/types.ts` is frozen, and the brand-data
layer already established that derived shapes live in their own module.

This is load-bearing rather than incidental: under multi-MCP composition the
domain is the join key between two independent servers, so it has to be stable and
correct.

## What we should refuse to build

- **No affiliate-mcp AI-visibility score, index, or share of voice.** A prompt
  sample on one date is an observation, not a metric. Publishing one would invent
  data and it would be quoted back at us in client decks. Every citation-derived
  output carries its source, prompt set, engine, and date.
- **No crawler and no SERP scraping.** API-first, or the user's own session.
- **No reselling a vendor's data.** We join what the operator already has. We do
  not store, cache, or redistribute vendor citation data.
- **No LLM API calls with the user's keys in this round.** A new credential class
  needs its own decision record.
- **No premature canonical citation operation.** Not until two networks prove the
  concept is shared, per the standing rule.
- **No dashboard.** `roadmap.md` §12 item 7 lists rich dashboards under "do not
  build yet", and `solo-50k-technical-roadmap.md` excludes dashboards and BI
  because the AI client is the interface.

## Cohort value

- **Advertisers, brands, and agencies.** A recruitment and reactivation worklist
  derived from where assistants already point buyers, spanning every network they
  run rather than one network's report.
- **Publishers.** Whether assistants send traffic and whether it converts, on the
  networks that can answer, plus a self-tagging route on those that cannot.
- **Semi-technical operators.** Delivered as a skill, so no endpoint knowledge is
  needed.
- **Developers and data teams.** A typed, derived classification and a stable
  domain key to build on.
- **Affiliate network employees.** A concrete argument for exposing click rows,
  sub-id reads, and citation data through an API rather than a PDF.

## Open questions for the maintainer

1. **Is multi-MCP composition the right bet?** It assumes operators will run a GEO
   vendor's MCP alongside ours rather than expecting us to acquire citation data.
   It is cheap and it composes, but it makes the workflow depend on a server we do
   not control.
2. **Which vendor to validate against first?** Peec AI has a shipped MCP server
   and is the obvious first test. Confirming the shape of its output is a
   prerequisite to writing the skill against it.
3. **Sequence sub-id reads before referrer classification?** More work, but it
   reaches Awin and the other large networks and pays off beyond this feature.
4. **How hard to push the network-side ask?** We are well placed to argue publicly
   that networks should expose citation data through APIs. That is a positioning
   decision, not an engineering one.
5. **Free, gated, or a lead magnet?** The roster half needs credentials, so a
   credential-free public version is deliberately weaker.

## Sources

- [Partnerize 2026 Zero-Click Commerce Index, via Affiverse](https://www.affiversemedia.com/ai-search-affiliate-attribution-gap-report/)
- [LQ Digital Q1 2026 Report: Affiliate Opportunities in AI Search](https://www.pr.com/press-release/965244)
- [Acceleration Partners, using AI citation data to recruit, brief, and prioritise publishers](https://www.accelerationpartners.com/resource/how-to-use-ai-citation-data-to-recruit-brief-and-prioritize-affiliate-publishers/)
- [Acceleration Partners, your affiliate programme is shaping AI recommendations](https://www.accelerationpartners.com/resource/your-affiliate-program-is-shaping-ai-recommendations-here-is-what-to-do-about-it/)
- [Peec AI MCP and API access](https://peec.ai/comparison/peec-vs-profound)
- [AI visibility platform comparison, including MCP support](https://surferstack.com/guides/promptwatch-mcp-vs-peec-ai-vs-otterly-ai-which-platform-has-the-most-complete-mcp-integration-in-2026)
- [Digiday, AI visibility is no longer about referral traffic](https://digiday.com/media/in-graphic-detail-ai-visibility-is-no-longer-about-referral-traffic/)
