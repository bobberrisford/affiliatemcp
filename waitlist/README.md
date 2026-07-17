# affiliate-mcp waitlist

A tiny Cloudflare Worker that captures the pricing-page waitlist sign-up and
adds the address to a Resend audience. It runs no feature and holds no
affiliate credentials or affiliate data — only the submitted email (plus an
accepted-but-not-yet-forwarded "which networks" and "which side" answer, see
`src/index.ts`) passes through it. See the decision record:
`docs/decisions/2026-07-12-waitlist-email-resend.md`.

## Model

1. **`POST /waitlist`** `{ email, networks?, side? }` → validates the
   submission server-side and adds/updates a contact in the configured
   Resend audience. A duplicate sign-up (Resend returns a conflict) is mapped
   to a success response so the pricing-page form never errors on re-signup.
2. **`GET /health`** → liveness.

CORS allows `POST` (and its `OPTIONS` preflight) only from the configured
`SITE_ORIGIN` (defaults to `https://agenticaffiliate.ai`).

### Resend payload note

The payload sent to Resend is deliberately **email only**. Resend's
documented create-contact fields are `email`, `first_name`, `last_name`, and
`unsubscribed`; whether and how arbitrary custom properties (to carry the
"which networks" answer) can be set through this endpoint without first
declaring them in the Resend dashboard was not confirmed against live Resend
docs at implementation time — the docs site was unreachable from this
environment's fetch tooling. Sending an unconfirmed field risked either a
silently-dropped value or a rejected request, so this Worker validates and
accepts `networks`/`side` from the form for forward compatibility but does
not forward them to Resend yet. Revisit once a live Resend account confirms
the custom-property contract for this audience.

## Deploy checklist (all human-supplied — the Worker is inert without these; Rob-only)

1. `npm install`
2. In Resend: create an audience (Audiences → Create audience) and copy its
   id (`aud_…`) into `RESEND_AUDIENCE_ID` in `wrangler.toml`.
3. `npx wrangler secret put RESEND_API_KEY` — a Resend API key (`re_…`) from
   https://resend.com/api-keys.
4. Confirm `SITE_ORIGIN` in `wrangler.toml` matches the live pricing-page
   origin.
5. `npm run deploy`.
6. Follow-up PR (not this one): swap the pricing page's waitlist CTA — today
   a GitHub Discussions link in `site/pricing.html` — for a form that posts
   to this Worker's `/waitlist` endpoint.

## Local checks

- `npm test` — validation, CORS, duplicate-conflict mapping, and health
  checks, with Resend calls mocked. No live Resend calls.
- `npm run typecheck`.
