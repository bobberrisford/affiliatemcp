# AI visibility: we are the cross-reference layer, not a citation source

- **Date:** 2026-07-25
- **Status:** Proposed (decision pending)
- **Affects:** the product boundary for non-affiliate data sources, the
  multi-MCP composition posture, one new advertiser-side skill under `skills/`,
  the shared brand resolver (`src/shared/brand-resolver.ts`), a later derived
  classification module, and the read side of sub-id handling in individual
  network adapters. No change to `src/shared/types.ts`.
- **Builds on:** `2026-06-30-brand-data-layer.md` (derived shapes live in their own
  module; the count-honest partial-failure contract this record reuses),
  `2026-06-12-browser-handoff-contract.md` (reaching data an API cannot supply
  without this repo driving anything),
  `2026-06-18-action-capability-map.md` (readiness reporting), and
  `2026-07-12-hosted-credential-custody.md` (why a new credential class is not a
  casual addition).
- **Proposal:** [`../product/ai-visibility.md`](../product/ai-visibility.md)

## Context

LLMs cite publisher pages, those citations influence purchases, and click-based
affiliate tracking cannot see them. The gap is measured: Partnerize's 2026
Zero-Click Commerce Index found publisher influence through Google AI Overviews
averaged 3.84 times the activity visible through conventional attribution, and LQ
Digital found 18.7% of cited sources are directly influenceable through affiliate
and content partnerships.

Citation data is already being produced, by networks (Partnerize's HaloIndex,
impact.com's January 2026 analysis), by agencies (Acceleration Partners), and by
GEO vendors (Profound, Peec AI, Otterly). Each produces an incompatible shape,
scoped to one network or one vendor's prompt set. None holds the operator's full
programme roster across networks.

Three properties of this repo make the response a decision rather than an
implementation detail:

1. **There is no sanctioned outbound HTTP path for a non-affiliate source.**
   `AGENTS.md` restricts every outbound call to a per-network `client.ts` through
   `withResilience`, or to `auth.ts`. `src/core/skills.ts` is documented as
   local-first with no network. There is no web fetch, search, HTML parser, or
   scraper in `src/`; runtime dependencies are `@modelcontextprotocol/sdk`,
   `pino`, and `zod`. Acquiring citations ourselves would breach that floor.
2. **"Brand" in this codebase is a performance identity, not a market identity.**
   It means a slug in `brands.json` bound to network credentials. Conflating it
   with market presence would quietly change what a brand is.
3. **The measurement is inherently a sample**, varying by session, geography, and
   model version, and the product boundary forbids inventing data.

The decisive observation: measuring citations is crowded and replicable, but
joining citations to the operator's roster and per-partner performance across
every network they run is not. That join is the affiliate job, and it is the job
this repo already does one layer down.

## Decision

### 1. Citations are an input we join, never a product we acquire

We do not crawl, scrape SERPs, or sample answer engines. Citation data enters from
sources the operator already has:

- a GEO vendor's own MCP server, running alongside affiliate-mcp in the same
  client (Peec AI ships one; Otterly lists MCP on its features page);
- a network's own citation API, when one ships, behind the normal adapter contract;
- failing both, the host assistant's web access, as a weaker fallback that must be
  labelled a sample.

We never store, cache, or redistribute vendor citation data. The outbound-HTTP
floor stays intact and no new credential class is introduced.

### 2. Multi-MCP composition is the integration pattern

This is the architecturally significant part. The client, not this server, is the
join point. affiliate-mcp stays a thin provider of affiliate truth; the assistant
holds both servers and performs the cross-reference.

The consequence is a design obligation: **our outputs must be joinable.** That
means a stable, correct registrable domain for every partner, honest coverage
statements, and outputs shaped so a second server's data can be matched against
them. It also means we accept a dependency on a server we do not control, and must
degrade honestly when it is absent rather than silently producing a thinner
answer.

This is consistent with the standing rule that client integrations are thin
clients of shared contracts. We are not duplicating vendor behaviour inside our
domain layer; we are being a good citizen in a composed toolset.

### 3. No derived visibility score, ever

We publish no AI-visibility score, share-of-voice index, or ranking of our own.
Every citation-derived output carries its source, prompt set, engine, and
observation date, and is labelled a point-in-time sample. This is the citation
analogue of the brand-data rule that five canonical statuses are never silently
collapsed into three.

### 4. The user-facing outcome is a worklist, not a metric

The first deliverable is an advertiser-side cross-reference: cited domains against
the brand's roster, split into cited-and-active, cited-and-dormant-or-pending, and
cited-and-not-in-programme. The output is a recruitment, reactivation, and
application-decision worklist, consistent with `partner-outreach`,
`brand-application-shortlist`, `partner-roster-audit`, and
`partner-application-queue`. It composes existing tools only and adds no MCP tool
surface. Acceleration Partners' May 2026 guidance independently describes this
same use case, which is corroboration that the worklist is the useful artefact.

### 5. No canonical citation operation until two networks prove it shared

When networks expose AI citation data through APIs it belongs behind the typed
adapter contract with normal claim-status honesty. But we add no canonical
`AdapterOperation` for it yet. The standing rule is not to create a cross-network
abstraction until at least two networks prove the concept is genuinely shared, and
today the metrics are proprietary and mutually incomparable: Partnerize's
HaloIndex is not impact.com's analysis is not a vendor's share of voice.
Normalising them now would invent comparability that does not exist. Treat network
citation reports as per-network surfaces and watch for the second network.

### 6. Referral classification ships only where the data genuinely exists

Ten of eighty-six adapters implement `listClicks`, and all ten populate
`Click.referrer`: `impact`, `partnerize`, `everflow`, `everflow-advertiser`,
`scaleo`, `ehub`, `yieldkit`, `addrevenue`, `ebay`, `tradetracker`. The other
seventy-six throw `NotImplementedError`, including every large network (Awin, CJ,
Rakuten, ShareASale, Skimlinks, Tradedoubler, Admitad, Webgains, Daisycon,
FlexOffers).

Any AI-referral output carries one health entry per *bound* network, never per
*answerable* network, with the verbatim `NetworkErrorEnvelope` or the stated
structural limitation. Totals state what they exclude. A ten-of-eighty-six answer
is never presented as account-wide. Same non-negotiable contract as brand-data
partial failure, for the same reason: a wrong number in a client deliverable is a
trust incident.

### 7. Classification is a derived shape in its own module

`Click.referrer` already exists, so the source needs no contract change. The
classification is computed in a derived layer, never stored on `Click`.
`src/shared/types.ts` stays frozen, following the brand-data precedent.

### 8. Partner-domain resolution reuses the brand resolver, and is load-bearing

`MediaPartner` has no website or domain field and will not gain one. The
`registrableDomain` helper that already exists per-adapter, for example
`src/networks/awin-advertiser/adapter.ts:413`, is promoted into
`src/shared/brand-resolver.ts` as the single PSL-aware implementation, and partner
domains are read from `rawNetworkData` per network. Under decision 2 the domain is
the join key between two independent MCP servers, so correctness here is a
prerequisite rather than a nicety.

### 9. Sub-id read support is the preferred path to the large networks

Sub-ids are write-side or raw-only across the codebase; no adapter reads one back
onto a `Click` or `Transaction`. Awin's `clickRef` round-trip is incomplete (set on
generation, filterable on query, never read back), Impact's clicks endpoint
supports `SubId1` / `SubId2` / `SharedId` unrequested, and `BrandTxnRow.subId`
(`src/brand-data/model.ts:74`) is declared but never populated by `normalise.ts`.

