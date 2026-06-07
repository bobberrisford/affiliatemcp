# affiliate-mcp licence issuer

A tiny Cloudflare Worker that sells the **affiliate-mcp desktop** app (£39
one-off, lifetime) and issues signed, offline-verifiable licence keys.

It holds **purchase records (KV) + the Ed25519 signing private key (secret)**
and **no affiliate credentials** — the no-custody stance of the wider project
holds. Stripe is the source of truth; KV mirrors purchases for resend.

See `docs/product/desktop-app-plan.md` §2A in the main repo for the product
spec this implements.

## Endpoints

| Method | Path        | What it does |
| ------ | ----------- | ------------ |
| POST   | `/checkout` | Creates a Stripe **Checkout Session** (`mode: payment`, £39 GBP, Stripe Tax on) and returns `{ url }`. CORS-open for the Electron/`file://` app origin. |
| POST   | `/webhook`  | Verifies the Stripe signature (async WebCrypto). On `checkout.session.completed`: mints a `lid`, signs the Ed25519 licence token, stores it in KV, emails it. Idempotent. Bad signature → 400. |
| GET    | `/success`  | HTML page. Looks up the licence by `session_id` → email → KV and shows the key with a copy button and an `affiliate-mcp://activate?key=…` deep-link. Webhook-race fallback: "your licence is on its way by email". |
| POST   | `/resend`   | `{ email }` → re-sends the licence from KV. Always returns a neutral 200 (no email enumeration). |
| GET    | `/resend`   | A tiny HTML form for the above. |
| GET    | `/` `/health` | Liveness string. |

## Licence token format (v1)

Matches the verifier shipped in the app (`src/shared/config.ts`) byte-for-byte:

```
payload      = { lid, email, product: "desktop", issued: "YYYY-MM-DD", v: 1 }
payloadBytes = UTF-8 of JSON.stringify(payload)
sigBytes     = raw Ed25519 signature (64 bytes) over payloadBytes
token        = "amcp_" + base64url(payloadBytes) + "." + base64url(sigBytes)
```

`lid` = `"amcp_lid_" + <random hex>`. Signing uses **WebCrypto SubtleCrypto**
(`importKey('pkcs8', …, { name: 'Ed25519' })` + `sign`) — native to both the
Workers runtime and Node 20, so the same `src/licence.ts` runs in production
and in tests. No third-party crypto dependency.

## Local development

```sh
cd issuer
npm install
npm test          # vitest: token round-trip, tamper, webhook sig, /checkout
npm run typecheck # tsc --noEmit
npm run build     # wrangler deploy --dry-run (bundles, no deploy)
npm run sign-sample   # sign a sample licence with the DEV key, print the token
npm run dev       # wrangler dev (needs at least dummy secrets via .dev.vars)
```

For `wrangler dev`, put secrets in `issuer/.dev.vars` (gitignored):

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
LICENCE_SIGNING_KEY=<PKCS8 DER base64 of the DEV private key>
# RESEND_API_KEY omitted → emails are logged, not sent
```

The DEV private key (PKCS8 DER base64) lives at
`../licence-keys/dev-signing-key.pkcs8.b64` in the repo (gitignored). Copy its
contents into `LICENCE_SIGNING_KEY` for local runs.

## Secrets & vars the human must provide before deploy

**Secrets** — set with `npx wrangler secret put <NAME>`:

| Secret | Value |
| ------ | ----- |
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the registered webhook endpoint |
| `LICENCE_SIGNING_KEY` | Ed25519 **private** key, PKCS8 DER, base64 |
| `RESEND_API_KEY` | `re_…` (omit in dev → emails logged) |

**Vars** — in `wrangler.toml` `[vars]` or the dashboard:

| Var | Value |
| --- | ----- |
| `LICENCE_FROM_EMAIL` | verified Resend sender, e.g. `licences@yourdomain` |
| `SUCCESS_URL` | base success URL; the Worker appends `?session_id={CHECKOUT_SESSION_ID}` |
| `CANCEL_URL` | cancel URL |
| `STRIPE_PRICE_ID` | *(optional)* pre-created Price id; unset → inline £39 price_data |
| `EXTRA_CORS_ORIGINS` | *(optional)* comma-separated extra allowed origins |

## First-time setup

1. **KV namespace**
   ```sh
   npx wrangler kv namespace create LICENCES
   npx wrangler kv namespace create LICENCES --preview
   ```
   Paste the returned `id` / `preview_id` into `wrangler.toml`
   (`[[kv_namespaces]]` → `LICENCES`).

2. **Secrets**
   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put LICENCE_SIGNING_KEY
   npx wrangler secret put RESEND_API_KEY
   ```

3. **Deploy**
   ```sh
   npx wrangler deploy
   ```

4. **Register the Stripe webhook** (Stripe dashboard → Developers → Webhooks):
   - Endpoint URL: `https://<your-worker>/webhook`
   - Events: `checkout.session.completed`
   - Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

5. **Resend**: verify your sending domain, create an API key, set
   `RESEND_API_KEY` and `LICENCE_FROM_EMAIL`.

## Production keypair handling

The committed public key in the app (`src/shared/config.ts`
`LICENCE_PUBLIC_KEY_SPKI_B64`) is a **DEV** key. For production:

1. Generate a fresh Ed25519 pair (the repo has
   `scripts/generate-licence-keypair.ts`). Keep the private key **out of git**.
2. Embed the new **public** key (SPKI DER base64) in `src/shared/config.ts` and
   ship an app build with it.
3. Base64-encode the new **private** key as PKCS8 DER and set it as the
   `LICENCE_SIGNING_KEY` secret on the Worker.
4. Keys signed with the old (dev) private key will no longer verify against the
   new public key — issue production keys only after the swap.

The private key never leaves the Worker secret store; `/licence-keys/` in the
repo is gitignored and only ever holds the dev pair.
