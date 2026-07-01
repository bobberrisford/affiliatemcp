# Desktop premium skill packs — a paid local subscription tier

- **Date:** 2026-07-01
- **Status:** Accepted (2026-07-01, Rob)
- **Affects:** desktop app (`desktop/`), `src/core/facade.ts`, the bundled
  `skills/` tree, a new billing and entitlement backend, the marketing site,
  `PRIVACY.md`, `DEPLOY.md`
- **Amends:** [`2026-06-09-desktop-app-free.md`](./2026-06-09-desktop-app-free.md)
  and the D3/D4 boundary rules in
  [`../product/desktop-app-plan.md`](../product/desktop-app-plan.md)
- **Relates to:** [`2026-06-30-paid-tier-entitlement-gate.md`](./2026-06-30-paid-tier-entitlement-gate.md)
  — a separate (still Proposed) paid gate for brand-data MCP features. Same
  entitlement family, distinct scope (MCP dispatch path, not desktop skill packs).
- **Builds on:** [`2026-06-09-desktop-skill-deployment.md`](./2026-06-09-desktop-skill-deployment.md)
  (the skills "pick" and "build" flow), which should be accepted and land first.

## Context

The desktop app ships free and open source today
([`2026-06-09-desktop-app-free.md`](./2026-06-09-desktop-app-free.md)). That
decision removed the earlier £39 one-off licence and stated plainly that a
future paid tier must return **"behind its own decision record."** This is that
record: the project's first paid tier.

We want a freemium model that earns recurring revenue without breaking the three
commitments the brand is built on:

- **D3:** "we sell things that run on our infra, never things that run on yours.
  Local features are free forever." The truly trust-destroying move D3 warns
  against is retroactively closing something that already shipped open.
- **D4:** the shipped app makes no phone-home calls.
- **D2:** the app is MIT and open, so its behaviour is auditable.

Rob's constraint for this tier: the paid features stay **local**, not hosted.
That rules out the Phase-4 "always-on watchtower" style service. It also forces
a hard truth about local subscriptions:

1. A recurring price needs **recurring value**. A build-once tool justifies a
   one-off price, not a monthly one.
2. Every local feature that outputs text (a skill, a report) is trivially
   copyable, so a local subscription cannot sell *secrecy*. It can honestly sell
   *currency and maintenance*: a growing, maintained capability kept working as
   72 networks' APIs drift.
3. A real subscription must be able to notice cancellation, which a purely
   offline licence cannot. So the paid tier requires a periodic **online
   entitlement check**.

The one feature in the current inventory that passes all of this is a
**maintained, growing library of premium workflow skill packs**, deployed
locally through the skills step designed in
[`2026-06-09-desktop-skill-deployment.md`](./2026-06-09-desktop-skill-deployment.md).
It reuses that flow's plumbing, it renews value every month, and the skill-
deployment decision already cut the door: "a hosted skill catalogue is a
Phase-4-style commercial decision and needs its own record."

## Decision

Introduce a **£20/month subscription** that unlocks a maintained, growing library
of **premium workflow skill packs**, installed locally through the desktop app's
skills step. Everything the app does today stays free.

### Free tier — posture unchanged

- The setup flow, the 18 existing core skills under `skills/`, and the skill
  **composer** ("build your own") are free, forever, local, no account, zero
  outbound calls.
- **No existing free feature moves behind the paywall.** No clawback. The
  premium packs are net-new content that never shipped free.

### Paid tier — £20/month

- Access to premium, maintained skill packs. The launch library is **agency,
  QBR, and vertical** packs: specialised multi-network workflows beyond the free
  core set, grown and maintained over time.
- **No annual option and no free trial.** The free tier plus the composer are the
  "try before you buy".
- Delivered as local `SKILL.md` folders through the existing skills "pick" flow,
  shown on a clearly labelled premium shelf, gated by an active subscription.
- The value proposition is **currency and maintenance** (packs kept working as
  network APIs change) and a growing library, **not secrecy**.

### Enforcement — online-checked entitlement

- The app verifies subscription status online **on launch** and refreshes the
  entitlement token. If offline, the last good token keeps premium unlocked for a
  **7-day grace window**, after which premium locks until the app can
  re-verify. So a paying user must reach the endpoint at least once a week; a
  flaky connection never locks them out mid-week.
