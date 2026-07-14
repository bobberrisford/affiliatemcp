# affiliate-mcp hosted

A Cloudflare Worker that scaffolds the hosted service and its user auth
(workstream slice H2: `docs/product/hosted-mvp-workstream.md`). It holds
**no affiliate credentials and no affiliate data**. It knows a user id and an
email-hash lookup, and nothing else: the encrypted credential vault is H3, a
separate slice gated on its own KMS decision
(`docs/decisions/2026-07-12-hosted-credential-custody.md` §H3), not built
here. Nothing in this Worker stores, decrypts, or forwards a network API key.

See the decision records: `docs/decisions/2026-07-12-hosted-credential-custody.md`
(the custody contract this whole workstream operates under) and
`docs/decisions/2026-07-13-build-hosted-without-presell.md` (why this ships
directly, and why the waitlist Worker's Resend pattern is reused here).

## Model

1. **`POST /auth/request-link`** `{ email }` → creates a single-use, 15-minute
   sign-in token, stores only its SHA-256 hash in KV, and emails the magic
   link via Resend's transactional send API. The link's origin comes from the
   configured `PUBLIC_BASE_URL` var, never from the request's own URL or Host
   header, so a proxy or misrouted Host in front of the Worker can never
   poison the emailed link. Always returns `200 { ok: true }` for any
   validly-shaped email address, whether or not an account already exists for
   it, whether or not the abuse limit below was hit, and regardless of
   whether the upstream Resend call itself succeeds — see the "no account
   enumeration" note below. A malformed request (bad JSON, missing or
   malformed email) is a `400`, because that response depends only on what
   the caller typed, not on any account state. A missing or invalid
   `PUBLIC_BASE_URL` is a `500`: a configuration error is identical for
   every caller and every address, so it carries no enumeration signal.
2. **`GET /auth/callback?token=…`** → verifies and consumes the sign-in token
   (its KV record is deleted before anything else happens, enforcing
   single-use), creates the user record on first sign-in, and returns a
   minimal HTML page containing a freshly-issued 30-day session token. See
   "Callback delivery: page vs cookie" below.
3. **`POST /auth/session/verify`** `{ token }` → `{ userId, exp }` on success,
   `401 { error }` otherwise. This is the primitive H4's remote MCP transport
   will call to authenticate a request.
4. **`GET /health`** → liveness.

### No account enumeration

`/auth/request-link` must not let a caller learn whether a given email
address has an account. The handler never branches on account existence at
all: the same single-use token gets minted and the same email gets attempted
for every validly-shaped address, and account creation happens later, only at
`/auth/callback` if the token is ever redeemed. The one branch that does
happen — a genuine Resend send failure — is intentionally NOT surfaced to the
caller as a different response, because Resend failures correlate with
Resend's own state (bad API key, rate limit), not with whether the specific
address has an affiliate-mcp account; surfacing it would still be safe on
those grounds, but returning the identical `200` in every case is the
simplest response shape to reason about and to test. Failures are only
observable server-side, in the Worker's own logs, and only as a status code —
never the email address, never the Resend response body (which could itself
echo the address back).

### Request-link abuse limit

`/auth/request-link` carries a cheap KV-counter backstop: at most 5 requests
per address per hour (keyed by the existing HMAC email hash, never the raw
address) and 20 per IP per hour (keyed by a one-way SHA-256 of
`CF-Connecting-IP`; the raw IP is never stored or logged). An over-limit
request receives the identical neutral `200 { ok: true }` — the send is
simply skipped — so the limiter is not probeable and adds no enumeration
signal. KV counters are not atomic, so concurrent requests can slightly
overshoot the cap, and each increment refreshes the window TTL; both are
acceptable for what this is: protection against email-bombing a victim
address and burning Resend quota, not the product's rate-limiting story.
H4's transport-level per-user rate limits supersede this backstop for
everything behind a session.

### Callback delivery: page vs cookie

The workstream brief allowed either a copyable HTML page or a `Set-Cookie`
for handing back the session token, whichever was simpler and more testable.
This Worker uses a copyable page:

