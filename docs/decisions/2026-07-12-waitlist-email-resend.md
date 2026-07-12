# Waitlist and email capture via Resend

- **Date:** 2026-07-12
- **Status:** Accepted (2026-07-12, Rob)
- **Affects:** the pricing page waitlist CTA (`site/pricing.html`), a new
  small waitlist Worker, and the funnel items in
  `../product/solo-50k-technical-roadmap.md` and
  `../product/phase-0-go-live-checklist.md`
- **Relates to:** [`2026-07-12-pricing-billing-and-licence.md`](./2026-07-12-pricing-billing-and-licence.md)
  (the founding-offer gate the waitlist measures)

## Context

The pricing page shipped with a no-backend waitlist CTA linking to GitHub
Discussions, because no email tool had been chosen. The Phase 0 gate (30
founding pre-orders or 500 qualified waitlist emails) needs real capture.
Rob chose Resend as the email tool on 2026-07-12.

## Decision

Use Resend for waitlist capture and later founding-offer email. The shape:

- A small Cloudflare Worker (same pattern as `issuer/` and
  `telemetry-cloudflare/`) exposes `POST /waitlist`, validates the
  submission, and adds the address to a Resend audience. The Resend API key
  lives only in the Worker's secrets, never in the static site.
- The pricing page CTA becomes a plain form posting to that Worker, with the
  network-priority question preserved, replacing the GitHub Discussions
  link once the Worker is deployed.
- Consent and honesty: the form states what the address is used for
  (waitlist and founding-offer updates only), sign-up is explicit, and every
  email includes an unsubscribe. Waitlist data is marketing capture and sits
  outside the product privacy contract in `PRIVACY.md`, which governs
  product data, not marketing capture; the form links the site privacy
  page.
- No affiliate data, credentials, or product usage data is ever attached to
  a waitlist record.

## Rejected alternatives

- **Keep GitHub Discussions.** Zero-cost but unmeasurable against the
  500-email gate and unusable for the founding-offer send. Stays as the
  interim CTA until the Worker deploys.
- **Mailing-list SaaS with hosted forms (Mailerlite, Buttondown).** Simpler
  embed but another vendor dashboard; Rob chose Resend.
- **Serverless form services.** Adds a vendor for what one small Worker in
  the existing pattern already covers.

## Consequences and implementation follow-ups

- Build the waitlist Worker and the form swap in-repo (agent-buildable,
  code-complete without the key).
- Rob-only at deploy time: create the Resend account and audience, set the
  Worker secret, deploy, then merge the CTA swap. Steps live in
  `../product/phase-0-go-live-checklist.md`.
- The gate dashboard item on the roadmap reads waitlist counts from Resend's
  audience.