Completing the read side lets a publisher who tags links in AI-facing content
self-attribute AI traffic on networks that expose no referrer at all, Awin
included. Recorded as the preferred direction because it is useful well beyond AI
visibility; sequencing goes to the maintainer below.

### 10. Explicitly out of scope

No crawler or SERP scraping. No storing or reselling vendor citation data. No LLM
API calls with the user's keys in this workstream. No dashboard, per `roadmap.md`
§12 item 7 and `solo-50k-technical-roadmap.md`.

## Workstream brief

- **User outcome.** A brand operator learns which publishers assistants cite in
  their category, which of those they already have a commercial relationship with
  on any network, and which to recruit or reactivate, without leaving their AI
  client and without buying a tool they do not already have.
- **Owning domains.** Skills (new advertiser-side workflow); shared brand resolver
  (domain helper promotion); individual network adapters (sub-id reads); a new
  derived classification module. No shared type changes.
- **Dependency graph.** This record accepted → PR-1 promote `registrableDomain`
  and partner-domain extraction (the join key, needed by everything else) → PR-2
  cross-reference skill, composing existing tools plus an external citation source
  → PR-3 AI-referrer classification with the health contract → PR-4 publisher-side
  AI-referred earnings. Sub-id read support (PR-5) is independent of PR-3 and may
  be resequenced ahead of it.
- **Risk gates.** PR-3 is `active-risk`: new cross-network semantics and a new
  public claim about what the product can measure. PR-1, PR-2, PR-4, PR-5 are
  routine. At most one `active-risk` PR review-ready at a time.
