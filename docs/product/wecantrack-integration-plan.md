# wecantrack Coverage Gap — Integration Plan

**Date:** 2026-06-05
**Goal:** Cross-reference wecantrack's integration catalogue (the public
`wecantrack.com/affiliate-networks/` list, ~350–450 integrations) against
affiliate-mcp's coverage, identify every network we *could* add as a code
adapter, and lay out a phased plan to build them via the `contribute` skill +
subagents.

## Method & caveats (read first)

- **The source.** The request started from a screenshot of the wecantrack
  integrations page. At that resolution the logos are unreadable, so the list
  below was **not** OCR'd from the image — it was rebuilt by enumerating
  wecantrack's per-network pages (`wecantrack.com/<slug>-integration/`) via web
  search, and enriched with per-network developer-docs research. Roughly **82
  distinct wecantrack integration pages** were located this way; wecantrack
  advertises 350–450, so this is a representative sample weighted toward the
  larger/named networks, not the complete catalogue.
- **The adapter bar.** A code adapter needs a **self-serve, publicly documented
  pull API**: an ordinary account holder generates credentials in-dashboard (no
  emailing the network, no NDA) and calls documented endpoints for the seven
  canonical ops (`listProgrammes`, `getProgramme`, `listTransactions`,
  `getEarningsSummary`, `listClicks`, `generateTrackingLink`, `verifyAuth`).
  Many wecantrack entries are **postback/pixel-only** (no pull API → nothing for
  an adapter to call), **gated** (key only issued on request), **single-merchant
  programmes** (Trezor, NordVPN…), or **tenants of a platform** one adapter
  covers — those are catalogued here but are *not* buildable as standalone
  adapters.
- **Verification gap.** Almost every first-party docs host (linkconnector.com,
  connexity.com, optimisemedia.com, effiliation.com, accesstrade, flipkart,
  digidip, api.affise.com, …) returns HTTP 403 to the automated fetcher
  (Cloudflare/bot walls). The docs URLs, auth methods, and self-serve flags
  below are corroborated from search-result snippets quoting those pages plus
  third-party integration docs (Strackr, wecantrack, Datafeedr, apitracker) —
  **not** direct page renders. Treat "Confidence: High" as "multiple independent
  sources agree", not "endpoint-tested". Every candidate must have its live docs
  opened and a self-serve key issued in a test account before its adapter is
  promoted past `experimental` (see the per-adapter gate below).

## Coverage snapshot

| Bucket | Count | Where |
|---|---|---|
| Implemented adapters (unique networks) | 29 | `src/networks/` |
| Already on the wishlist | 19 | `docs/wanted-networks.json` |
| **New buildable candidates (this research)** | **24** | added to `docs/wanted-networks.json` |
| Second-tier / verify-first | ~19 | this doc, §4 |
| Excluded (gated / postback / not-a-network) | ~30 | this doc, §5 |

Implemented (do not re-add): admitad, adservice, adtraction, afilio, awin, cj,
commission-factory, coupang-partners, daisycon, ebay, eduzz, everflow,
flexoffers, hotmart, impact, indoleads, kwanko, lomadee, monetizze, mrge,
partnerize, partnerstack, rakuten, rewardful, skimlinks, sovrn-commerce,
tradedoubler, value-commerce, webgains.

Already wishlisted: TradeTracker, Adcell, ClickBank, Amazon Creators API, TUNE
(HasOffers), ShopMy, Levanta, Tolt, Refersion, Tapfiliate, Howl (Narrativ),
Involve Asia, ShareASale, Pepperjam (Ascend), AvantLink, Digistore24, Belboon,
financeAds, Yieldkit.

## 1. New buildable candidates (self-serve pull API, not yet tracked)

All 24 below have been appended to `docs/wanted-networks.json`. Grouped by the
build wave they belong to (§3).

### Multiplier platforms — one adapter covers many networks (highest leverage)

