# affiliate-mcp entitlement issuer

A tiny Cloudflare Worker that sells the **£20/mo premium subscription** and
verifies it. It runs no feature. It holds subscription records (KV) and the
Ed25519 signing key (secret) only — **no affiliate credentials and no affiliate
data ever touch this Worker**, so the local-first, no-custody stance holds for
the paid tier too.

See the decision record:
`docs/decisions/2026-07-01-desktop-premium-skill-packs.md`.

## Model

Free-tier users never contact this Worker. A paid user's app talks to it:

1. **`POST /checkout`** → the Worker creates a Stripe **subscription** Checkout
   Session and returns `{ url, accountKey }`. The app stores `accountKey` up
   front and opens `url`. The user pays in their browser.
2. **`POST /webhook`** → Stripe notifies the Worker; it mirrors the subscription
   lifecycle (`checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`) into KV, keyed by `accountKey`.
3. **`POST /entitlement`** `{ accountKey }` → while the subscription is active,
   the Worker signs and returns a **short-lived** Ed25519 entitlement token
   (`{ active, token, exp }`); otherwise `{ active: false }`. The app verifies
   the token offline with the embedded public key and re-fetches before expiry.
   Expiry is what makes cancellation enforceable — a lapsed subscription stops
   minting tokens, and the app locks after its 7-day grace.
4. **`POST /portal`** `{ accountKey }` → a Stripe billing-portal URL to
   manage/cancel.

The token format (`amcpe_…`, `src/token.ts`) must match the app-side verifier
byte for byte.

## Deploy checklist (all human-supplied — the Worker is inert without these)

1. `npm install`
2. Create a fresh KV namespace and paste the ids into `wrangler.toml`:
   `npx wrangler kv namespace create ENTITLEMENTS` (and `--preview`).
3. In Stripe: create a £20/mo recurring **Price**, put its id in `STRIPE_PRICE_ID`;
   enable Stripe Tax; register the webhook endpoint (`/webhook`) for the three
   subscription events above.
4. `npm run gen-keypair` → set the PRIVATE key as the Worker secret
   `LICENCE_SIGNING_KEY`, and embed the PUBLIC key in the desktop app verifier.
5. `npx wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` /
   `LICENCE_SIGNING_KEY`.
6. `npm run deploy`.

## Local checks

- `npm test` — token sign/verify roundtrip + the entitlement route (in-memory KV).
- `npm run typecheck`.

Stripe-backed routes (checkout, webhook, portal) are thin API wrappers verified
against a Stripe test account, not mocked in unit tests.
