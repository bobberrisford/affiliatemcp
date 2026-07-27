# Hosted trust surface and web analytics

- **Date:** 2026-07-27
- **Status:** Proposed (awaiting Rob)
- **Affects:** `site/security.html`, `site/privacy.html`, `site/faq.html`,
  `PRIVACY.md` (the "pre-launch" framing), and every page in `site/`
- **Builds on:** [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
  (clause 6, the public trust page), [`2026-06-13-privacy-first-telemetry.md`](./2026-06-13-privacy-first-telemetry.md)
- **Supersedes the drafts in:** `docs/product/site-security-repositioning-DRAFT.md`
  (PR #412) and the security-page finding in
  `docs/product/site-trust-copy-benchmarks-DRAFT.md` (PR #411). Both were
  explicitly written as "decide this first" proposals; this record is that
  decision. Close both once this merges.

## Context

Two problems block a marketing push on the hosted tier, and they are the same
problem seen from two angles: the site describes a product that no longer
matches reality, and nothing measures what the site does.

### The site denies that the hosted tier exists

`site/security.html` exists to answer brand and agency security
questionnaires. Live today, it says:

- "affiliate-mcp is local-first with **no hosted service**: it never receives
  your credentials or affiliate data" (intro, and the meta/OG/Twitter
  descriptions).
- "There is no hosted service and no account to create with us."
- "No multi-tenant server, no shared database, no vendor-held copy of your data
  to be breached."
- Sub-processors: "None for credentials or affiliate data."
- "there is no hosted service or vendor-held data to certify, and **we are not
  a processor of your affiliate data** because it is never sent to us."

`site/privacy.html` says "a local-only, open-source tool" and "No account,
sign-up, or registration." `site/faq.html` says "There's no paid tier and no
account" and "There is no hosted account."

All of that is false for hosted users. The hosted tier is live, stores network
API credentials under envelope encryption, holds a billing email for
subscribers, and charges £34–£99 a month. Two things follow. Commercially, the
cohort most likely to pay is the cohort most likely to read the security page,
and they will conclude either that hosted does not exist or that our documents
cannot be trusted. Legally, `site/privacy.html` is the closest thing we publish
to a processing notice and it does not describe the processing that actually
happens.

Note the repository's own `PRIVACY.md` already carries an accurate hosted
section (added alongside the vault it describes, per the custody decision's
follow-up). The site never caught up. The gap is the published surface, not the
underlying posture — with one stale line: `PRIVACY.md` still says "The hosted
tier is not a public product yet."

### Nothing is measured

There is no analytics of any kind on the site or in the hosted worker: no
Google Analytics, Plausible, PostHog, Umami, Fathom, Mixpanel or Segment. The
only instrumentation that exists anywhere is the local CLI's opt-in, aggregate
telemetry, which is a different thing entirely and governed by
`2026-06-13-privacy-first-telemetry.md`.

That is defensible for an open-source local tool where the honest answer to
"what do you collect" is "nothing". It is not workable for a commercial funnel.
Without it we cannot tell whether a landing page change helped, which channel
produced a sign-up, or where in the roughly fourteen-step hosted funnel people
give up.

Adding a tracker to a project whose stated posture is "nothing hosted, nothing
phones home" is a change to the privacy contract, not a tooling choice, so it
needs a decision rather than a commit.

## Decision

### 1. The site adopts a two-tier trust surface

Every claim on the trust pages is stated per tier. The local tier keeps its
strong claims unchanged, because they remain true and are a genuine
differentiator. The hosted tier is described in full and plainly.

The framing: **local stays local; hosted is opt-in, bring-your-own-key, and
does create a processor relationship, described without hedging.**

Specifically:

- `site/security.html` keeps its questionnaire format, and every answer gains
  an explicit "local" and "hosted" reading. The five claims quoted above are
  replaced, along with the meta, OG and Twitter descriptions that repeat them.
- Sub-processors for hosted are named: Cloudflare (compute, storage, the
  credential vault, and — per section 2 below — web analytics), Stripe
  (billing), Resend (sign-in and digest email). Affiliate data is fetched live
  from the networks' own APIs and not retained beyond the report that used it.
- `site/privacy.html` gains a hosted section mirroring `PRIVACY.md`: what is
  held, where, under what encryption, who can reach it, and how deletion works.
- `site/faq.html` stops saying there is no paid tier and no account, and gains
  the hosted questions people will actually ask.
- `PRIVACY.md`'s "not a public product yet" line is corrected.

### 2. We state the known limitations rather than routing around them

The draft in PR #412 left three questions open. They are decided here.

**The master key.** State the limitation publicly, in one sentence, and link
the threat model. Hosted credentials use envelope encryption with a per-user
AES-256-GCM data key; the MVP wraps the master key with a Cloudflare Worker
secret rather than an external KMS, and `hosted/README.md` ("Vault threat
model") says what that does and does not protect against. Rob accepted this for
the MVP on 2026-07-14. Burying it would be the first dishonest thing on the
page, and a reviewer who finds it themselves trusts nothing else we wrote.

Note this is a **partial** satisfaction of custody clause 2, which specifies
"KMS-backed envelope encryption". The site must not imply otherwise.

**Processor status and certifications.** We say plainly that for the hosted
tier we act as a processor of the credentials you store with us, that there is
no SOC 2 or ISO 27001 certification, and that none is in progress. No
certification roadmap is claimed.

**A DPA is not offered yet, and the page will say so.** Offering one is a legal
commitment Rob has to make deliberately with advice; this record does not make
it. Tracked as a follow-up below, because enterprise buyers will ask.

**Two custody gaps are disclosed, not smoothed over:**

- Custody clause 5 promises self-serve export. `hosted/src/routes/account.ts`
  implements hard delete only; export is open in PR #395. The page says export
  is not yet self-serve and that delete is complete and available now.
- Sessions cannot be revoked before token expiry. `DELETE /account` removes
  everything reachable, but a live token remains valid until it expires.

### 3. Web analytics: Cloudflare Web Analytics, cookieless, site only

Adopt **Cloudflare Web Analytics** across `site/`.

The deciding argument is sub-processors. This record requires us to publish a
sub-processor list for hosted, and Cloudflare is already on it — it is the
compute, the storage and the vault. Plausible, Umami, PostHog or Fathom would
each add a **new** named third party to that list on the very page we are
writing to rebuild trust, in exchange for capabilities this funnel does not
need. The cheapest privacy choice is the one that introduces nobody new.

Verified properties, as of 2026-07-27: it sets no cookies and uses no
client-side state such as `localStorage`; it does not generate visitor IDs,
session IDs, or browser fingerprints; a single beacon POST carries aggregated,
non-identifying page-view and Core Web Vitals data; IP addresses are used for
country-level geolocation and are not stored or logged. Free on all plans.

The constraints we accept:

- **Site only, never the hosted worker's credential or consent pages.**
  `hosted/src/page-chrome.ts` deliberately loads zero external resources on
  pages that carry credentials and OAuth consent. That property is not traded
  away for a page-view count. Hosted-side measurement stays server-side:
  counting sign-in requests, connection tests and tool calls from logs the
  worker already writes.
- **No personal data, ever, in an event.** No email, no account id, no network
  credentials, no affiliate figures. Events carry a page and an outcome.
- **No cross-site tracking and no advertising integration.**
- We do not claim blanket GDPR compliance. Because it sets no cookies and
  stores nothing on the visitor's device, the ePrivacy consent requirement does
  not bite and **no cookie banner is added**. The residual argument about
  US-based processing under Schrems II applies to Cloudflare generally, which
  the hosted tier already depends on; it is not made better or worse by
  counting page views. The security page states this rather than asserting
  compliance.

**Attribution uses distinct paths, not query strings.** Cloudflare Web
Analytics deliberately does not log query strings, to avoid collecting
sensitive data that people put in URLs. That is the right default and we are
not working around it — but it means a `?utm_content=` scheme would produce no
per-post attribution at all. Instead each campaign post links to its own
static path under `/go/<slug>`, which redirects to the real page. Cloudflare
reports paths, so the distinct path *is* the attribution, and no tracking
parameter is ever attached to a visitor's URL.

These pages are `noindex` with a canonical link to their destination, so they
cannot fragment search results.

Five funnel marks are defined: `hosted.html` view (client, via the path),
sign-in form submit, `/connect` arrival, connection-test pass, and first tool
call. The last four are server-side, from logs the hosted worker already
writes.

### 4. Sequencing

The trust-page rewrite lands **before** any campaign traffic. Analytics may
land alongside or after it, but not before — measuring arrivals to a page that
misdescribes the product is the wrong order.

## Rejected alternatives

- **Leave the trust pages alone and push anyway.** Rejected. The contradiction
  is worst for exactly the buyers the push targets, and the privacy page is not
  a marketing asset we get to leave stale.
- **Take hosted off the site until the pages are fixed.** Coherent, and it was
  tempting. Rejected because the pages are a few hours of work and hosted is
  already live and taking sign-ups; hiding a live product is its own form of
  inaccuracy.
- **Plausible or Umami, self-hosted.** The strongest alternative: better
  product, and self-hosting answers the data-residency argument outright.
  Rejected for now because it adds a named sub-processor or an operational
  surface for a solo maintainer, to measure a funnel that currently has no
  baseline at all. Revisit if the funnel volume ever justifies it.
- **Server-side counting only, no site analytics.** The strictest option and a
  genuine contender. Rejected because it is blind to the top of the funnel —
  it cannot tell a landing page that converts badly from one nobody reached.
- **A full consent banner.** Rejected: with no cookies and no device storage
  there is nothing to consent to, and a banner would imply otherwise.

## Consequences

- The project can no longer describe itself, without qualification, as having
  no hosted service. Every future trust claim is stated per tier. That is a
  permanent increase in editing cost and the honest price of shipping hosted.
- We publish, in public, that the master key is a Worker secret and not KMS,
  that there is no SOC 2 or ISO 27001, that no DPA is offered, and that
  self-serve export is not built. Some enterprise buyers will disqualify us on
  that list. This is the correct outcome; they would have disqualified us later
  and with less goodwill.
- We start collecting aggregate page-view data where previously we collected
  none. The claim "nothing phones home" stays true of the **local server**, and
  must be scoped that way wherever it appears.
- Cloudflare's role widens from hosted infrastructure to include marketing-site
  measurement, and is declared.

## Implementation follow-ups

1. Rewrite `site/security.html`, `site/privacy.html`, `site/faq.html` to the
   two-tier framing. Fix the "not a public product yet" line in `PRIVACY.md`.
2. Add the Cloudflare Web Analytics beacon to `site/` only, plus the `/go/`
   redirect pages for campaign attribution. Never to
   `hosted/src/page-chrome.ts`.
3. Close PR #411 and PR #412, referencing this record.
4. **Rob, legal:** decide whether a DPA is offered to hosted customers, and
   whether to pursue any certification. Until then the page says neither
   exists.
5. Land self-serve export (PR #395) so custody clause 5 is met, and revisit the
   security page's export row when it does.
6. The benchmark copy drafted in PR #411 stays unpublished until benchmarks
   actually ship. Nothing in this record authorises advertising them.