| Platform | Side | Docs URL | Auth | Self-serve | Tenant model | Confidence |
|---|---|---|---|---|---|---|
| Affise | both | api.affise.com/docs3.1/ | `API-Key` header | Yes (Settings › Security) | per-tenant tracking domain + per-user key | High |
| Scaleo | both | developers.scaleo.io | tracking URL + API key | Yes (admin enables per role) | per-tenant tracking URL + key | High |
| Offer18 | both | knowledgebase.offer18.com/affiliate/affiliate-apis | API key + secret + `mid` | Yes (Account › Security) | per-tenant network engine | High |
| CAKE | both | developer.cake.net/apis | API key | Partly (key issued in-instance) | per-instance base URL + key | High |
| Post Affiliate Pro | advertiser | support.qualityunit.com (API v3) | bearer key / OAuth2 | Yes (Config › Tools › Integration) | per-account subdomain `{acct}.postaffiliatepro.com/api/v3` | High |
| NetRefer (iGaming) | both | developer.netrefer.com | OAuth 2.0 | Partly (public dev portal, registration) | per-operator tenant; OpenAPI + ASR REST | High |

> TUNE (HasOffers) — already wishlisted — is the seventh engine here and also
> transitively covers **vCommission** (IN) and **ArabClicks** (MENA), which are
> TUNE white-labels. Build the generic TUNE adapter rather than per-tenant ones.

### Regional networks with clean public REST + self-serve keys

| Network | Region | Side | Docs URL | Auth | Self-serve | Confidence |
|---|---|---|---|---|---|---|
| Affilae | FR | both | rest.affilae.com/reference | Bearer token | Yes (API Tokens menu) | High |
| Optimise Media | UK/IN/APAC | both | docs.optimisemedia.com/api | `apikey` header (Service Account) | Yes (Insights Dashboard) | High |
| AccessTrade | SEA/JP | publisher | support.accesstrade.global/api | `Authorization: Token` | Yes (publisher profile) | High |
| Travelpayouts | global (travel) | publisher | travelpayouts.github.io/slate | `X-Access-Token` | Yes (Profile › API token) | High |
| Flipkart Affiliate | IN | publisher | affiliate.flipkart.com/api-docs | API token + tracking ID headers | Yes (self-gen token) | High (verify programme open) |
| Adrecord | SE/Nordics | both | api.v2.adrecord.com/docs | `APIKEY` header | Yes (account) | High |
| Addrevenue | SE/Nordics | both | addrevenue.io/en/developers | OAuth2 lifetime token | Yes (Tools › API Tokens) | High |
| eHUB | CZ/CEE | both | ehub.docs.apiary.io (v3) | API key | Yes | High (use Apiary, *not* docs.ehub.com) |
| LinkConnector | US | publisher | linkconnector.com/help_api.htm | API key (POST) | Yes (Tools › API) | High |
| Connexity / ShopYourLikes | US | publisher | pubresources.connexity.com (Publisher API) | Publisher ID + API key | Yes (publisher portal) | High (distinct from Skimlinks) |
| Affiliate Future | UK | publisher | api.affiliatefuture.com/PublisherService.svc | API key + password | Yes (Reporting APIs page) | High (1-day pull window; dated `.svc`) |
| Effiliation / Effinity | FR | both | apiv2.effiliation.com/apiv2/doc | API key | Yes (Tools › API) | High |
| 2Performant | RO | both | doc.2performant.com | email+password → session | Yes (credential auth, not static key) | High |
| Profitshare | RO | both | doc.profitshare.com | API key + user (HMAC) | Yes (account) | High |

### SaaS-referral platforms (same cohort as existing Rewardful/Tolt/Refersion)

| Platform | Side | Docs URL | Auth | Self-serve | Confidence |
|---|---|---|---|---|---|
| FirstPromoter | advertiser | docs.firstpromoter.com | bearer key + `ACCOUNT-ID` | Yes (Settings › Integrations) | High |
| Partnero | advertiser | developers.partnero.com | bearer token | Yes (Program › Integration › API) | High |
| GrowSurf | advertiser | docs.growsurf.com | bearer key | Yes | High |
| LeadDyno | advertiser | app.theneo.io/leaddyno | private key | Yes (Profile) | High |

## 2. The full wecantrack sample, classified

Of the ~82 enumerated pages, here is how each maps to our buckets (networks
already implemented or wishlisted are marked; the rest are new classifications).

- **Implemented:** Impact, CJ Affiliate, Awin, PartnerStack, Kwanko, Rakuten,
  Daisycon, Tradedoubler, Webgains, Everflow, Partnerize, Adtraction, FlexOffers,
  Admitad, Indoleads, Involve Asia (wishlisted), Sovrn/VigLink, Skimlinks,
  Adservice, Commission Factory, eBay.
- **Wishlisted:** Share A Sale, Amazon Associates, HasOffers (TUNE), Pepperjam,
  ClickBank, Tradetracker, AvantLink, Belboon, Adcell, FinanceAds, Digistore24,
  Yieldkit, Refersion, Tapfiliate, Involve Asia.