- Entitlement is a **short-lived signed token** (Ed25519), refreshed online. Its
  expiry is what makes cancellation enforceable; a permanent licence could not.
- **Only paid, signed-in users make this call.** Free-tier users still make zero
  outbound calls, so D4 holds intact for everyone who has not subscribed.

### Backend — billing and entitlement only

No paid feature runs on our infra; the backend only sells and verifies.

- Stripe **Billing** subscription (£20/mo, Stripe Tax enabled) plus the Stripe
  **Customer Portal** for cancel and payment-method changes.
- One small Worker: `POST /checkout` (create subscription session),
  `POST /webhook` (verify Stripe signature, mirror subscription lifecycle into a
  KV entitlement record), `GET /entitlement` (authenticated, returns a
  short-lived signed token).
- Holds subscription records and the signing key. Holds **no affiliate
  credentials and no affiliate data, ever**, so the no-custody stance survives.

## Rejected alternatives

- **Gate local features that already shipped free** (health view, data export,
  the 18 core skills). Rejected: clawback, the exact trust-destroying move D3
  names.
- **Hosted paid features** (always-on watchtower, off-laptop digests). Set aside
  by Rob for this tier: keep the paid features local. A hosted layer remains a
  later, separate decision.
- **An offline one-off licence billed "recurringly".** Rejected: it cannot
  enforce cancellation offline, so it is a one-off dressed as a subscription.
  Dishonest.
- **The skill composer as the paid feature.** Rejected: build-once, no recurring
  value. It works better as a free adoption hook that shows the packs' value.
- **A closed-source paid feature module.** Rejected: it contradicts D2. The trust
  pitch depends on the whole app staying open and auditable; the gate code is
  public and that is accepted.

## Consequences

- This is the project's first paid tier, first account system, and first backend
  it operates continuously. That is a larger surface than the deleted £39
  issuer, and it carries an uptime obligation on the entitlement endpoint.
- The **free tier's local-first, no-account, no-phone-home posture is unchanged**
  and stays literally true.
- **OSS bypass and plain-text pack sharing are accepted.** The gate code is
  public and a `SKILL.md` is copyable text. We do not fight this; the
  subscription sells maintenance and currency to non-technical operators buying
  convenience and upkeep. The free core must stay genuinely good so premium reads
  as *additional*, never as free work held hostage.
- **D3 is amended:** a local feature may be paid only when it is net-new and
  never shipped free; anything already free stays free forever.
- **D4 is amended:** a disclosed entitlement phone-home is permitted for the paid
  tier only; the free tier still calls nothing.
- Premium pack content becomes a new commercial artefact needing an authoring and
  maintenance process, and a published free-versus-premium boundary.

## Implementation follow-ups (dependency order, each its own PR)

1. **This decision merges first.**
2. **Free skills flow lands first:** accept and ship
   [`2026-06-09-desktop-skill-deployment.md`](./2026-06-09-desktop-skill-deployment.md)
   Layer 1 ("pick") and the composer as free features. A paid shelf can only sit
   next to a working free skills step.
3. **Billing and entitlement backend:** Stripe Billing subscription, Customer
   Portal, and the Worker issuing short-lived signed tokens.
4. **App entitlement client:** a sign-in/subscribe surface, token cache, offline
   grace window, and gating that applies only to premium packs.
5. **First premium pack(s)** authored, plus the premium shelf in the skills step.
6. **Surfaces:** marketing site (free tier plus £20/mo), `PRIVACY.md` (disclose
   exactly what the entitlement check sends: an account token, never affiliate
   data), and `DEPLOY.md`.

## Resolved parameters (2026-07-01)

- **Launch premium library:** agency, QBR, and vertical skill packs.
- **No annual option, no free trial.** Free tier plus composer are the trial.
- **Offline grace window:** 7 days.
- **Composer is fully free** — the adoption hook that shows the packs' value.

Remaining open item: authoring and maintenance process for the packs, and the
published free-versus-premium boundary (an implementation follow-up, not a
blocker for accepting this decision).