- The session token is a bearer credential for H4's remote MCP transport — an
  MCP client (not this browser tab) presents it on every call — so a value
  the user can copy into that client's settings is directly useful. A cookie
  scoped to this Worker's origin would never reach a non-browser MCP client,
  so the user would still need a "now copy this" step regardless.
- It avoids `Set-Cookie` attribute decisions (`Domain`, `Secure`, `SameSite`,
  partitioning) that matter for a real browser-session deploy but add
  surface-area risk for no benefit here, since nothing in this flow relies on
  a browser automatically re-presenting the cookie.
- It is trivial to unit-test: assert the response body contains the token,
  with no cookie-jar or attribute parsing involved.

### Email-key hashing trade-off

The KV mapping from an email address to its user id is keyed by
`email-hash:<hex>`, an HMAC-SHA256 of the normalised address — never the
address itself — so a KV dump does not hand out the user list as plain email
addresses. HMAC needs a secret key. Rather than provision a dedicated pepper
secret for this one lookup, `src/identity.ts` derives one from the existing
`SESSION_SIGNING_KEY` secret via a domain-separated SHA-256. The trade-off:
this keeps the Worker down to the two secrets this slice actually needs
(`RESEND_API_KEY`, `SESSION_SIGNING_KEY`), at the cost of coupling the
email-lookup pepper's lifetime to the session-signing key's. **Rotating
`SESSION_SIGNING_KEY` silently changes every user's lookup hash** — existing
`email-hash:` entries would stop resolving, so a returning user would be
issued a fresh account on next sign-in rather than reconnecting to the old
one. A rotation runbook must re-derive and rewrite the `email-hash:` entries
(computable from the stored `user:<id>` records only if the raw email were
retained somewhere, which it deliberately is not — see "KV storage shapes"),
or accept the one-time account split. Flagging this now, before the first
rotation, rather than after: a dedicated pepper secret, rotated independently
of the signing key, is the straightforward fix if this trade-off proves
wrong in practice.

## KV storage shapes

One namespace (`HOSTED_USERS`), three key shapes, no affiliate data in any of
them:

- **`user:<userId>`** → `JSON { id, createdAt }`. `userId` is an opaque
  `hosted_usr_<uuid>` string; nothing PII-bearing is embedded in it. No raw
  email address is stored in this record, or anywhere else in this Worker
  (see the trade-off above for what that costs on key rotation).
- **`email-hash:<hmacHex>`** → `<userId>`. The only path from an email
  address to a user id; see "Email-key hashing trade-off" above.
- **`pending-link:<sha256Hex>`** → `JSON { emailHash, expiresAt }`. Written
  with a 15-minute `expirationTtl` and deleted the instant `/auth/callback`
  reads it, so the record functions as both the "does this token exist"
  check and the single-use marker. The explicit `expiresAt` field is a
  defensive backstop against KV's TTL propagation delay, not the primary
  expiry mechanism. Known residual: KV is eventually consistent across PoPs,
  so two concurrent callbacks hitting different PoPs can both read the
  record before either delete propagates and both be issued a session — and
  the in-memory test fake is strongly consistent, so no unit test can catch
  this. Compensating controls: the 15-minute TTL bounds the race window now,
  H4's transport-level rate limits bound what a duplicated session can do
  later, and a Durable Object (per-token single-writer) is the fix if
  double-redeem ever matters in practice.
- **`rl:email-hash:<hmacHex>`** and **`rl:ip:<sha256Hex>`** → a small
  counter, written with a one-hour `expirationTtl`. The request-link abuse
  limit above; no addresses, no raw IPs.

## Runtime choice: Cloudflare Workers

This Worker follows the same pattern as the other three Workers in this repo
(`issuer/`, `telemetry-cloudflare/`, `waitlist/`): Cloudflare Workers, KV for
state, Wrangler for deploy. Matching the existing pattern was chosen over
introducing a second hosted runtime, with these named trade-offs (per the
workstream brief's requirement that H2 record what reversing this choice
would cost, since it is one of the two highest-reversal-cost points in the
workstream):