- **New buildable (§1):** FirstPromoter, Trackier→see §4, Adrecord, Optimise
  Media, 2Performant, Effiliation, Accesstrade, Post Affiliate Pro, Affise,
  Scaleo, LinkConnector, Dognet→§4, Profitshare, MyLead→§4, GoAffPro→§4,
  Digidip→§5 (overlaps mrge), vCommission/ArabClicks→TUNE tenants, Travelpayouts,
  Flipkart, eHUB, Affilae, Connexity, Affiliate Future, NetRefer.
- **Second-tier / verify-first (§4):** TimeOne, Public Ideas, Partner-Ads,
  Bol.com, Target Circle, Leadspedia, Connects, Leadalliance, Traffic Company,
  The Affiliate Gateway, EPCVIP, MyLead, WebePartners, Convertiser, Dognet,
  Trackier, ClickDealer, MaxBounty, INRDeals, UpPromote, GoAffPro.
- **Excluded (§5):** Lazada, AliExpress, LinkHaitao, Shopee (CN/marketplace or
  seller-API), Income Access / Cellxpert / MyAffiliates / Affilka (iGaming, docs
  gated), CPAGrip, CPABuild, Adcombo, Adcombo, Traffic Company (content-locker /
  CPA postback), Trezor, TradingView, Binance, NordVPN, Surfshark, TunnelBear
  (single-merchant programmes, not networks), Zapier (integration target).

## 3. Phased build roadmap

Each adapter is an independent unit of work. The order maximises coverage and
reuse: build the engines that cover many tenants first, then the clean regional
REST APIs, then the SaaS-referral cohort (which share a pattern), then the
verify-first tail.

**Wave 0 — clear the existing wishlist (19).** ShareASale, Pepperjam, AvantLink,
Digistore24, ClickBank, TradeTracker first — all US/DACH mainstream, public
docs, named in the previous review.

**Wave 1 — multiplier engines (6).** Affise, Scaleo, Offer18, CAKE, Post
Affiliate Pro, NetRefer (+ the wishlisted TUNE). Each is a parameterised adapter:
base URL = per-tenant tracking domain / account subdomain, plus a per-tenant key.
One adapter unlocks dozens of downstream networks, so this wave has the highest
coverage-per-unit-effort. Design note: the credential set is per-tenant, so model
these as `publisher`/`single-brand` with the base URL as a setup field.

**Wave 2 — high-confidence regional networks (14).** Affilae, Optimise Media,
AccessTrade, Travelpayouts, Flipkart, Adrecord, Addrevenue, eHUB, LinkConnector,
Connexity, Affiliate Future, Effiliation, 2Performant, Profitshare. All have
public docs + self-serve keys. Watch the per-network quirks flagged in §1
(2Performant's credential/session auth; Profitshare's HMAC signing; Affiliate
Future's 1-day pull window and `.svc` endpoints; Flipkart's periodic signup
pauses).

**Wave 3 — SaaS-referral cohort (4).** FirstPromoter, Partnero, GrowSurf,
LeadDyno. These mirror the existing Rewardful/Tolt/Refersion/Tapfiliate adapters
(single host, account-scoped bearer key, advertiser-side). Build one as a
reference, then the others by analogy — likely the fastest wave.

**Wave 4 — verify-first tail (§4).** Only after opening the (often login-gated)
docs and confirming a self-serve pull API exists.

### Per-adapter workflow (one subagent per adapter)

Drive each adapter through the repo's existing `contribute` skill (Task 1) and
the scaffolder. Spawn **one subagent per adapter**, ideally with
`isolation: "worktree"` so they don't collide, each told to:

1. `npm run scaffold:network -- <slug> [--name "<Name>"] [--advertiser]` — copies
   `templates/new-network/` into `src/networks/<slug>/`, drops
   `docs/networks/<slug>.md`, stubs `tests/networks/<slug>/fixtures/`.
2. Read `src/networks/awin/adapter.ts` (reference impl) + `src/shared/types.ts`.
3. Implement `auth.ts` + `client.ts` (only `client.ts` calls `fetch`; wrap every
   call in `withResilience`; throw `HttpStatusError` on non-2xx).
4. Implement the 7 ops in order: `listProgrammes` → `getProgramme` →
   `listTransactions` → `getEarningsSummary` (derive from transactions) →
   `listClicks` (throw `NotImplementedError` if unsupported — never return `[]`)
   → `generateTrackingLink` → `capabilitiesCheck`.