- **Acceptance proof per PR.** PR-1: unit tests over the promoted helper, and the
  per-adapter copies delegate to it. PR-2: against a real roster and a real
  external citation source, the skill produces the three buckets, every cited
  domain is traceable to its source and date, absence of the citation source
  degrades to a stated fallback rather than a thinner silent answer, and
  `tests/skills/skills-exist.test.ts` passes with the skill registered. PR-3: a
  forced unanswerable network yields N health entries, never N−1, and
  classification is verified against a fixture with known assistant referrers.
  PR-4: AI-referred clicks join to transactions by date with the coverage caveat
  stated. PR-5: a tagged link round-trips from generation to a populated sub-id on
  read.
- **Stop conditions.** No code until this record is accepted. No score, index, or
  ranking in any output. No outbound HTTP outside a per-network `client.ts` or
  `auth.ts`. No new field on `src/shared/types.ts`. No canonical citation
  operation until two networks ship one. No network in a referral output until its
  click and referrer support is verified against a fixture. If Peec AI's MCP
  output proves too thin or unstable to join reliably, stop at PR-1 and reconsider
  rather than reaching for a crawler.

## Rejected alternatives

- **Acquire citation data ourselves, by crawler or answer-engine sampler.**
  Rejected: breaches the outbound-HTTP floor, needs a new data-source class and
  probably new credentials, competes in a crowded and easily replicated space, and
  produces a sample we would be tempted to present as a metric.
- **Build a GEO vendor adapter inside this repo.** Rejected for now in favour of
  multi-MCP composition. Vendors already expose MCP servers, so an adapter would
  duplicate a working integration, tie us to one vendor's schema, and put their
  API key in our custody. Revisit only if composition proves unworkable in
  practice.
- **Resell or bundle a vendor subscription.** Rejected: cedes the layer, adds a
  paid external dependency to a product whose local path is free and complete, and
  makes our output only as good as their coverage.
- **Publish an affiliate-mcp AI-visibility score.** Rejected: prompt samples are
  not measurements.
- **Add a canonical `listAiCitations` operation now.** Rejected: one network is not
  two, and the existing metrics are not comparable. Premature normalisation would
  manufacture equivalence.
- **Add `referrerClassification` or `trafficSource` to `Click`, or `domain` to
  `MediaPartner`.** Rejected: `src/shared/types.ts` is the contract eighty-six
  adapters implement, and these are derived values.
- **Ship referral share across all networks with zeros for the unanswerable ones.**
  Rejected: zero and unavailable are different facts.
- **Lead with referrer classification as the headline.** Rejected as the primary
  framing: it reaches ten adapters and two networks of real scale, while the roster
  cross-reference works on every advertiser network supporting
  `listMediaPartners`. Note the asymmetry: classification is weakest exactly where
  the cross-reference is strongest, so the two complement rather than stack.
- **Redefine "brand" to mean market presence.** Rejected: it means a slug in
  `brands.json` bound to credentials, and overloading it would degrade every
  existing brand skill.

## Consequences and implementation follow-ups

Accepting this record commits the product to a public position: we do not measure
AI visibility, we make it actionable across every network the operator runs.
Marketing and website copy should say that, and should not imply we are a
visibility tracker.

It also accepts a soft dependency on third-party MCP servers we do not control.
Their availability, schema, and quality are outside our tests, so the skill must
state its citation source and degrade honestly when absent.

The availability table in the proposal is prose, not generated, so it needs review
whenever a network's `listClicks` status changes. A follow-up should consider
deriving it from `network.json`.

Sub-id read support (decision 9) touches multiple adapters, and each owns its
directory, so it lands as separate per-network PRs rather than one sweep.

## Open questions for the maintainer

1. **Is multi-MCP composition the right bet?** It assumes operators will run a
   vendor's MCP alongside ours rather than expecting us to acquire citation data.
   Cheap and composable, but it makes the workflow depend on a server we do not
   control.
2. **Which vendor to validate against first?** Peec AI has a shipped MCP server
   and is the obvious first test. Confirming its output shape is a prerequisite to
   writing PR-2.
3. **Sequence sub-id reads (PR-5) before referrer classification (PR-3)?** More
   work, but it reaches Awin and the other large networks.
4. **How hard to push the network-side ask publicly?** We are well placed to argue
   that networks should expose citation data through APIs rather than PDFs. A
   positioning decision.
5. **Free, gated, or a lead magnet?** The roster half needs credentials, so a
   credential-free public version is deliberately weaker.
