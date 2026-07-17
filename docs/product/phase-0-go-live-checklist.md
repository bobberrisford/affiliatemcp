# Phase 0 go-live checklist (Rob-only operational steps)

> Status: operational checklist, written 2026-07-12 during the autonomous
> delivery window. Everything agent-buildable in the repo for the skill-pack
> tier is built, reviewed, and merged; the steps below need Rob's accounts,
> secrets, or legal identity and cannot be done by an agent. Sources of truth:
> `issuer/README.md` (Worker deploy), `src/core/entitlement.ts` (client),
> [`2026-07-12-pricing-billing-and-licence.md`](../decisions/2026-07-12-pricing-billing-and-licence.md)
> (pricing and compliance), and the accepted skill-packs decision.

## What already exists in the repo

- The entitlement issuer Worker (`issuer/`): `POST /checkout`, `POST
  /webhook`, `POST /entitlement`, `POST /portal`, Ed25519 token signing,
  tests, and its own CI job. Not yet deployed.
- The desktop client (`src/core/entitlement.ts`): checkout, refresh, portal,
  sign-out, offline-first status with the 7-day grace window. Ships a
  labelled dev public key.
- The desktop premium shelf and account screen (`desktop/renderer/app.js`),
  IPC wiring, and a server-side install gate that refuses premium pack
  installs without an active entitlement.
- The premium pack content (`premium-skills/`): agency pack and publisher
  money pack, plus earlier pack folders, excluded from all free bundles.
- The public pricing page copy (site PR) and the reviewed pricing decision.

## Go-live steps, in order

### 1. Stripe (test mode first, then live)

- [ ] Confirm the trading entity the subscription sells under.
- [ ] Create the product and price: £20/month GBP recurring; note the
      `price_...` id.
- [ ] Enable Stripe Tax.
- [ ] Register the webhook endpoint (the deployed Worker URL + `/webhook`)
      for `checkout.session.completed`, `customer.subscription.updated`,
      `customer.subscription.deleted`; note the signing secret.
- [ ] Collect the secret API key.

### 2. Compliance (before the first live invoice, not before test mode)

- [ ] UK VAT registration and the EU OSS scheme (B2C digital sales to EU
      consumers need OSS from the first sale; see the pricing decision).

### 3. Cloudflare Worker deploy (`issuer/`)

- [ ] Create a fresh KV namespace (the old paid-tier one is gone; see the
      comment in `issuer/wrangler.toml`).
- [ ] Fill `issuer/wrangler.toml`: KV `id`, `preview_id`, and
      `STRIPE_PRICE_ID` (currently `REPLACE_WITH_*` placeholders).
- [ ] Generate the production Ed25519 keypair (`issuer/README.md` has the
      command).
- [ ] `wrangler secret put` all three: `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET`, `LICENCE_SIGNING_KEY` (the private half).
- [ ] Deploy; verify `GET /health`.

### 4. Swap the dev key and release the desktop app (one small code PR)

- [ ] Replace `ENTITLEMENT_PUBLIC_KEY_SPKI_B64` in `src/core/entitlement.ts`
      with the production public half (the constant is explicitly labelled a
      dev key).
- [ ] If the deployed Worker URL differs from the default in
      `src/core/entitlement.ts`, set it there or document
      `AFFILIATE_MCP_ISSUER_URL` (currently missing from `.env.example`;
      add it in the same PR).
- [ ] Cut a desktop release (`desktop-release` workflow) so the packaged app
      carries the production key and the premium packs.

### 5. End-to-end proof before announcing

- [ ] Full test-mode purchase: checkout from the desktop account screen,
      webhook fires, entitlement refresh returns a valid token, premium
      shelf unlocks, pack installs, cancel via portal re-locks after expiry.
- [ ] Repeat once in live mode with a real card, then refund it.

### 6. Website and funnel

- [ ] Merge and verify the pricing page deploy (auto-deploys from `site/**`
      on main).
- Waitlist: rescinded (2026-07-13, Rob; see
      `../decisions/2026-07-13-build-hosted-without-presell.md`). The
      `waitlist/` Worker stays undeployed; the pricing CTA repoints to the
      hosted product as workstream slices ship.
- [ ] Announce on LinkedIn only after step 5 passes.

## Deliberately not done by agents

Account creation, secrets, keypair custody, tax registration, deploys, and
releases all sit with Rob per the delivery protocol: they are irreversible,
carry legal or credential custody, or publish to users. The one remaining
code change (the key swap PR in step 4) is intentionally left until the
production keypair exists.
