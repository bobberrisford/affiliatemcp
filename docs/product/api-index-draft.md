> **UNPUBLISHED DRAFT — NOT FOR PUBLIC USE.**
>
> This is an internal, reproducible draft of the quarterly Affiliate Network
> API Index described in `docs/product/solo-50k-revenue-plan.md` (section 7)
> and `docs/product/solo-50k-technical-roadmap.md` ("Content engine
> tooling"). Rob authorised building this GENERATOR on 2026-07-12.
> Publishing an actual ranking to any public surface (website, LinkedIn,
> README, press) is a separate go/no-go decision that has not been made.
> Do not share, quote, or publish this document, or any ranking derived
> from it, without that explicit maintainer decision.

# Affiliate Network API Index (draft)

_Status: Generated draft, per the `docs/README.md` rule that generated outputs stay distinguished from source material. Produced by `scripts/generate-api-index.ts`; do not hand-edit the ranking below._

_Generated from commit `fb4a964` (2026-07-13T01:06:35+01:00). Regenerate with `npm run generate:api-index`._

## Methodology

Every score is computed only from data already committed to this repository:
each network's `src/networks/<slug>/network.json` manifest and whether
`docs/findings/<slug>.md` exists. No live account data, no editorial
judgement, and no input that cannot be pointed at a specific file.

The score is five weighted components summing to 100:

1. **Claim status (40 pts)** — `claim_status` maps to a tier
   (`unsupported`=0, `experimental`=1, `partial`=2, `production`=3, per
   `docs/decisions/2026-06-15-adapter-promotion-gates.md`), scaled to
   40 points as `tier / 3`. If the claim is
   `partial` or `production` and `last_verified` is older than
   180 days (the same freshness window
   `scripts/validate-network-json.ts` enforces), the contribution is halved
   (a factor of 0.5) rather than left at full credit for stale
   evidence. Staleness is judged as of the stamped commit date, not the
   wall clock, so identical repo state always scores identically.
2. **Operation coverage (30 pts)** — the count of the seven
   canonical publisher operations the adapter supports (the same count
   `REPORT.md` and `README.md` already publish), as a share of seven,
   scaled to 30 points. Advertiser-side adapters are
   counted against the same seven canonical publisher operations,
   consistent with `REPORT.md`'s counting; an advertiser adapter whose
   surface maps poorly onto that set will under-score on this component
   until a side-specific canonical operation set is recorded.
3. **Setup friction (15 pts)** — `setup_time_estimate_minutes` is
   compared against the fastest recorded setup (5 minutes) as
   `5 / setup_time_estimate_minutes` (capped at 1), then halved
   (`×0.5`) if `setup_requires_approval` is true, then scaled to
   15 points.
4. **Credential simplicity (10 pts)** — the count of
   `env_vars` compared against the simplest recorded footprint
   (1 variable) as `1 / env_vars.length` (capped at 1),
   scaled to 10 points.
5. **Documentation transparency (5 pts)** — the full
   5 points if `docs/findings/<slug>.md` exists for the
   network, otherwise 0.

Deliberately excluded: API-backed vs browser-driven operation share, and
any per-operation auth-complexity detail beyond credential count. Neither
is recorded consistently enough across all current `network.json`
manifests to score fairly; adding either requires first recording the
signal in the manifest schema, not inventing it at generation time.

Source: `scripts/generate-api-index.ts`, function `scoreNetwork`. Run
`npm run generate:api-index` to reproduce this document from the current
tree.

## Ranking

| Rank | Network | Side | Score / 100 | Claim status | Ops supported | Setup friction pts | Credential simplicity pts | Findings doc |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| 1 | Awin | publisher | 90.7 | production | 6 / 7 | 15.0 | 5.0 | yes |
| 2 | Impact | publisher | 79.2 | partial | 7 / 7 | 12.5 | 5.0 | yes |
| 3 | CJ Affiliate | publisher | 71.8 | partial | 6 / 7 | 9.4 | 5.0 | yes |
| 4 | Adtraction (advertiser) | advertiser | 65.8 | experimental | 7 / 7 | 12.5 | 10.0 | no |
| 5 | Awin (advertiser) | advertiser | 65.8 | experimental | 7 / 7 | 12.5 | 10.0 | no |
| 6 | Adrecord | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 7 | Adtraction | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 8 | Affilae | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 9 | Digistore24 | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 10 | Effiliation | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 11 | Indoleads | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 12 | LeadDyno | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 13 | Levanta | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 14 | LinkConnector | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 15 | Monetizze | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 16 | Partnerize (Advertiser) | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 5.0 | yes |
| 17 | Partnero | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 18 | PartnerStack | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 19 | Pepperjam | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 20 | Rewardful | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 21 | Tapfiliate | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 22 | Tolt | advertiser | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 23 | Travelpayouts | publisher | 64.0 | experimental | 6 / 7 | 15.0 | 10.0 | no |
| 24 | Rakuten Advertising | publisher | 63.8 | partial | 6 / 7 | 3.1 | 3.3 | yes |
| 25 | Addrevenue | publisher | 63.3 | experimental | 7 / 7 | 15.0 | 5.0 | no |
| 26 | eHUB | publisher | 63.3 | experimental | 7 / 7 | 15.0 | 5.0 | no |
| 27 | Yieldkit | publisher | 63.3 | experimental | 7 / 7 | 15.0 | 5.0 | no |
| 28 | CJ Affiliate (advertiser) | advertiser | 62.7 | experimental | 7 / 7 | 9.4 | 10.0 | no |
| 29 | Everflow (Advertiser) | advertiser | 60.8 | experimental | 7 / 7 | 7.5 | 5.0 | yes |
| 30 | PartnerStack (advertiser) | advertiser | 60.8 | experimental | 7 / 7 | 12.5 | 5.0 | no |
| 31 | Tradedoubler (Advertiser) | advertiser | 60.8 | experimental | 7 / 7 | 7.5 | 5.0 | yes |
| 32 | Partnerize | publisher | 59.2 | experimental | 7 / 7 | 7.5 | 3.3 | yes |
| 33 | 2Performant | publisher | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 34 | Affiliate Future | publisher | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 35 | Commission Factory (advertiser) | advertiser | 59.0 | experimental | 7 / 7 | 10.7 | 5.0 | no |
| 36 | FirstPromoter | advertiser | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 37 | Howl | publisher | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 38 | Involve Asia | publisher | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 39 | Post Affiliate Pro | advertiser | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 40 | Profitshare | publisher | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 41 | Refersion | advertiser | 59.0 | experimental | 6 / 7 | 15.0 | 5.0 | no |
| 42 | Impact (advertiser) | advertiser | 57.7 | experimental | 7 / 7 | 9.4 | 5.0 | no |
| 43 | Everflow | publisher | 57.1 | experimental | 7 / 7 | 3.8 | 5.0 | yes |
| 44 | Commission Factory | publisher | 56.5 | experimental | 6 / 7 | 7.5 | 10.0 | no |
| 45 | Kwanko | publisher | 56.5 | experimental | 6 / 7 | 7.5 | 10.0 | no |
| 46 | Kwanko (advertiser) | advertiser | 56.5 | experimental | 6 / 7 | 7.5 | 10.0 | no |
| 47 | Optimise Media | publisher | 56.5 | experimental | 6 / 7 | 7.5 | 10.0 | no |
| 48 | Sovrn Commerce | publisher | 56.5 | experimental | 6 / 7 | 7.5 | 5.0 | yes |
| 49 | Affise | publisher | 55.8 | experimental | 7 / 7 | 7.5 | 5.0 | no |
| 50 | TUNE | publisher | 55.8 | experimental | 7 / 7 | 7.5 | 5.0 | no |
| 51 | Webgains (advertiser) | advertiser | 55.8 | experimental | 7 / 7 | 7.5 | 5.0 | no |
| 52 | eBay Partner Network | publisher | 55.4 | experimental | 7 / 7 | 3.8 | 3.3 | yes |
| 53 | mrge | publisher | 54.9 | experimental | 6 / 7 | 7.5 | 3.3 | yes |
| 54 | TradeTracker | publisher | 54.2 | experimental | 7 / 7 | 7.5 | 3.3 | no |
| 55 | Skimlinks | publisher | 54.0 | experimental | 6 / 7 | 7.5 | 2.5 | yes |
| 56 | Admitad (advertiser) | advertiser | 52.9 | experimental | 7 / 7 | 6.3 | 3.3 | no |
| 57 | Scaleo | publisher | 52.1 | experimental | 7 / 7 | 3.8 | 5.0 | no |
| 58 | Daisycon (advertiser) | advertiser | 51.7 | experimental | 7 / 7 | 5.0 | 3.3 | no |
| 59 | AccessTrade | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 60 | Adcell | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 61 | Afilio | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 62 | Connexity | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 63 | Coupang Partners | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 64 | FlexOffers | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 65 | Flipkart Affiliate | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 66 | GrowSurf | advertiser | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 67 | ShopMy | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 68 | ValueCommerce | publisher | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 69 | ValueCommerce (advertiser) | advertiser | 51.5 | experimental | 6 / 7 | 7.5 | 5.0 | no |
| 70 | Tradedoubler | publisher | 51.0 | experimental | 6 / 7 | 5.0 | 2.0 | yes |
| 71 | Adservice | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 72 | AvantLink | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 73 | Belboon | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 74 | CAKE | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 75 | ClickBank | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 76 | Eduzz | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 77 | Hotmart | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 78 | ShareASale | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 79 | Webgains | publisher | 49.9 | experimental | 6 / 7 | 7.5 | 3.3 | no |
| 80 | Offer18 | publisher | 49.0 | experimental | 6 / 7 | 7.5 | 2.5 | no |
| 81 | financeAds | publisher | 47.8 | experimental | 6 / 7 | 3.8 | 5.0 | no |
| 82 | Admitad | publisher | 47.4 | experimental | 6 / 7 | 5.0 | 3.3 | no |
| 83 | Daisycon | publisher | 46.5 | experimental | 6 / 7 | 5.0 | 2.5 | no |
| 84 | Lomadee | publisher | 46.0 | experimental | 6 / 7 | 5.0 | 2.0 | no |
| 85 | Amazon Creators | publisher | 45.3 | experimental | 6 / 7 | 3.8 | 2.5 | no |
| 86 | NetRefer | publisher | 43.5 | experimental | 6 / 7 | 2.5 | 2.0 | no |

## Reproducing this draft

```
npm install
npm run generate:api-index
```

The script reads every `src/networks/<slug>/network.json` and checks for a
matching `docs/findings/<slug>.md`; it makes no network calls and reads no
live account data.

> **UNPUBLISHED DRAFT — NOT FOR PUBLIC USE.**
>
> This is an internal, reproducible draft of the quarterly Affiliate Network
> API Index described in `docs/product/solo-50k-revenue-plan.md` (section 7)
> and `docs/product/solo-50k-technical-roadmap.md` ("Content engine
> tooling"). Rob authorised building this GENERATOR on 2026-07-12.
> Publishing an actual ranking to any public surface (website, LinkedIn,
> README, press) is a separate go/no-go decision that has not been made.
> Do not share, quote, or publish this document, or any ranking derived
> from it, without that explicit maintainer decision.