- **Adapter fetch portability.** Every one of this repo's 86 network adapters
  already speaks in terms of `fetch` through `src/shared/resilience.ts`
  (`withResilience`), not a Node-specific HTTP client. That maps onto the
  Workers runtime's native `fetch` directly, which is what makes H4 (remote
  MCP transport running adapters against real network APIs) plausible on
  Workers at all. A Node service would need the same portability property
  anyway to reuse the adapters unmodified, so this is not a Workers-specific
  win, but it does mean Workers is not a foreign shape for this codebase.
- **CPU limits for large report aggregation.** Workers bills and limits CPU
  time per request (tens of milliseconds of *active* CPU on the standard
  plan, more on paid tiers, but still bounded), which is a real constraint
  for a QBR-style report that aggregates months of transactions across
  several networks in one request. H6's scheduled digest already plans
  around this by running as a background job rather than an inline request,
  but any future *synchronous* large-aggregation endpoint would need either
  chunking, a queue-backed job, or accepting a Node service for that one
  path. This has not bitten H2 (auth has no aggregation), but it is the
  concrete cost this record is flagging for whoever builds that endpoint.
- **What reversing to a Node service would cost.** The auth surface itself
  (KV get/put/delete, WebCrypto Ed25519, `fetch` to Resend) has no
  Workers-only API in it — `identity.ts` and `token.ts` are portable as-is.
  The cost of reversing would be entirely operational: standing up hosting,
  a KV-equivalent store (or a real database, which KV is not, and should not
  be asked to become), and TLS/deploy tooling that Wrangler currently
  provides for free. That is a one-time migration cost, not an ongoing
  design constraint, which is why Workers is the recommended default and
  this record exists precisely so that trade-off is visible before it is
  paid.

## Deploy checklist (all human-supplied — the Worker is inert without these; Rob-only)

1. `npm install`.
2. Create a fresh KV namespace and paste the ids into `wrangler.toml`:
   `npx wrangler kv namespace create HOSTED_USERS` (and `--preview`).
3. In Resend: verify the sending domain used in `src/index.ts`
   (`sign-in@agenticaffiliate.ai`) so transactional sends are not rejected or
   spam-folder-routed. This is a different Resend use than the waitlist
   Worker's audience-contact capture; see
   `docs/decisions/2026-07-13-build-hosted-without-presell.md` for why reusing
   Resend here is in scope even though the waitlist-marketing decision that
   originally chose Resend was rescinded.
4. `npx wrangler secret put RESEND_API_KEY` — a Resend API key (`re_…`) from
   https://resend.com/api-keys.
5. `npm run gen-keypair` → set the printed PRIVATE key as the Worker secret:
   `npx wrangler secret put SESSION_SIGNING_KEY`. Unlike the issuer Worker,
   there is no public key to distribute anywhere else; this Worker derives
   its own verification key from the private one at call time (see
   `src/token.ts`).
6. Set `PUBLIC_BASE_URL` in `wrangler.toml` to the Worker's own deployed
   origin (the `workers.dev` URL or the custom domain). Sign-in emails embed
   this origin in the magic link; the Worker refuses to mint links (500)
   while it is unset or invalid.
7. Confirm `SITE_ORIGIN` in `wrangler.toml` matches the live hosted-product
   front-end origin.
8. `npm run deploy`.

## Local checks

- `npm test` — request-link neutrality (including the identical over-limit
  response), the configured-origin magic link (a poisoned request Host never
  reaches the email), single-use token consumption, expiry, session
  sign/verify roundtrip, tamper rejection, health, CORS, and that no log
  line ever contains an email address. Resend is mocked via a spy on
  `fetch`; KV is an in-memory fake. No live network calls.
- `npm run typecheck`.

## What this slice deliberately does not do

- No credential vault, no network API keys, no affiliate data of any kind
  (H3, gated on the KMS decision named in the custody record).
- No remote MCP transport, no adapter wiring, no rate limiting or audit log
  (H4).
- No guided connect flow, no billing/entitlement enforcement (H5, H6).

`src/shared/request-context.ts` (H1) is the seam H4 will use to run adapter
calls under a per-tenant identity; this slice does not touch it or wire any
adapter to it.