5. Implement `setup.ts` with verbatim dashboard navigation for each credential.
6. Fill `network.json` (schema enforced by `scripts/validate-network-json.ts`);
   set `side`/`credential_scope` per §1; ship `claim_status: experimental`.
7. Register the one import line in `src/networks/index.ts`.
8. `npm run validate:network -- <slug>`, `npm run generate:readme`,
   `npm run generate:report`.
9. Write `docs/networks/<slug>.md` (UK English, "programme", no marketing).

**The hard gate:** `validate:network` runs a *live* diagnostic against real
credentials. Subagents have **no network credentials**, so they can only deliver
a schema-valid, typechecked, unit-tested adapter at `claim_status: experimental`
— promotion to `partial`/`production` requires a human to run the live
diagnostic with a real account. Plan the waves around credential availability:
the engines/SaaS platforms (Wave 1/3) are cheap to self-provision test accounts
for; some regional networks (Wave 2) require an approved publisher account first.

## 4. Second-tier — verify the docs first

API likely exists and is self-serve, but the documentation is behind a login or
only corroborated indirectly. Open the live docs and confirm a pull endpoint
before scaffolding:

WebePartners (PL), MyLead (PL), Convertiser (PL), TimeOne (FR), Public Ideas
(FR), Dognet (SK — built on Post Affiliate Pro; may fold into that adapter),
Trackier (network-side API is Enterprise-gated; publisher-side is open),
TheAffiliatePlatform (iGaming), Reditus, UpPromote (Shopify), GoAffPro (Shopify),
Trackdesk, ClickDealer, MaxBounty (SOAP, no stable docs page), INRDeals (docs
only as a SlideShare PDF), Partner-Ads (DK), Bol.com (NL — single retailer,
has a partner/marketing API), Target Circle, Leadspedia (US lead-gen, has an
API), Traffic Company, Leadalliance (DE), The Affiliate Gateway (TAG), EPCVIP.

## 5. Excluded — not buildable as a standalone self-serve adapter

- **Gated (key issued only on request / spend threshold):** A8.net (JP),
  Cuelinks (IN, ₹10k/mo min), LinkPrice (KR), CrakRevenue, Perform[cb]/Clickbooth,
  SHOP.COM (vetted), Boostiny/ArabyAds, Brandreward, PropellerAds (≥$1000 spend),
  Prosperent, lemonads.
- **Postback / pixel / content-locker only (no pull API):** CPAGrip, CPABuild,
  Adcombo, plus most CPA "smartlink" networks.
- **Single-merchant programmes, not networks** (wecantrack tracks these directly,
  there is no programme inventory to list): Trezor, TradingView, Binance,
  NordVPN, Surfshark, TunnelBear, and similar.
- **Marketplace / seller APIs, not affiliate pull APIs, or CN-registration
  required:** Lazada, Daraz, AliExpress, LinkHaitao; Shopee Affiliate is
  borderline (GraphQL pull API exists but App ID/Secret issuance to affiliates is
  unconfirmed self-serve) — revisit if confirmed.
- **iGaming engines with gated docs:** Income Access, Cellxpert, MyAffiliates,
  Affilka by SOFTSWISS (multipliers, but docs live behind the operator interface
  — lower priority than NetRefer, which has a public dev portal).
- **Click-trackers, not networks:** Voluum, RedTrack.
- **Data aggregators / our competitors (no own programme inventory):**
  Trackonomics (Impact-owned, enterprise), FMTC, affiliate.com, Strackr.
- **Overlaps / not distinct:** Digidip (owned by **mrge** — already implemented;
  confirm it isn't already covered before building), Conversant (= CJ),
  Affilinet (defunct — merged into Awin, API off since 2020).

## 6. Recommended starting point

If building begins immediately, the highest-value first five (cheap to
self-provision, public docs, broad reach):

1. **Affise** (multiplier — unlocks many CPA networks)
2. **Scaleo** (multiplier)
3. **Post Affiliate Pro** (multiplier — SaaS subdomain pattern)
4. **Affilae** (cleanest net-new regional REST, both sides)
5. **Travelpayouts** (clean self-serve token, large global travel vertical)

…in parallel with clearing the existing Wave 0 wishlist (ShareASale, Pepperjam,
AvantLink, Digistore24), which are the most recognised mainstream gaps.
