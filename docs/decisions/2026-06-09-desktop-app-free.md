# Desktop app ships free — no licence, no payment backend

- **Date:** 2026-06-09
- **Status:** Accepted
- **Affects:** desktop app, `src/shared/config.ts`, the marketing site, release runbook

## Context

The original desktop-app plan ([`../product/desktop-app-plan.md`](../product/desktop-app-plan.md))
shipped the signed, notarised macOS setup app behind a one-off £39 licence. That
required three pieces the rest of the project does not have:

- an offline licence contract (Ed25519 verify + embedded public key in
  `src/shared/config.ts`, a desktop activation gate as screen 0);
- a payment + issuance backend (a Cloudflare Worker doing Stripe Checkout
  Sessions, webhook verification, Ed25519 signing, KV records, and licence
  email);
- a deep-link hand-back (`affiliate-mcp://activate?key=…`) from the Stripe
  success page into the app.

In review of [#152](https://github.com/bobberrisford/affiliatemcp/pull/152),
that single PR combined security-sensitive payments and licensing with the
desktop and site surfaces, which made it hard to review confidently.

## Decision

The desktop setup app ships **free and open source (MIT)**, like the CLI and MCP
server. We remove the paid tier entirely:

- delete the issuer Worker (Stripe Checkout, webhook, email, licence signing);
- delete the offline licence verification from `src/shared/config.ts` and the
  desktop activation gate; the app opens straight at the welcome screen;
- delete the `affiliate-mcp://activate` deep-link and the in-app Buy button;
- update the marketing site and `DEPLOY.md` to describe a free download with no
  purchase.

## Rejected alternatives

- **Keep the licence-verify code dormant for a future paid tier.** Rejected:
  unused crypto + gate code is dead weight reviewers must still reason about, and
  it contradicts the "free" message. A future tier can re-introduce it behind its
  own decision record.
- **Split #152 into four PRs and keep the paid model.** Rejected on product
  grounds: going free removes the security-sensitive payments/licensing surface
  rather than just reorganising it, and leaves a much smaller, reviewable change.

## Consequences

- No backend to operate, no Stripe account, no secrets to rotate, no Ed25519
  keypair to manage. The local-first, no-telemetry posture is now literally
  total: the desktop app makes only OS-level outbound calls (open a dashboard,
  restart Claude).
- The MCP engine never had licence code in its runtime path; it now has none in
  the repo at all.
- The Apple signing/notarisation work is unaffected — a free app is still signed
  and notarised for Gatekeeper.

## Implementation follow-ups

- The historical plan doc `../product/desktop-app-plan.md` is kept for context
  with a banner pointing here; its §2A (licence/Stripe) and Phase 1b (issuer) are
  superseded by this decision.
