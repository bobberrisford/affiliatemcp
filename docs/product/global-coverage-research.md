# Global Coverage Research — Non-Obvious-Region Affiliate Networks with Self-Serve APIs

**Author:** research task for affiliate-mcp
**Date:** 2026-06-04
**Goal:** Find affiliate networks / partner platforms from non-obvious regions (APAC, S/SE Asia, India, Japan, Korea, China, LatAm, MENA, Africa, CIS/Eastern Europe, Nordics, Benelux, Turkey) that expose a **current, publicly documented, self-serve API** an ordinary account holder could integrate without the network's cooperation (no NDA, no bizdev approval beyond a normal account + self-issued key/OAuth app).

## Method & a big caveat on verification

I verified candidates with web search and direct page fetches. **Important environment limitation:** the fetch egress from this sandbox is broadly blocked (HTTP 403 / Cloudflare/Akamai bot walls) across almost every regional developer-docs host — including hosts that are unambiguously live and public (e.g. `developer.sovrn.com` 403'd too). So "Live?" below is judged primarily from **search-engine-indexed snippets that quote current doc content** (endpoint paths, auth sections, token-location instructions), plus URL structure and recency signals. Where I quote a specific endpoint/auth instruction, that text came from the indexed doc page. I could not render most pages in-browser; treat "Live? Yes" as "doc page is indexed and its current content was quoted" rather than "I rendered it." Anything I could not corroborate is in the "could not verify" list.

The **most important column is Self-serve?** — whether an account holder can generate credentials in-dashboard vs. having to email/contact the network.

---

## Networks by region

### Japan

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| ValueCommerce | JP | Both | https://pub-docs.valuecommerce.ne.jp/ (item API: `/docs/as-63-item-api/`, order-report: `/docs/as-78-order-report-api/`, advertiser token: `/docs/ec-74-token-api/`) | Yes | api-key / token | **Yes** | Publisher product API + per-order Report API; advertiser token + order-report API. Token self-issued in dashboard: 設定 > レポートAPI認証キーの取得 (and 広告>対応機能別>Webサービス). Clean separate publisher vs advertiser doc trees. Strong candidate. |
| A8.net (Fan Communications) | JP | Both (mostly advertiser) | https://document.a8.net/a8docs/index.html ; EC-sales API v3 `/a8docs/ecsales-api/v3/ecsales-api-v3.html` ; media manual `https://support.a8.net/as/api/pdf/a8api_manual.pdf` | Yes | api-key + IP allowlist | **No (gated)** | New "成果データ連携API" (Dec 2024) for media members pushes conversions to ad platforms. But key issuance requires emailing advertiser/program ID + allow-listed IP to A8.net. Not self-serve. |
| Rentracks | JP/APAC | n/a | none found | Not verified | — | — | "Closed" ASP; "Rental Tracking System" mentioned but no public API doc page located. NOT VERIFIED. |
| afb / AccessTrade (Interspace) | JP + SEA (ID/TH/VN/SG/MY) | Publisher | none found (publisher dashboard generates API credentials per third-party integration guides) | Not verified | api-key (per third-party docs) | Likely yes, but unconfirmed | Third-party trackers say "API credentials can be generated in the AccessTrade publisher dashboard," but I found **no public first-party API doc page**. NOT VERIFIED as a public doc. |
| LinkShare Japan (Rakuten) | JP | — | covered by existing Rakuten adapter | — | — | — | Already covered by Rakuten. |

### Korea

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Coupang Partners | KR | Publisher | https://partner-developers.coupangcorp.com/hc/ko/categories/360005470572-API-Docs | Yes | HMAC (access key + secret key) | **Yes** | Affiliate API: deeplink, product search, reports. Distinct from Coupang's seller/WING OpenAPI. Key issued in Partners dashboard. Strong candidate (huge KR retailer). Note: search API is heavily rate-limited (e.g. ~10 calls/hr per snippets). |
| LinkPrice | KR | Publisher | https://github.com/linkprice/AffiliateSetup (실적_조회 오픈 API v1.6) ; http://www.linkprice.com/affiliate/views/affiliate_marketing/plus_service_api.html | Yes | api-key (a_id + auth_key) | **No (gated)** | Single transaction-query endpoint `api.linkprice.com/affiliate/translist.php`; rich status codes, multi-currency. But doc explicitly says auth_key issuance requires contacting the LinkPrice affiliate manager. Not self-serve. Also Reward/HotDeal/DeepLink/Mobile APIs. |
| ILikeClick | KR | — | none found | Not verified | — | — | Old KR network; no public API doc located. NOT VERIFIED. |

### India / South & Southeast Asia

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Indoleads | SEA/global | Both | https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API | Yes | bearer token (header or GET param) | **Yes** | Base `https://app.indoleads.com/api`. Endpoints: conversions report, offers (filter by geo/category), apply-to-offer, coupons, sources, create tracking link. Token in **Account > API Settings** (self-serve). Strong candidate. |
| INRDeals | IN | Publisher | INRDeals API docs (Store API, Reports API, Deal Feed, Short URL API) — slideshare mirror `https://www.slideshare.net/VinitPal11/inrdealsapidocumentationpdf` | Partially (first-party doc page not directly located) | api-key | Likely yes (single-signup instant access advertised) | Aggregator of 300+ IN advertisers. APIs: Store/Reports/Deal-Feed/Short-URL. First-party doc URL not pinned down; verify the exact endpoint host before building. |
| Cuelinks | IN | Publisher | https://cuelinks.docs.apiary.io/ (v2), https://cuelinksv1.docs.apiary.io/ (v1) | Yes (Apiary) | api-token (header) | **No (gated)** | API key requires emailing sales@cuelinks.com AND ≥₹10,000/mo earnings threshold. Gated. |
| vCommission | IN/global | Publisher | partner portal Tools>API (`partners.vcommission.com/.../tools/api-key`) | Yes (key in dashboard) | api-key | Yes (key self-issued) | **Runs on TUNE/HasOffers** — covered by the planned TUNE adapter (multiplier). Deprioritise per brief. |
| Optimise | UK/IN/APAC | — | none found | Not verified | — | — | No public API doc page located. NOT VERIFIED. |
| EarnKaro | IN | Publisher | none found (referral/profit-link product, no public API) | Not verified | — | — | Consumer profit-link app; no developer API doc located. NOT VERIFIED. |

### Latin America

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Hotmart | BR/LatAm/global | Both (creator/affiliate) | https://developers.hotmart.com/docs/en/ | Yes | oauth2 (client-credentials, 2-legged) | **Yes** | Sales API, Subscriptions, Products, Members, **Affiliate data**. Credentials self-serve: Tools > Developer Tools > Credentials. Full developer portal: sandbox, OAuth playground, OpenAPI/Swagger, Postman. Very strong candidate. |
| Eduzz | BR | Both | https://developers.eduzz.com/docs/api ; create-app `/docs/api/create-app` ; user-token `/docs/api/user-token` | Yes | api-key (email + PublicKey + APIKey) / app credentials | **Yes** | Modern dev portal with API reference (e.g. `/myeduzz/v1/products`). Credentials self-created via create-app flow. Sales/products. Strong candidate. |
| Monetizze | BR | Both (producer/affiliate) | https://api.monetizze.com.br/2.1/apidoc/ ; help `https://help.monetizze.com.br/books/gestao-da-venda-esf/page/api-monetizze` | Yes | api-key (access key) | **Yes** | Open API: products, sales, commissions, payment statements; postbacks. Key self-created via Menu > Ferramentas > API. Strong candidate. |
| Afilio | BR | Publisher | https://v2.afilio.com.br/Manual/manuais-v2.html (Sales&Leads PDF, Campaign-Description PDF, Coupons PDF) | Yes (manuals) | api-key (Affiliate Token + Aff ID) | Likely yes (token + aff id from account) | Sales/Leads API, Campaign-Description API, Coupon download. Auth = Affiliate Token + Aff ID; dashboard-derived. Verify self-serve issuance of the token. Good candidate. |
| Lomadee (Buscapé / SocialSoul) | BR | Publisher | https://developer.lomadee.com/ ; SocialSoul mirror `https://developer.socialsoul.com.vc/afiliados/` ; reports `/afiliados/relatorios/recursos/consulte-suas-vendas/` ; app-token tutorial `/lab/tutoriais/afiliados/pra-que-serve-o-app-token-e-como-criar.html` | Yes | app-token | **Yes** | Offers/Coupons/Deeplink APIs + Reports API ("consulte suas vendas"). App-token self-created in dev portal. Good candidate, though product-feed-centric. |

### MENA (Middle East / North Africa)

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| ArabClicks | MENA/GCC | Publisher | none found (no public first-party API doc page) | Not verified | — | — | Large MENA publisher network (Noon/Amazon/Ounass). No public API doc located. NOT VERIFIED. |
| ArabyAds / Boostiny | MENA | Both | none found (coupon/SKU "connect via API" marketing only) | Not verified | — | — | Coupon-attribution platform; mentions "connect via API" but no public doc page. NOT VERIFIED. |
| DCMnetwork | MENA | Publisher | none (TUNE-based; application + review to join) | n/a | TUNE | No (application-gated) | **Runs on TUNE/HasOffers** (multiplier-adjacent) but membership is application-gated (24h review). Deprioritise. |

### Europe / Nordics / Benelux / CIS / Eastern Europe

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Kwanko (incl. NetAffiliation) | FR/EU/global | Both | https://developers.kwanko.com/ | Yes | api-key/token (header) | Likely **Yes** | Publisher: campaigns list + info, statistics; advertiser: stats + conversions. Web Service API. Per-side credential. Likely dashboard-issued; confirm. Strong EU candidate. |
| WebePartners | PL | Publisher | https://webepartners.pl/en/knowledge-base/ ; Strackr `https://strackr.com/docs/webepartners` | Yes | api-key | **Yes** | XML files, transactions list, product data, programmes, discount codes. Key self-created: Advanced > API key > "create new API access key." ~700 advertisers. Good candidate. |
| Adservice | Nordics (SE/DK/NO/FI) | Both | https://strackr.com/docs/adservice (+ first-party portal) | Yes | api-key + Affiliate ID | **Yes** | Transactions + clicks across 3000+ advertisers. Auth = API key + Affiliate ID, both account-derived. Note: Adservice + Adtraction unifying onto one platform. Good Nordic candidate. |
| MyLead | PL/global | Publisher | https://strackr.com/docs/mylead (+ first-party) | Yes | api-token | **Yes** | API token connects account; conversions/lead data (15-param model). Token self-serve in account. CPA/CPL focus. Good candidate. |
| SalesDoubler | UA/CIS | Publisher (lead-gen) | personal account > Tools (docs gated behind login) ; overview `https://salesdoubler.pro/en/api-traffic/` | Partially | api-key (in account) | Yes (but docs behind login) | API doc is inside the affiliate's personal account (Tools section); lead-submission oriented (name+phone). Self-serve but doc not publicly viewable. Lower priority. |
| Daisycon | NL/Benelux | Both | https://docs.datavirtuality.com/connectors/daisycon-api-reference ; Strackr `https://strackr.com/docs/daisycon` | Yes | api-key (account credentials) | Yes | Transactions, feeds, performance stats. **Already on wanted list — deprioritise.** |
| TradeTracker | NL/EU | Both | SOAP API (account info, campaigns, transactions, feeds, payments, promo material) — `https://strackr.com/docs/tradetracker` | Yes | SOAP + customer token | Yes | SOAP-based. **Already on wanted list — deprioritise.** |
| Adtraction | Nordics/EU | Both | https://adtractionapi.docs.apiary.io/ (v2, Apiary) | Yes | api-key | Yes | **Already on wanted list — deprioritise.** |
| Admitad / Mitgo | CIS/global | Both | https://developers.admitad.com/ ; https://developers.mitgo.com/hc/en-us | Yes | oauth2 | Yes (creds in account API tab) | **Already on wanted list — deprioritise.** Noted for completeness; OAuth2, publisher+advertiser methods, App Store. |
| ConvertSocial | CIS/global | Publisher | none found | Not verified | — | — | (Admitad-affiliated link-monetisation product.) No standalone public API doc located. NOT VERIFIED. |
| Effiliation / TimeOne | FR | — | none found (first-party) | Not verified | — | — | No public first-party API doc page located. NOT VERIFIED. |

### Turkey

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Gelir Ortakları (Digitouch) | TR | Both | none found | Not verified | — | — | Turkey's oldest network (500+ TR brands). No public API doc page located. NOT VERIFIED. |
| ReklamStore / ReklamAction | TR | Both | none found | Not verified | — | — | TR performance network. No public API doc page located. NOT VERIFIED. |

### SaaS partner platforms with global reach (self-hosted/tenant multipliers)

These are referral/affiliate SaaS or self-hosted network engines. Most expose **self-serve REST APIs with a per-tenant base URL + key** — meaning one parameterised adapter can cover many distinct programmes (multiplier value, like the TUNE model).

| Network | Region | Side | Public API docs (URL) | Live? | Auth | Self-serve? | Notes |
|---|---|---|---|---|---|---|---|
| Affise | global (CIS-origin) | Both (network engine) | https://api.affise.com/ ; help `https://help-center.affise.com/en/articles/6790455-start-with-api-affiliates` | Yes | api-key (header) | **Yes** | Admin + Affiliate panel APIs; statistics, offers, postbacks. Key in Settings > Security. **Multiplier** — each Affise-powered network is a tenant. Strong. |
| Scaleo | global | Both | https://developers.scaleo.io/ ; Strackr `https://strackr.com/docs/scaleo` | Yes | api-key + tracking URL | **Yes** | Public API; admin can enable API for managers/affiliates/advertisers. **Multiplier** (per-tenant base URL+key). Strong. |
| Offer18 | IN/global | Both | https://knowledgebase.offer18.com/affiliate/affiliate-apis ; readme `https://offer18.readme.io/reference/` ; network API `/network/network-api` | Yes | api-key | **Yes** | Affiliate APIs: Offers, Request-Offer, Reports, Coupon, OTP; Network API for partners/reports/dashboards. **Multiplier**. Good. |
| CAKE | global | Both | https://support.getcake.com/support/solutions/folders/5000173061 | Yes | api-key | Yes (per-tenant) | Affiliate API (GetAccountInfo, etc.). Enterprise self-hosted **multiplier**. Older platform; verify per-tenant. |
| Trackdesk | global | Advertiser (SaaS) | https://trackdesk.com/features/api | Yes | api-key | **Yes** | Create affiliates, log clicks, register conversions in real time. SaaS referral engine. Note brief lists similar tools (Rewardful/Tolt) — adjacent. |
| Post Affiliate Pro | global | Advertiser (SaaS) | `https://YOURDOMAIN.postaffiliatepro.com/api/v3` (Swagger UI) ; Strackr `https://strackr.com/docs/post-affiliate-pro` | Yes | api-key (scoped) | **Yes** | RESTful API v3, JSON, Swagger; key + scopes in Configuration > Tools > Integration. Self-hosted/tenant **multiplier**. Good. |
| GrowSurf | global | Advertiser (SaaS) | https://docs.growsurf.com/developer-tools/rest-api | Yes | bearer (Authorization: Bearer <key>) | **Yes** | Clean REST; participants/referrals. SaaS referral. |
| LeadDyno | global | Advertiser (SaaS) | https://support.leaddyno.com/hc/en-us/articles/21508238902173 | Yes | api-key (private key) | **Yes** | REST; visitors/leads/purchases. SaaS. Older but documented. |
| FirstPromoter | global | Advertiser (SaaS) | first-party API (billing-platform centric: Stripe/Paddle/Chargebee) | Yes | api-key | **Yes** | SaaS referral; API + billing integrations. Brief mentions it — adjacent to Rewardful/Tolt cohort. |
| Trackonomics | global | Publisher (aggregator) | https://trackonomics.net/ (product/link + unified-data API) | Partially | — | **No (enterprise)** | **Now an Impact company**; enterprise/managed, not self-serve. Deprioritise. |

---

## Ranked shortlist — strongest NEW candidates (live docs + self-serve confirmed)

1. **Hotmart** (`hotmart`, BR/LatAm) — OAuth2 client-credentials, self-serve creds (Tools > Developer Tools > Credentials), full dev portal with Sales + Affiliate APIs, sandbox & OpenAPI. The single cleanest LatAm integration.
2. **ValueCommerce** (`value-commerce`, JP) — self-serve report-API auth key in dashboard; clean separate publisher (order-report) and advertiser doc trees. Major JP network.
3. **Coupang Partners** (`coupang-partners`, KR) — HMAC access/secret key issued in Partners dashboard; deeplink + product + reports. Dominant KR retailer; watch rate limits.
4. **Indoleads** (`indoleads`, SEA/global) — bearer token in Account > API Settings; conversions report + offers + tracking-link endpoints, documented base URL. Genuinely self-serve.
5. **Eduzz** (`eduzz`, BR) — modern dev portal, self-serve create-app credentials, REST reference (products/sales). Strong BR digital-products coverage.
6. **Monetizze** (`monetizze`, BR) — self-serve Open API key (Menu > Ferramentas > API); sales, commissions, payment statements + postbacks.
7. **Affise** (`affise`, global multiplier) — affiliate-panel API key in Settings > Security; one adapter covers every Affise-powered network (per-tenant base URL+key).
8. **Scaleo** (`scaleo`, global multiplier) — public API, admin enables affiliate-role API; per-tenant. High multiplier value.
9. **WebePartners** (`webepartners`, PL) — self-issued API key (Advanced > API key); transactions, programmes, product data, vouchers. ~700 advertisers.
10. **Kwanko** (`kwanko`, FR/EU) — publisher campaigns+stats and advertiser stats+conversions; Web Service API, likely dashboard-issued key. Large EU footprint. (Confirm key self-issuance.)
11. **Offer18** (`offer18`, IN/global multiplier) — affiliate API key; Offers/Reports/Coupon endpoints + Network API. Per-tenant multiplier.
12. **Adservice** (`adservice`, Nordics) — API key + Affiliate ID, both account-derived; transactions + clicks across 3000+ advertisers. Best Nordic option.
13. **MyLead** (`mylead`, PL/global) — self-serve API token; conversions/lead data. Strong CPA/CPL network.
14. **Lomadee** (`lomadee`, BR) — self-serve app-token; Offers/Coupons/Deeplink + Reports ("consulte suas vendas"). Feed-centric but documented.
15. **Post Affiliate Pro** (`post-affiliate-pro`, global multiplier) — scoped REST API v3 (Swagger), self-serve key; per-tenant. Plus GrowSurf / LeadDyno / Trackdesk / FirstPromoter as a self-serve SaaS-referral cohort (one lightweight pattern covers several).

## Could not verify / gated / likely dead

- **A8.net** (JP) — docs LIVE but **gated**: confirmation/成果データ連携 API key requires emailing advertiser/program ID + allow-listed IP. Not self-serve.
- **LinkPrice** (KR) — docs LIVE (GitHub) but **gated**: auth_key issued only by contacting the affiliate manager.
- **Cuelinks** (IN) — docs LIVE (Apiary) but **gated**: key requires emailing sales@ + ≥₹10k/mo earnings threshold.
- **DCMnetwork** (MENA) — TUNE-based but **application-gated** membership; no self-serve public API.
- **Trackonomics** (global) — now an Impact company; **enterprise/managed, not self-serve**.
- **SalesDoubler** (UA) — self-serve but API docs are **behind account login**, not publicly viewable; lead-submission oriented.
- **NOT VERIFIED (no public first-party API doc page found):** Rentracks (JP), afb/AccessTrade (JP/SEA — third parties claim dashboard API keys but no first-party doc), ILikeClick (KR), Optimise (UK/IN), EarnKaro (IN — consumer profit-link app), ArabClicks (MENA), ArabyAds/Boostiny (MENA), Effiliation/TimeOne (FR), ConvertSocial (CIS), Gelir Ortakları (TR), ReklamStore/ReklamAction (TR), INRDeals (IN — docs referenced via slideshare mirror but first-party endpoint host not pinned; verify before building).
- **China:** Not pursued in depth. Major CN affiliate flows run through Taobao/Alimama (Taobaoke/淘宝客) and JD Union — both have APIs but require a China-registered business account, ICP/real-name verification, and app approval; effectively **not self-serve for a non-CN integrator**. Flag as infeasible for the stated constraint.
- **Already on wanted/building list (noted, deprioritised):** Daisycon, TradeTracker, Adtraction, Admitad/Mitgo, plus vCommission and DCMnetwork (TUNE multiplier — covered by planned TUNE adapter).

## Cross-cutting notes

- **Platform multipliers:** Affise, Scaleo, Offer18, CAKE, Post Affiliate Pro (and TUNE, already planned) are self-hosted/tenant engines — one parameterised adapter (base URL + key per tenant) covers many independent networks. vCommission & DCMnetwork are TUNE tenants. Prioritising a generic Affise and a generic Scaleo adapter likely yields the broadest non-US/non-EU coverage per unit of effort.
- **Verification gap to close before building:** because the sandbox could not render doc pages, re-fetch the live doc + actually issue a self-serve key in a test account for the top candidates (Hotmart, ValueCommerce, Coupang Partners, Indoleads, Eduzz, Monetizze, WebePartners, Kwanko) to confirm the exact auth header, base URL, and that no hidden partner-tier gate exists.

### URLs actually consulted (search-indexed; direct render blocked by sandbox 403)
- ValueCommerce: valuecommerce.ne.jp/feature/webservice.html ; pub-docs.valuecommerce.ne.jp/docs/{as-63-item-api, as-78-order-report-api, ec-74-token-api, ec-75-order-report-api}
- A8.net: document.a8.net/a8docs/index.html ; .../ecsales-api/v3/ecsales-api-v3.html ; support.a8.net/as/api/pdf/a8api_manual.pdf ; a8pr.jp/2024/12/04/cvapi/
- Coupang Partners: partner-developers.coupangcorp.com/hc/ko/categories/360005470572-API-Docs ; developers.coupangcorp.com (seller OpenAPI, for contrast)
- LinkPrice: github.com/linkprice/AffiliateSetup ; linkprice.com/.../plus_service_api.html
- Indoleads: indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API
- Cuelinks: cuelinks.docs.apiary.io ; cuelinks.zohodesk.com KB
- vCommission: partners.vcommission.com tools/api-key
- Hotmart: developers.hotmart.com/docs/en/
- Eduzz: developers.eduzz.com/docs/api ; /create-app ; /user-token
- Monetizze: api.monetizze.com.br/2.1/apidoc/ ; help.monetizze.com.br/.../api-monetizze
- Afilio: v2.afilio.com.br/Manual/manuais-v2.html ; static.afilio.com.br/.../API_Sales_e_Leads_PT.pdf
- Lomadee: developer.lomadee.com ; developer.socialsoul.com.vc/afiliados/{,relatorios/recursos/consulte-suas-vendas/} ; /lab/tutoriais/.../pra-que-serve-o-app-token-e-como-criar.html
- Kwanko: developers.kwanko.com ; strackr.com/docs/kwanko
- WebePartners: webepartners.pl/en/knowledge-base ; strackr.com/docs/webepartners
- Adservice: strackr.com/docs/adservice
- MyLead: strackr.com/docs/mylead ; mylead.global
- SalesDoubler: salesdoubler.pro/en/api-traffic/
- Daisycon: docs.datavirtuality.com/connectors/daisycon-api-reference ; strackr.com/docs/daisycon
- TradeTracker: strackr.com/docs/tradetracker
- Adtraction: adtractionapi.docs.apiary.io
- Admitad/Mitgo: developers.admitad.com ; developers.mitgo.com/hc/en-us
- Affise: api.affise.com ; help-center.affise.com/.../start-with-api-affiliates
- Scaleo: developers.scaleo.io ; strackr.com/docs/scaleo
- Offer18: knowledgebase.offer18.com/affiliate/affiliate-apis ; offer18.readme.io/reference/
- CAKE: support.getcake.com/support/solutions/folders/5000173061
- Trackdesk: trackdesk.com/features/api
- Post Affiliate Pro: postaffiliatepro.com/features/api-v3/ ; strackr.com/docs/post-affiliate-pro
- GrowSurf: docs.growsurf.com/developer-tools/rest-api
- LeadDyno: support.leaddyno.com/hc/en-us/articles/21508238902173
- Trackonomics: trackonomics.net/
- DCMnetwork: dcmnetwork.com ; postaffiliatepro affiliate-directory entry
