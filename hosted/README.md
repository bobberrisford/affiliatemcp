# affiliate-mcp hosted

A Cloudflare Worker for the hosted service: user auth (workstream slice H2),
the encrypted credential vault (workstream slice H3), the guided connect flow
(workstream slice H5), and Stripe subscription state plus the scheduled
digest's send surface (workstream slice H6), per
`docs/product/hosted-mvp-workstream.md`.

Three KV namespaces, kept deliberately separate:

- `HOSTED_USERS` (H2) holds **no affiliate credentials and no affiliate
  data**. It knows a user id and an email-hash lookup, and nothing else.
- `HOSTED_VAULT` (H3) holds the encrypted credential vault: one wrapped data
  key per user and one encrypted blob per connected network. See "Vault
  (H3)" below for the design, and "Vault threat model" for the honest
  read on what the current master-key design does and does not protect
  against — **the master-key decision it raises was accepted by Rob on
  2026-07-14 (Worker-secret design for the MVP).**
- `HOSTED_BILLING` (H6) holds Stripe subscription state: tier, status, and
  (the one deliberate exception in this Worker, **accepted by Rob on
  2026-07-14**) a billing email captured at Checkout. See "H6: digest and
  billing" below for the design, and "Digest orchestration and token
  scopes: threat model" for the redesign history — **the first H6 draft's
  all-capability service secret was rejected by Rob on 2026-07-14; the
  in-Worker Cron Trigger plus digest-scoped tokens documented there is the
  replacement, and no credential in the system can enumerate tenants or
  mint sessions from outside the Worker.**

See the decision records: `docs/decisions/2026-07-12-hosted-credential-custody.md`
(the custody contract this whole workstream operates under) and
`docs/decisions/2026-07-13-build-hosted-without-presell.md` (why this ships
directly, and why the waitlist Worker's Resend pattern is reused here).

## Model (H2: auth)

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
   single-use), creates the user record on first sign-in, and — for a plain
   sign-in — sets a freshly-issued session token as an HttpOnly cookie and
   303-redirects to the browser dashboard (`/connect`). No token is shown for
   the user to copy. (When the sign-in was started from an OAuth authorization,
   it resumes into the consent page instead; see "OAuth (slice 1)" below.) See
   "Callback delivery: HttpOnly cookie" below.
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

### Callback delivery: HttpOnly cookie

The plain sign-in callback establishes the browser dashboard session as an
HttpOnly cookie and 303-redirects to `/connect`. It does not render a token for
the user to copy. This is the slice-3 model
(`docs/decisions/2026-07-15-hosted-connector-oauth.md`): MCP clients no longer
authenticate with a pasted token — they use OAuth ("Add custom connector"),
where the client performs the code exchange — so the only remaining consumer of
this session is the browser dashboard itself, and a cookie is the right shape
for a browser.

- The cookie is `hosted_session=<token>; HttpOnly; Secure; SameSite=Lax;
  Path=/; Max-Age=<30 days>` (`setSessionCookieHeader`, `src/http.ts`).
  `HttpOnly` keeps it out of page scripts, `Secure` keeps it off plain HTTP,
  and `SameSite=Lax` is required here: the magic link is opened cross-site (from
  an email client), so the callback's 303 to `/connect` is part of a cross-site
  navigation chain — a `Strict` cookie would be withheld on it and the dashboard
  would re-prompt. `Lax` is sent on top-level GET navigations, so `/connect`
  loads signed in. (An earlier build shipped `Strict` and hit exactly that bug.)
- CSRF: `SameSite=Lax` is not sent on cross-site POSTs or subresource requests,
  so it still blocks a forged cross-site submission. As defence in depth, the
  state-changing POSTs
  (the connect credential store and the two billing actions) additionally
  require a same-origin `Origin`/`Referer` (`sameOriginPost`, `src/http.ts`)
  and return a 403 page otherwise. Idempotent navigation POSTs (the list, the
  form, retest) do not carry the check.
- The token is never rendered into a page, a URL, or a form body — the browser
  holds it in the cookie and re-presents it automatically. `src/index.ts`'s
  earlier `renderSessionPage` (a copyable token box) is removed.
- Distinct from the API-route auth, which is unchanged: `/vault/*`, `/account`,
  `/billing/*`, and `/auth/session/verify` keep their `Authorization: Bearer`
  auth (`requireSession`/`requireFullSession`, `src/routes/guard.ts`), because a
  non-browser MCP client and the transport present the token in a header, never
  a cookie.

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

## OAuth (slice 1): connector authentication

Governed by `docs/decisions/2026-07-15-hosted-connector-oauth.md` (Accepted
2026-07-15). This is client-to-transport authentication per the MCP
authorization framework: an OAuth 2.1 authorization-code flow with PKCE, so an
MCP client (Claude, ChatGPT, and similar) performs the code exchange and
stores the tokens itself, and the user pastes nothing. It replaces the old
"copy this 30-day bearer into your MCP client's connection settings" step,
which was both the funnel's worst UX moment and a leak-prone credential shape.

This is deliberately distinct from two other things and must not be conflated
with either: it is not H5's network-credential collection (Awin/CJ/Impact/
Rakuten keys stored in the vault), and it is not H5's "OAuth where supported"
wording, which refers to a **network's** OAuth (e.g. Rakuten's
client-credentials exchange). This governs only how the MCP **client** proves
who the user is to the hosted transport.

### Endpoints (`src/routes/oauth.ts`, storage in `src/oauth.ts`)

```
GET  /.well-known/oauth-authorization-server  RFC 8414 discovery document
POST /register                                RFC 7591 dynamic client registration
GET  /authorize                               validate the request + render the sign-in page
POST /authorize/email                         send the magic link for this authorization
POST /authorize/consent                       approve/deny → issue code, redirect to the client
POST /token                                   authorization_code and refresh_token grants
```

### The flow

1. The client reads the metadata document, (dynamically) registers to get a
   `client_id`, and opens the user's browser at `GET /authorize?...` with a
   PKCE `code_challenge` (S256), `redirect_uri`, and `state`.
2. `/authorize` validates the request and renders a sign-in page: one email
   field. This **reuses the existing magic-link identity** — there is no
   second account system and no password. Submitting the email
   (`POST /authorize/email`) sends the *same* magic link the ordinary sign-in
   uses (`dispatchMagicLink`, `src/auth-link.ts`, shared code so the
   account-enumeration neutrality, per-address/per-IP abuse limit, and
   "link origin is `PUBLIC_BASE_URL`, never the request Host" guarantees are
   identical), carrying the pending authorization request id in the
   pending-link record — never in the emailed URL.
3. The user clicks the link. `GET /auth/callback` consumes it, establishes
   identity exactly as before, and — because the pending record carries an
   `authRequestId` — renders the **consent page** instead of the session
   page. Consent identity is proved by a short-lived full session token in a
   hidden form field, the same header-or-hidden-field, never-a-URL discipline
   the H5 connect flow uses (`src/routes/connect.ts`).
4. Approving mints a single-use authorization code bound to the PKCE
   challenge and 302-redirects the browser back to the client's
   `redirect_uri` with `code` and `state`. Denying redirects with
   `error=access_denied`.
5. The client exchanges the code at `POST /token` with its `code_verifier`
   (PKCE S256), receiving a short-lived access token and a refresh token, and
   stores both. The user never sees or handles a token.

### Token model

- **Access token** is a short-lived (`OAUTH_ACCESS_TOKEN_TTL_SECONDS`, one
  hour), **full-scope** `amcps_` hosted session token — the exact wire format
  the sign-in flow already mints (`src/token.ts`), so `POST /auth/session/verify`
  and therefore the transport that already calls it
  (`src/hosted-transport/session-auth.ts`) verify it with no change. That is
  what keeps bearer acceptance working through the staged migration below.
  OAuth never mints a digest-scoped token (those stay internal to the
  scheduled digest, `src/digest.ts`), so the full-vs-digest distinction the
  decision requires be preserved holds by construction.
- **Refresh token** is an opaque, server-side, rotated-on-use `amcpr_`
  credential, stored only as its SHA-256 hash. Deliberately a different shape
  from the access token so it can never be presented to the transport as a
  bearer and accepted. Rotated on every use (old hash deleted, new one
  written), so a leaked-then-used refresh token surfaces as a reuse of a
  now-unknown token.

### PKCE and client registration

- **PKCE is mandatory and S256-only.** `plain` is refused (RFC 7636 §4.2
  permits this and the MCP framework mandates S256 for public clients). A
  request without a valid `code_challenge` is refused at `/authorize`.
- **Public clients only.** Every client is `token_endpoint_auth_method:
  "none"`; there is no `client_secret` anywhere in this design. A registration
  asking for a confidential auth method is refused rather than silently
  downgraded.
- **Dynamic client registration** (`POST /register`, RFC 7591) is supported
  for clients that use it (Claude and ChatGPT both do). `redirect_uris` must
  each be an absolute `https` URL or an `http` **loopback** URL
  (`127.0.0.1`/`localhost`/`[::1]`, RFC 8252 §7.3 for native apps); anything
  else is refused, and `/authorize` requires an exact-string match against a
  registered URI, so the endpoint can never be turned into an open redirector.
- **Static registration path** for a client that does not implement DCR:
  pre-provision a client record directly in KV (run from `hosted/`), then hand
  the client the printed `client_id`:

  ```sh
  npx wrangler kv key put --binding HOSTED_USERS "oauth:client:oauth_client_<id>" \
    '{"clientId":"oauth_client_<id>","redirectUris":["https://client.example/callback"],"clientName":"My Client","createdAt":1752580800}'
  ```

### Custody contract unchanged

This slice is about client identity auth, not credential storage. The accepted
custody contract (`docs/decisions/2026-07-12-hosted-credential-custody.md`:
bring-your-own-key, read-only, decrypt at call time, serve only the key's
owner, self-serve export and hard delete) is untouched. Nothing here holds or
does anything new with affiliate data; the `oauth:*` records are auth tokens
in `HOSTED_USERS`, never credentials.

### Staged migration (this is a live surface)

Tokens are already in the wild, so the swap is staged, not a hard cutover.
**Slice 1 did only the authorization-server half:** it added the endpoints
above and made the OAuth flow the primary path, and reworded the plain sign-in
callback page so it was no longer the primary "paste this into your MCP client"
surface. Bearer **acceptance was intentionally unchanged** in that slice —
existing `amcps_` bearers kept working, and the browser connect/manage flow
still used a pasted session token — so nothing already connected broke. (Slice 3
below then removed the pasted-token surface entirely; see its bullet.)

Slice progress:

- **Slice 2 — transport dual-accept then bearer removal (transport side
  landed).** An OAuth access token and a legacy pasted bearer are the same
  `amcps_` wire format and differ only in lifetime, so the transport
  (`src/hosted-transport/session-auth.ts`) already accepts OAuth access tokens
  with no change. To tell the two apart, `POST /auth/session/verify` now
  returns `iss` (issued-at) alongside `exp`, and the transport can enforce a
  maximum token lifetime (`exp - iss`). The lever is the
  `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` env var read by the transport
  (`src/hosted-transport/env.ts`):
  - **unset (default)** — the dual-accept window: both OAuth access tokens and
    the legacy long-lived bearers are accepted, so nothing already connected
    breaks;
  - **set** (recommended ~7200, comfortably above the one-hour OAuth
    access-token TTL and far below the 30-day bearer) — long-lived bearers are
    rejected while short-lived OAuth access tokens keep working. Flipping it on
    is therefore both the cutover and the documented revocation path for every
    outstanding pasted bearer at once.

  Digest-scope refusal is preserved, and a token whose lifetime cannot be
  computed (no numeric `iss`) fails closed once the cap is set. Short-lived
  access tokens plus refresh are issued by slice 1's `/token` endpoint above.
- **Slice 3 — connect-page rewrite (implemented).** The pasted-token affordance
  is gone: `renderSessionPage` is removed, the plain sign-in callback sets an
  HttpOnly `hosted_session` cookie and redirects to the dashboard, and the
  browser connect/manage pages (`src/routes/connect.ts`,
  `src/routes/billing-page.ts`) authenticate from that cookie rather than a
  hidden-field POST token. The connect terminal step is now a client-native
  "add connector" affordance (OAuth, nothing to paste). State-changing POSTs
  carry a same-origin CSRF check on top of `SameSite=Lax`. See "Callback
  delivery: HttpOnly cookie" and "Session gating on plain HTML pages" above.
  The API routes' bearer auth and the OAuth ceremony are unchanged.
- **Slice 2b — transport OAuth discovery (implemented).** The pieces above make
  the Worker a complete authorization server, but an MCP client discovers it by
  the MCP authorization framework's handshake against the **resource server**
  (the hosted transport, a different origin): it calls the transport, gets a
  `401` carrying `WWW-Authenticate: Bearer resource_metadata="…"`, fetches that
  protected-resource metadata (RFC 9728,
  `GET /.well-known/oauth-protected-resource`), and follows its
  `authorization_servers` to this Worker's issuer. The transport
  (`src/hosted-transport/http-server.ts`) now serves that metadata document and
  puts the `WWW-Authenticate` challenge on both `/mcp` 401 branches (adding
  `error="invalid_token"`, RFC 6750 §3, on a rejected token). Both are gated on
  the transport's own public origin, `HOSTED_TRANSPORT_PUBLIC_URL`
  (`src/hosted-transport/env.ts`): **unset** disables discovery and preserves
  the previous bare-401 behaviour (backward-compatible); **set** advertises the
  auth server so a client pointed only at the transport can find the Worker. The
  metadata endpoint is unauthenticated and carries no secret — only the
  transport's public origin and the auth server's public issuer. On the Worker
  side, the connect success page shows the real connector URL to add when
  `HOSTED_CONNECTOR_URL` is set (`src/env.ts`), and the honest placeholder
  otherwise.

## KV storage shapes (H2: `HOSTED_USERS`)

One namespace, four base key shapes plus the OAuth records above, no affiliate
data in any of them:

- **`user:<userId>`** → `JSON { id, createdAt, emailHash }`. `userId` is an
  opaque `hosted_usr_<uuid>` string; nothing PII-bearing is embedded in it. No
  raw email address is stored in this record, or anywhere else in this Worker
  (see the trade-off above for what that costs on key rotation). `emailHash`
  is the `email-hash:<hmacHex>` key that resolves to this user — carried on
  the record so `DELETE /account` (H3, below) can remove that reverse-lookup
  entry too, rather than stranding it pointed at a deleted user.
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

## Vault (H3): encrypted credential storage

`src/vault.ts` implements per-user envelope encryption for network
credentials, in a separate KV namespace (`HOSTED_VAULT`) from H2's identity
store. Routes: `src/routes/vault.ts` (`POST`/`GET`/`DELETE /vault/credentials`)
and `src/routes/account.ts` (`DELETE /account`), all requiring the same
session token H2 issues (`src/routes/guard.ts`).

### Design

- **Per-user data key.** The first time a user connects any network, the
  vault generates one random AES-256 key for them (`getOrCreateRawDataKey`).
  Every network they subsequently connect reuses that same data key — one key
  per user, not one per credential.
- **Envelope encryption.** Each credential record is AES-256-GCM-encrypted
  under that data key, with a fresh random IV per record. The data key itself
  is never stored raw: it is wrapped by a `MasterKeyProvider` before being
  written to KV.
- **The `MasterKeyProvider` seam.** `src/vault.ts` defines the interface
  (`wrapDataKey` / `unwrapDataKey`) and ships exactly one v1 implementation,
  `workerSecretMasterKey`: AES-256-GCM key-wrap using a Worker secret,
  `VAULT_MASTER_KEY` (32 random bytes, base64; generate with
  `npm run gen-vault-key`). Every wrapped blob is tagged with
  `{ provider, keyVersion }`, so a future KMS-backed provider (for example,
  one that calls an external KMS's wrap/unwrap API over `fetch` instead of
  holding key material in the Worker) implements the same three-method
  interface and drops in without touching any stored data shape, and without
  needing to re-encrypt a single credential blob. See "Vault threat model"
  below for why this seam exists and what decision it is waiting on.
- **Decrypt only at call time.** `getCredentials` decrypts on every call; the
  vault never caches plaintext. Nothing in this slice holds a decrypted
  credential in memory longer than the one operation that needed it.

### API (`src/vault.ts`)

```
putCredentials(kv, provider, userId, network, record)  → void
getCredentials(kv, provider, userId, network)          → CredentialRecord | null
listNetworks(kv, userId)                               → string[]
deleteCredential(kv, userId, network)                  → void
deleteUser(kv, userId)                                 → void   (complete deletion)
rotateMasterKey(kv, oldProvider, newProvider)           → { rotated, skipped }
```

`kv` and `provider` are explicit parameters rather than implicit globals, so
the module stays testable without a real Worker environment and so a caller
can point different calls at different providers during a rotation.

### KV storage shapes (H3: `HOSTED_VAULT`)

- **`vault:key:<userId>`** → `StoredWrappedKey`:
  `{ v: 1, provider, keyVersion, algorithm: "AES-256-GCM", iv, ciphertext, createdAt, rotatedAt? }`.
  One per user, created on their first `putCredentials` call, re-wrapped
  (never re-created) by `rotateMasterKey`.
  Known residual: two concurrent first-ever `putCredentials` calls for the
  same user can each mint a data key and race this single write; the losing
  call's credential blob becomes permanently undecryptable, silently. KV has
  no atomic primitive to close this. Compensating controls: H5's connect
  flow must store credentials sequentially per user (one network at a time),
  and a Durable Object per user is the real fix if parallel stores are ever
  needed.
- **`vault:cred:<userId>:<network>`** → `StoredCredentialBlob`:
  `{ v: 1, network, algorithm: "AES-256-GCM", iv, ciphertext, createdAt, updatedAt }`.
  One per connected network. `network` is validated against a
  `[a-z0-9-]{1,64}` slug pattern before it is ever used to build a KV key, so
  a caller cannot smuggle a colon or path segment out of their own
  `vault:cred:<userId>:` prefix.

### Rotation procedure

1. `npm run gen-vault-key` to generate a fresh 32-byte key.
2. `npx wrangler secret put VAULT_MASTER_KEY` with the new value — Wrangler
   secrets are single-slot, so capture the OLD value first if a same-process
   rotation script will need it (or keep the old provider constructed from a
   value you still hold; do not rely on reading the live secret back out).
3. Bump `VAULT_MASTER_KEY_VERSION` in `wrangler.toml` (the key version tag
   is what lets rotation detect "already migrated" vs "still on the old
   key" — see the caveat in `workerSecretMasterKey`'s doc comment: reusing
   the same version for a different secret is invisible to this check).
4. Run `rotateMasterKey(kv, oldProvider, newProvider)` once, from an
   operational script or a one-off Worker route restricted to Rob, with
   `oldProvider = workerSecretMasterKey(oldSecret, oldVersion)` and
   `newProvider = workerSecretMasterKey(newSecret, newVersion)`. It re-wraps
   every user's data key and returns `{ rotated, skipped }`; it is safe to
   re-run (already-rotated keys are skipped, not re-rotated).
5. Confirm `{ skipped: 0 }` on a re-run before removing the old secret value
   from wherever it was held during the rotation window. Credential blobs are
   never touched by this procedure — only the wrapped data keys.

### Deletion

- **`DELETE /vault/credentials/:network`** removes one network's credential.
  Idempotent.
- **`DELETE /account`** is complete deletion (`src/routes/account.ts`):
  every `vault:key:<userId>` and `vault:cred:<userId>:*` entry in
  `HOSTED_VAULT`, plus `user:<userId>` and its `email-hash:<hmacHex>` entry in
  `HOSTED_USERS`. What it deliberately does not touch, and why, is documented
  in the file-header comment of `src/routes/account.ts`: already-issued
  session tokens are stateless and are not revoked (they simply stop being
  useful, since there is nothing left for them to reach), and the TTL'd
  `pending-link:`/`rl:*` entries are self-expiring and not user-scoped.

### Vault threat model

An honest read of the v1 (`workerSecretMasterKey`) design, by what an
attacker gains from each compromise:

- **(a) `HOSTED_VAULT` KV compromise alone: nothing.** Every credential blob
  is AES-256-GCM ciphertext under a per-user data key, and every data key is
  itself AES-256-GCM ciphertext under the master key. A dump of this
  namespace, on its own, yields two layers of ciphertext and no key material
  to open either one. This is the property envelope encryption is for, and
  it holds regardless of which `MasterKeyProvider` is in use.
- **(b) Worker runtime compromise: everything in flight, and the master key
  itself.** `VAULT_MASTER_KEY` is a plain Worker secret, available to
  application code (this repo's own `src/vault.ts`) at the moment it wraps or
  unwraps a data key. Code running inside the compromised Worker can read
  that secret directly, and can decrypt any data key (and, by extension, any
  credential blob) it can reach in `HOSTED_VAULT`. This is the load-bearing
  fact of this design: the master key is not held outside the process that
  uses it.
- **(c) Cloudflare account compromise: everything.** An attacker with access
  to the Cloudflare account can read the Worker secret directly (or redeploy
  the Worker with code that exfiltrates it), then decrypt the entire vault at
  leisure. Managed-infrastructure custody does not change this: whoever
  controls the account controls every secret the account holds.

**This is envelope encryption on managed infrastructure, not KMS-backed
custody in the usual sense** — the defining property of a KMS-backed design
is that the master key never enters the calling process at all; wrap/unwrap
happens inside the KMS, reached over an authenticated API call, and a
compromise of the calling application's runtime (case (b) above) does not, by
itself, expose the key. The alternative this slice names but does not build:
an external KMS provider (for example, AWS KMS) implementing the same
`MasterKeyProvider` interface, calling KMS's `Encrypt`/`Decrypt` (or
`GenerateDataKey`) over HTTP for every wrap/unwrap instead of holding
`VAULT_MASTER_KEY` in the Worker at all. The cost: one network round-trip per
wrap/unwrap (data keys are wrapped once per user and unwrapped once per
`getCredentials` call, not once per byte of credential data, so this is a
small, bounded number of extra calls, not a per-request tax on every
credential read) and a second cloud dependency (an AWS account, IAM policy,
and KMS key, alongside Cloudflare) that the current v1 design has none of.

**Decision: Rob accepted the Worker-secret design for the MVP on
2026-07-14** (in-session, via the maintainer question tool), with the
`MasterKeyProvider` seam as the sanctioned KMS migration path. Revisit
before Team-tier or SOC 2 work; migration is a data-key re-wrap, not a
data migration.

## H4: remote MCP transport lives in the root workspace, not here

The workstream brief's own H2 write-up (above, "Adapter fetch portability")
assumed H4's remote MCP transport might run inside this Worker, calling
`getCredentials` (`src/vault.ts`) directly, in-process. H4's implementation
PR investigated that and found it infeasible, so the transport is a **Node
service in the root workspace** (`src/hosted-transport/`), not code added to
this Worker. The reasoning, so it is not silently assumed:

- **Code volume and Node-only dependencies.** `src/networks/**` (this repo's
  86 adapters) is roughly 120,000 lines, and the tool/prompt generators around
  them pull in `pino` (`src/shared/logging.ts`) and `node:fs`-based
  config, caching, and telemetry (`src/shared/config.ts`, `cache.ts`,
  `telemetry.ts`, `update-check.ts`, `cli/doctor.ts`, `cli/setup.ts`). None of
  that is Workers-portable the way this Worker's own code deliberately is —
  `src/token.ts`, `src/identity.ts`, and `src/vault.ts` use WebCrypto and
  `fetch` only, on purpose, specifically so they could run on Workers. The
  adapters and their supporting code were never written to that constraint.
- **Bundle size.** Even ignoring the portability problem, 120k+ lines across
  86 adapters is well past what a Workers script bundle can carry (1 MB
  compressed on the free plan, 10 MB on paid — and that is before this
  Worker's own code and dependencies).
- **What reversing this would cost.** Moving the transport into this Worker
  later would mean either rewriting every Node-only primitive above for the
  Workers runtime (an open-ended project touching shared code every adapter
  depends on) or accepting a nodejs_compat-based bundle at the code-volume
  cost noted above. Neither is a slice-sized change, which is why this is
  recorded as a real architectural decision, not a detail.

What this means for this Worker: it gains exactly one new route for H4,
**`GET /vault/credentials/:network/reveal`** (`src/routes/vault.ts`), which
decrypts and returns one network's credential to the session token's own
owner — the sole exception to "never returns a decrypted credential value
over HTTP" stated elsewhere in this document. It runs the identical
`requireSession` guard every other vault route uses, so it can only ever
serve the calling session's own credentials. The Node transport calls it with
the SAME bearer token the MCP client authenticated with — no service key with
elevated or cross-user read access exists anywhere in this design. See
`src/hosted-transport/http-server.ts` in the root workspace for the transport
itself, and `docs/product/hosted-mvp-workstream.md` for the full H4 slice.

## H5: guided connect flow

`src/routes/connect.ts` implements the workstream's guided onboarding for the
four hosted-eligible networks (Awin, CJ, Impact, Rakuten): server-rendered
HTML pages, no client framework, no external resources — matching the minimal
style of the H2 callback page. Routes, all session-gated:

```
GET|POST /connect                    sign-in prompt, or the network list + status
POST /connect/:network/form          guided credential form for one network
GET  /connect/:network               same form, Authorization-header callers only
POST /connect/:network               store the credential, then connection-test it
GET|POST /connect/:network/retest    re-run the connection test, no resubmit
```

"Four hosted-eligible networks" is the workstream's shorthand, not a claim
that all four carry `claim_status: "production"` in their own `network.json`
— only Awin does; CJ, Impact, and Rakuten are `"partial"` (see each
`network.json` and `REPORT.md`). The connect list page shows each network's
`claimStatus` next to its name rather than smoothing that distinction over.

None of the four adapters implements an interactive browser-redirect OAuth
flow. Rakuten's `auth_model: "oauth2"` is client-credentials (a client id and
secret pair exchanged for a token server-side, `src/networks/rakuten/auth.ts`
in the root workspace), entered by paste exactly like the other three
networks' credentials. So this flow is "guided paste-once" for all four, not
an OAuth redirect for any of them.

### Session gating on plain HTML pages: HttpOnly cookie, never a URL, body, or page

Every route above requires the same valid, full-scope session the H3 vault
routes require (`requireFullSession`, `src/routes/guard.ts`), verified with the
identical primitive, `resolveValidSession` (`src/token.ts`). What differs is
transport, not trust: these are pages a browser navigates to directly.

The browser dashboard authenticates via the HttpOnly `hosted_session` cookie
set at the plain sign-in callback (slice 3,
`docs/decisions/2026-07-15-hosted-connector-oauth.md`; "Callback delivery:
HttpOnly cookie" above). `resolveBrowserSession` (`src/routes/connect.ts`) reads
the token from the cookie first, then falls back to an `Authorization: Bearer`
header for the header-authenticated GET variants and any non-browser caller.
The token is never rendered into a page, a URL, or a form body — the browser
re-presents the cookie automatically on every same-site navigation. There is
deliberately no query-parameter fallback (RFC 6750 §2.3: request URLs land
verbatim in Cloudflare request logs, browser history, and bookmarks, and leak
outbound via the Referer header), and `test/connect-routes.test.ts` asserts
that a valid token in a query string is rejected on every connect route, and
that neither the token nor the cookie value ever appears in a rendered page.

Navigation between these pages is a small inline POST form the cookie
accompanies (`SameSite=Lax` attaches it on same-site navigations and top-level
GET navigations). As
defence in depth, every page is served `Referrer-Policy: no-referrer` on top of
the Worker-wide `cache-control: no-store`, so its token-free URLs leak nothing
outbound through the external documentation links these pages contain. The GET
variants of the list/form/retest routes exist only for callers that can send an
Authorization header; a browser without a cookie simply sees the sign-in prompt.

CSRF: `SameSite=Lax` is not sent on cross-site POSTs or subresource requests, so
it still blocks a forged cross-site submission. The state-changing POSTs — `POST /connect/:network`
(stores a credential) and the two billing action POSTs
(`src/routes/billing-page.ts`) — additionally require a same-origin
`Origin`/`Referer` (`sameOriginPost`, `src/http.ts`) and return a 403 page
otherwise. Idempotent navigation POSTs (the list, the credential form, retest)
do not carry the check. `test/connect-routes.test.ts` and
`test/billing-page.test.ts` assert a cross-site `Origin` is rejected with a 403.

An unauthenticated visitor sees a sign-in prompt page — an explanation and a
single email field that requests a magic sign-in link (`POST /connect/signin`) —
rather than `requireSession`'s JSON 401, which would be meaningless to a human
in a browser tab. Following the emailed link sets the cookie and lands them back
on the dashboard; there is nothing to paste. This replaces the earlier
hidden-field POST design, which the connect flow itself flagged as the reviewed
interim to a cookie session; slice 3 is that upgrade. Distinct from the API-route
auth, which is unchanged: `/vault/*`, `/account`, `/billing/*`, and
`/auth/session/verify` keep their `Authorization: Bearer` auth, because a
non-browser MCP client and the transport present the token in a header, never a
cookie.

### Sequential store per user (the H3 data-key race, enforced by construction)

`hosted/README.md`'s own "KV storage shapes (H3)" note above records that two
concurrent first-ever `putCredentials` calls for the same user can race the
single `vault:key:<userId>` write and silently orphan the loser's credential
blob, and that the compensating control is: **H5's connect flow must store
credentials sequentially per user, one network at a time.** This is not a
convention this flow merely follows — there is no route that accepts more
than one network's credentials in a single request. `POST /connect/:network`
takes exactly one network in its path and builds a credential record from
only that network's declared fields (`src/networks.ts`); the connect list
page never offers a combined "connect all" submission. A user connecting all
four networks makes four separate page loads and four separate POSTs.

### Connection test on save

After `putCredentials` stores the submitted credential, `handleConnectSubmit`
runs one cheap, read-only API call per network (`src/connect-test.ts`) using
the plaintext just submitted, replicating the exact request each network's
LOCAL adapter's own `verifyAuth()` already sends (`src/networks/<slug>/auth.ts`
in the root workspace) — not a new probe invented for this Worker. This
Worker cannot import the adapters directly (same reason as H4: they are
Node-only code; see "H4: remote MCP transport lives in the root workspace,
not here" above), so the request is replicated with a plain `fetch`, endpoint
and auth shape stated per network:

| Network | Request replicated | Source of truth |
| --- | --- | --- |
| Awin | `GET https://api.awin.com/accounts?type=publisher`, `Authorization: Bearer <AWIN_API_TOKEN>` | `src/networks/awin/auth.ts` `verifyAuth()` |
| CJ | `POST https://commissions.api.cj.com/query`, `Authorization: Bearer <CJ_API_TOKEN>`, the same minimal `{ me { ... } }` GraphQL query | `src/networks/cj/auth.ts` `verifyAuth()` |
| Impact | `GET https://api.impact.com/Mediapartners/{SID}/Campaigns?PageSize=1`, HTTP Basic `base64(SID:AUTH_TOKEN)` | `src/networks/impact/auth.ts` `verifyAuth()` |
| Rakuten | `POST https://api.linksynergy.com/token`, HTTP Basic `base64(CLIENT_ID:CLIENT_SECRET)`, form body `scope=<SID>` (the OAuth2 token exchange itself) | `src/networks/rakuten/auth.ts` `exchangeForToken()` / `verifyAuth()` |

On failure, the credential stays stored — the task's requirement is "keep it
stored, show the verbatim upstream status honestly, offer a retry", never
"invent success" and never "silently drop what the user just entered". The
result page shows the upstream HTTP status and a bounded snippet of the
upstream body (the network's own error response, not the user's secret) and
links to `GET /connect/:network/retest`, which re-runs the same test against
the already-stored credential without asking the user to retype it.

Known gap: the local CLI setup doc (`docs/networks/rakuten.md`) documents a
`RAKUTEN_TOKEN_URL` override for tenants provisioned against
`api.rakutenmarketing.com` instead of the default `api.linksynergy.com`. This
connect flow does not yet expose that override; a tenant on the alternate
host will see the connection test fail with a 404 even when the credentials
themselves are valid. Recorded here as a known limitation, not silently
unsupported — the fix is a fifth optional field on the Rakuten form, not
implemented in this slice.

### Least privilege

Per the custody record's clause 3 ("Where a network offers scoped or
read-only API keys, the connect flow instructs the user to create one"),
every network's form shows a least-privilege note (`src/networks.ts`,
`leastPrivilegeNote`). None of the four setup docs
(`docs/networks/{awin,cj,impact,rakuten}.md`) describes a scoped or
read-only key option for these networks today — each documents a single
long-lived credential (or, for Rakuten, one client id/secret pair) with the
same access the dashboard login itself has. The note says exactly that,
rather than assuming a scoped option exists where the docs are silent, or
assuming one does not exist on the network's own side — only that this repo
has not recorded one.

### No credential value ever rendered

Every HTML response after a store shows, at most, the stored credential's
**last four characters** (`maskLastFour` in `src/routes/connect.ts`) on one
designated field per network (the primary secret — `AWIN_API_TOKEN`,
`CJ_API_TOKEN`, `IMPACT_AUTH_TOKEN`, `RAKUTEN_CLIENT_SECRET`), never the full
value, and never any other field. `test/connect-routes.test.ts` asserts the
full submitted marker string never appears in any response body, on the
success path, the failure path, or the retest path.

### First-value pointer, honestly bounded

On a passing connection test, the result page shows the copyable session
token (the same one the H2 callback page issues) and a transport URL
**placeholder** — H4's remote MCP transport (`src/hosted-transport/` in the
root workspace) has not been deployed anywhere yet, so there is no real URL
to give. The page states this plainly rather than fabricating one, and
suggests a first prompt to try once a real MCP client is actually connected.
A full automatic first-value report (running that prompt end to end and
showing the result on this page) needs the Node H4 transport runtime, which
is out of this Worker's scope — stated on the page and here, rather than
faked.

## Hosted eligibility: ToS check

The custody record's implementation follow-ups
(`docs/decisions/2026-07-12-hosted-credential-custody.md`) require a
per-network terms-of-service check for third-party/hosted credential use
before a network is offered hosted in production. This repo's own docs
record only general statements that *some* networks prohibit third-party
credential holders (`docs/product/website-copy.md`,
`docs/product/solo-50k-revenue-plan.md`,
`docs/product/solo-50k-technical-roadmap.md`) — none of them name Awin, CJ,
Impact, or Rakuten specifically, and no per-network ToS review exists
anywhere in this repo today. Recording that absence honestly, per network,
rather than inferring a conclusion from the general statement:

- **Awin** — confirmed by Rob (2026-07-14): fine to offer hosted.
- **CJ Affiliate** — confirmed by Rob (2026-07-14): fine to offer hosted.
- **Impact** — confirmed by Rob (2026-07-14): fine to offer hosted.
- **Rakuten Advertising** — confirmed by Rob (2026-07-14): fine to offer
  hosted, covering the Publisher Solutions approval process noted in
  `docs/networks/rakuten.md`.

Rob confirmed all four in-session on 2026-07-14 ("confirmed we are fine").
Re-check on any network's ToS update; a network that later prohibits
third-party credential use reverts to local-only and the pricing page says
so, per the accepted custody record.

This connect flow being buildable and testable is not the same thing as any
network being cleared to run hosted in production — the acceptance proof the
workstream brief sets for H5 ("an end-to-end connect against a staging
deploy for each of the four networks, with each ToS check recorded") still
needs this table replaced with an actual per-network review before a staging
or production deploy offers these networks to real users.
## H6: digest and billing

Workstream slice H6 (`docs/product/hosted-mvp-workstream.md`) adds Stripe
subscription state and the scheduled digest: `src/billing.ts`,
`src/stripe.ts`, `src/routes/billing.ts`, `src/digest.ts` (the scheduled
orchestrator, driven by the Cron Trigger in `wrangler.toml`), and a THIRD KV
namespace, `HOSTED_BILLING`, kept separate from `HOSTED_USERS` (H2) and
`HOSTED_VAULT` (H3) for the same reason those two are separate from each
other: each namespace's contents should be inferable from its name alone,
not from convention.

### KV storage shapes (H6: `HOSTED_BILLING`)

- **`sub:<userId>`** → `SubscriptionRecord`:
  `{ tier: 'solo' | 'pro', status, customerId?, subscriptionId?, email?, updatedAt }`.
  `status` mirrors Stripe's own subscription status string (`active`,
  `trialing`, `past_due`, `canceled`, …); only `active`/`trialing` count as
  entitled (`isActiveStatus`).
- **`stripe-sub:<subscriptionId>`** → `<userId>`. Reverse index for
  `customer.subscription.updated`/`.deleted` webhook events, which do not
  reliably carry the userId directly. Mirrors the issuer Worker's
  `sub:<subId> -> accountKey` pattern (`issuer/src/index.ts`).
- **`evt:<eventId>`** → `"1"`, TTL'd 30 days. Webhook idempotency marker,
  identical in shape and purpose to issuer's own.

**The billing email exception (accepted by Rob, 2026-07-14).**
`SubscriptionRecord.email` is a plaintext address, captured from Stripe
Checkout's `customer_details.email` at `checkout.session.completed`. This is
a deliberate, narrow exception to H2's "no raw email address anywhere in
this Worker" posture (see "Email-key hashing trade-off" above): a paid
subscription needs a billing email for Stripe receipts and, per the pricing
decision, VAT invoices at the Team tier; Stripe Checkout already collects
one regardless of what this Worker does with it. It lives ONLY in
`HOSTED_BILLING`, never in `HOSTED_USERS`, so H2's existing no-PII invariant
for the identity store is unaffected. It is used for exactly two purposes:
Stripe's own billing correspondence, and resolving who to email when the
scheduled digest sends (`src/digest.ts`) — never analytics, matching the
custody record's "what the keys are used for" clause extended to this one
new field. `DELETE /account` deletes it with everything else
(`deleteSubscription`, `src/billing.ts`) — after deletion there is no
address left and the digest roster no longer contains the account.
`PRIVACY.md`'s hosted section states the same in user-facing terms.

### Why raw Stripe REST + WebCrypto, not the `stripe` npm package

Unlike `issuer/` (which already depends on `stripe`), this build's rules were
"no new deps", and everything else in `hosted/` is deliberately
WebCrypto-and-`fetch`-only (`src/token.ts`, `src/vault.ts` both call this out
as a design choice). `src/stripe.ts` hand-rolls the two calls this slice
needs: a `POST /v1/checkout/sessions` form-encoded REST call, and Stripe's
documented webhook-signature scheme (HMAC-SHA256 over `"{timestamp}.{payload}"`,
compared against the `Stripe-Signature` header's `v1` value(s), with a
5-minute replay-tolerance window). Both are small and bounded; if hosted's
Stripe surface grows materially beyond checkout + webhook (the billing
portal, proration previews), revisit this trade-off rather than keep hand
extending it.

### Tier derivation: metadata, not price-ID matching

`POST /billing/checkout` stamps the requested tier onto BOTH the Checkout
Session's own `metadata` and `subscription_data.metadata` at creation time
(mirroring issuer's `subscription_data: { metadata: { akey } }` pattern,
extended with a `tier` field). `checkout.session.completed` reads the
Session's own metadata directly; `customer.subscription.updated`/`.deleted`
read the Subscription's. Neither event needs to introspect price IDs or line
items to recover the tier — it is simply carried on the object the event
already delivers.

### Digest orchestration and token scopes: threat model

**Decision history, stated plainly.** The first H6 implementation authorised
an external digest job with a single all-capability shared secret
(`HOSTED_SERVICE_SECRET`) that could enumerate every subscriber and mint a
session for any userId from outside this Worker. **Rob rejected that design
on 2026-07-14** and required this narrower shape; in the same decision he
**accepted the billing-email KV exception** (above). The invariant the
rejection restored: **no credential anywhere in this system can enumerate
tenants or mint sessions for arbitrary users from outside the Worker.**

**The shape that replaced it.** The digest loop runs INSIDE this Worker, as
a Cloudflare Cron Trigger (`scheduled` in `src/index.ts`, orchestration in
`src/digest.ts`, schedule in `wrangler.toml` `[triggers]`):

1. The roster is enumerated in-process from `HOSTED_BILLING` KV
   (`listActiveSubscribers`) — it is never exposed over HTTP.
2. For each subscriber, the Worker mints a session token SCOPED to
   `digest` (`src/token.ts`, `scope` claim) for exactly that userId, valid
   for at most 15 minutes (`DIGEST_TOKEN_TTL_SECONDS`). The Worker already
   holds `SESSION_SIGNING_KEY`, so this adds no new credential — minting is
   a capability it had by construction.
3. It calls the Node compose service (`src/hosted-digest/` in the root
   workspace; `DIGEST_SERVICE_URL`) with `{ userId, digestType }` and that
   token as the bearer, and receives the rendered `{ subject, body }` text
   back. The compose service needs the 86-adapter registry and the H1 seam
   — the same Node-only code H4's write-up above explains this Worker
   cannot carry — and uses the token against the vault list/reveal routes
   exactly as the hosted MCP transport does.
4. It re-checks tier entitlement against the freshly-read record, resolves
   the billing email from `HOSTED_BILLING`, and sends via Resend — the
   email never leaves this Worker. One audit line per send attempt (userId,
   digestType, timestamp, outcome; never the address, never the content).

**What a digest-scoped token can and cannot do.** Accepted by exactly two
routes, both read-only and both still serving only the token's own userId:
`GET /vault/credentials` (list) and `GET /vault/credentials/:network/reveal`.
Rejected everywhere else, each with a test (`test/scope.test.ts`): vault
store and delete, `DELETE /account`, `POST /billing/checkout`,
`GET /billing/entitlement`, every connect page, and the hosted MCP transport
itself (`src/hosted-transport/session-auth.ts`, root workspace, refuses
`scope: "digest"` at verification). Tokens with no scope claim are full
sessions, so every previously issued token behaves exactly as before.

**Every remaining secret, and what its leak grants — one sentence each:**

- `SESSION_SIGNING_KEY`: full compromise — the holder can mint valid
  sessions for any user (unchanged from H2; this key was always the crown
  jewel, and it never leaves this Worker).
- `VAULT_MASTER_KEY`: decrypts every stored credential IF the holder also
  has the `HOSTED_VAULT` KV contents (unchanged from H3's accepted
  threat model, "Vault threat model" above).
- `RESEND_API_KEY`: the holder can send email as the verified domain and
  read Resend-side delivery metadata; it reaches no affiliate data and no
  stored addresses in this system.
- `STRIPE_SECRET_KEY`: full Stripe account API access — billing compromise
  (customers, subscriptions, refunds), no affiliate data.
- `STRIPE_WEBHOOK_SECRET`: the holder can forge subscription-lifecycle
  events, granting or cancelling ENTITLEMENTS (tier state) — but cannot
  read credentials, data, or email addresses through any route.
- `DIGEST_COMPOSE_SECRET` (optional): the holder can ring the compose
  service's endpoint and nothing more — every read the compose service
  performs is authorised by a per-user digest token it does not have; a
  doorbell, not a key.

There is deliberately NO secret in that list whose leak enumerates users or
mints tokens: the roster never crosses a network boundary, and minting
requires `SESSION_SIGNING_KEY` itself.

**What this does NOT yet have:** no per-run audit beyond the per-send lines
and the run summary (counts only); and the doorbell has no automatic
rotation procedure (manual `wrangler secret put` plus updating the compose
service's env, same as every other secret in this repo). Revisit alongside
the vault's KMS migration if Team-tier or SOC 2 work raises the bar.

### Billing (Stripe checkout, portal, and the billing page)

Stripe-wiring follow-up to H6: subscribing, upgrading, and managing a
subscription are now entirely self-serve through the Worker's own billing
page, `GET|POST /connect/billing` (`src/routes/billing-page.ts`), reachable
from a `billing` link on the connect list page
(`GET|POST /connect`, `src/routes/connect.ts`). No manual step is needed for
the normal case of a user signing up, upgrading Solo to Pro, or cancelling.

The page reads the caller's tier and status from the existing
`GET /billing/entitlement` logic (called in-process, not over HTTP) and shows:

- **Tier none:** a "Subscribe Solo" button (£34/month) and a "Subscribe Pro"
  button (£99/month).
- **Tier Solo:** an "Upgrade to Pro" button and a "Manage subscription"
  button.
- **Tier Pro:** a "Manage subscription" button only (nothing higher to
  subscribe to).

Each button is a small inline POST form the browser session cookie
accompanies, identical in shape to every other navigation form in this connect
flow (see "Session gating on plain HTML pages" above); the subscribe/upgrade
buttons also carry a hidden `tier` field. The two state-changing routes below
additionally require a same-origin request (`sameOriginPost`, `src/http.ts`)
as a CSRF check on top of the cookie's `SameSite=Lax`, returning a 403 page
otherwise. Two further POST-only routes do the actual work:

- **`POST /connect/billing/checkout`** resolves the browser's session, then
  calls `handleBillingCheckout` (`src/routes/billing.ts`) directly, in
  process, with a synthetic same-worker request carrying that session as an
  `Authorization` header (never sent over the wire, never in a URL), and
  303-redirects the browser to the Stripe Checkout URL it returns.
- **`POST /connect/billing/portal`** does the same for the new
  **`POST /billing/portal`** route (`src/routes/billing.ts`,
  `createBillingPortalSession` in `src/stripe.ts`): it creates a Stripe
  Billing Portal session for the caller's OWN Stripe customer id, read from
  their own `sub:<userId>` record, never a customer id supplied by the
  request. The portal is where a subscriber actually cancels, changes payment
  method, or (if enabled in the Stripe dashboard's portal configuration)
  switches plans; this Worker only mints the one-time URL and never sees
  what happens inside it. `POST /billing/portal` is full-session-gated
  exactly like checkout and entitlement, and returns `404 unknown_account`
  for a caller with no recorded Stripe customer id (never subscribed, or
  subscribed but the webhook has not yet run) rather than a generic error.

**Stripe-return honesty, no workaround.** `BILLING_SUCCESS_URL`,
`BILLING_CANCEL_URL`, and `BILLING_PORTAL_RETURN_URL` (`src/env.ts`,
`wrangler.toml`) should all point back at this Worker's own billing page:
`${PUBLIC_BASE_URL}/connect/billing`, with `?checkout=success` or
`?checkout=cancelled` on the Checkout redirects (a plain, non-sensitive
status flag, never a token). Stripe's redirect is a cross-site top-level
navigation; the `SameSite=Lax` session cookie IS sent on it, so the caller
lands back on the billing page signed in. The page still never trusts the
redirect itself: it does not invent a session, silently poll Stripe, or
fabricate a "you're subscribed" result from the `checkout` flag.
`GET /billing/entitlement` (read in-process on the billing page too) is the
only source of truth for what actually happened, never the redirect itself; the
`?checkout=success|cancelled` flag is only a non-sensitive status hint. If for
any reason no valid session is present, the page falls back to the ordinary
sign-in prompt with one honest line describing what the flag claims
("Stripe reports checkout is complete. Sign back in above..." or "Checkout was
cancelled. Nothing was charged.").

**Dashboard prerequisites** (Rob-only, one-time, per the deploy checklist
below): create the Solo and Pro recurring Prices, set the two price-id env
vars, and if Solo-to-Pro in-place upgrades should avoid opening the portal,
put both Prices on one Stripe Product so Checkout's subscription-mode
behaviour replaces the existing subscription's price on the next invoice
rather than starting a second one. Enabling the **Stripe Customer Portal**
itself, in the Stripe dashboard's Billing settings, is required before
`POST /billing/portal` will succeed; an unconfigured portal returns a Stripe
API error, surfaced here as `502 portal_failed`.

### Manual tier administration (break-glass only, now that Stripe is wired)

There is still no HTTP admin route that sets a tier for an arbitrary user:
that was part of the rejected all-capability-secret design (see "Digest
orchestration and token scopes" above) and remains rejected. With the billing
page above, this is no longer the documented path for a normal subscribe,
upgrade, or cancel; keep it as a break-glass appendix for support cases the
billing page cannot reach (a stuck webhook, a manual comp, an account with no
email on file). Rob grants or changes a tier directly in KV with Wrangler
(run from `hosted/`; these act on the namespace ids in `wrangler.toml`):

```sh
# Grant (or overwrite) a tier. updatedAt is unix seconds; email is optional
# but without one the digest cannot send (records a "no_email" outcome).
npx wrangler kv key put --binding HOSTED_BILLING "sub:hosted_usr_<id>" \
  '{"tier":"solo","status":"active","email":"person@example.com","updatedAt":1752505200}'

# Inspect a record.
npx wrangler kv key get --binding HOSTED_BILLING "sub:hosted_usr_<id>"

# Revoke: prefer status, which preserves the audit trail of having subscribed…
npx wrangler kv key put --binding HOSTED_BILLING "sub:hosted_usr_<id>" \
  '{"tier":"solo","status":"canceled","updatedAt":1752505200}'
# …or delete outright.
npx wrangler kv key delete --binding HOSTED_BILLING "sub:hosted_usr_<id>"
```

### Account deletion and Stripe

`DELETE /account` removes the subscription record (billing email included)
and the `stripe-sub:` reverse-index entry along with everything H2/H3
deleted — see `src/routes/account.ts`. Cancelling the live Stripe
subscription is a separate step: Stripe keeps billing until cancelled on
Stripe's side, and a later `customer.subscription.updated` webhook event
could rewrite the deleted record from Stripe's own data. With the billing
portal now wired up, a user can cancel there themselves before deleting
their account (`POST /connect/billing/portal`, above); if they do not, treat
"account deleted" as "cancel the subscription in the Stripe dashboard now",
same as before this follow-up.

## Deploy checklist (all human-supplied — the Worker is inert without these; Rob-only)

1. `npm install`.
2. Create a fresh KV namespace and paste the ids into `wrangler.toml`:
   `npx wrangler kv namespace create HOSTED_USERS` (and `--preview`).
3. Create a SECOND, separate KV namespace for the vault:
   `npx wrangler kv namespace create HOSTED_VAULT` (and `--preview`), and
   paste those ids in too. Do not reuse `HOSTED_USERS` for this — see the
   file-header note in `src/env.ts` for why they are kept apart.
4. In Resend: verify the sending domain used in `src/index.ts`
   (`sign-in@agenticaffiliate.ai`) so transactional sends are not rejected or
   spam-folder-routed. This is a different Resend use than the waitlist
   Worker's audience-contact capture; see
   `docs/decisions/2026-07-13-build-hosted-without-presell.md` for why reusing
   Resend here is in scope even though the waitlist-marketing decision that
   originally chose Resend was rescinded.
5. `npx wrangler secret put RESEND_API_KEY` — a Resend API key (`re_…`) from
   https://resend.com/api-keys.
6. `npm run gen-keypair` → set the printed PRIVATE key as the Worker secret:
   `npx wrangler secret put SESSION_SIGNING_KEY`. Unlike the issuer Worker,
   there is no public key to distribute anywhere else; this Worker derives
   its own verification key from the private one at call time (see
   `src/token.ts`).
7. **Before this step, read "Vault threat model" above and get Rob's explicit
   master-key decision — this is not a step to run ahead of that.**
   `npm run gen-vault-key` → set the printed key as the Worker secret:
   `npx wrangler secret put VAULT_MASTER_KEY`.
8. Set `PUBLIC_BASE_URL` in `wrangler.toml` to the Worker's own deployed
   origin (the `workers.dev` URL or the custom domain). Sign-in emails embed
   this origin in the magic link; the Worker refuses to mint links (500)
   while it is unset or invalid.
9. Confirm `SITE_ORIGIN` and `VAULT_MASTER_KEY_VERSION` in `wrangler.toml`
   match the live hosted-product front-end origin and the master key version
   just set.
10. Create a THIRD, separate KV namespace for billing state:
    `npx wrangler kv namespace create HOSTED_BILLING` (and `--preview`), and
    paste those ids into `wrangler.toml`.
11. In Stripe: create the Solo (£34/mo) and Pro (£99/mo) recurring Prices per
    `docs/decisions/2026-07-12-pricing-billing-and-licence.md`, put their ids
    in `STRIPE_PRICE_ID_SOLO`/`STRIPE_PRICE_ID_PRO`; enable Stripe Tax;
    register the webhook endpoint (`/billing/webhook`) for
    `checkout.session.completed`, `customer.subscription.updated`, and
    `customer.subscription.deleted`; enable the **Stripe Customer Portal**
    in the dashboard's Billing settings (required before
    `POST /billing/portal` will succeed); put the Solo and Pro Prices on one
    Stripe Product if Solo-to-Pro upgrades should replace the price in place
    rather than rely on the portal for the switch.
12. `npx wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
13. Set `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL`, and
    `BILLING_PORTAL_RETURN_URL` in `wrangler.toml` to this Worker's OWN
    billing page (`${PUBLIC_BASE_URL}/connect/billing`, with
    `?checkout=success`/`?checkout=cancelled` on the first two), not an
    external page: see "Billing (Stripe checkout, portal, and the billing
    page)" above for why.
14. Deploy the Node digest-compose service (`src/hosted-digest/` in the root
    workspace, `affiliate-networks-mcp hosted-digest` — see its
    `index.ts` header for the systemd unit) wherever the hosted MCP
    transport runs, then set `DIGEST_SERVICE_URL` in `wrangler.toml` to its
    origin. Optionally generate a doorbell (`openssl rand -base64 32`), set
    it on BOTH sides: `npx wrangler secret put DIGEST_COMPOSE_SECRET` here,
    the same value as `DIGEST_COMPOSE_SECRET` in the compose service's env.
    The Worker can be deployed BEFORE the compose service exists: the cron
    trigger no-ops with one log line while `DIGEST_SERVICE_URL` is unset.
15. Confirm the digest cadence in `wrangler.toml` `[triggers]` (weekly,
    Monday 06:00 UTC by default).
16. `npm run deploy`.

## Deploy on Cloudflare (all-in-one)

Step 14 above (deploy the Node digest-compose service) and H4's own deploy
note ("no real URL to give" — "First-value pointer, honestly bounded") both
assumed the two Node services (`src/hosted-transport/`, `src/hosted-digest/`,
root workspace) would run on a separate host from this Worker — a VPS,
Fly.io, Railway. Rob asked for an option to run those two services on
Cloudflare as well, via **Cloudflare Containers** (a container instance
attached to a Worker through a Durable Object binding), so the entire hosted
stack — this Worker, the vault, the transport, the digest-compose service —
can live in one Cloudflare account if that is the deploy Rob prefers. This
section documents that path. It is additive: nothing above changes, and
running the two Node services on a plain VPS/Fly.io/Railway host instead
(steps 14 above) remains equally valid — see "Fallback: any container host"
below.

### What was built, and where

- **`Dockerfile`** (repo root) — a multi-stage build (`npm ci` + `npm run
  build`, then a slim `node:22-alpine` runtime) that packages BOTH Node
  services into one image. A `CONTAINER_SERVICE` env var
  (`hosted-transport` or `hosted-digest`) selects which of the two the
  container process runs; see the Dockerfile's own header comment for why
  one image was chosen over two (the build step is identical for both, and
  Cloudflare's container scaling unit is the container CLASS in
  `wrangler.toml`, not the image).
- **`.dockerignore`** (repo root) — keeps the build context to
  `package.json`, `package-lock.json`, `tsconfig.json`, and `src/`; excludes
  `desktop/`, `docs/`, `site/`, `tests/`, the other Workers in this repo, and
  everything else this image does not run.
- **`containers/`** (repo root, a new, separate Worker workspace) — the
  Cloudflare Containers front door: `containers/wrangler.toml` declares two
  container classes (`McpTransportContainer`, `DigestComposeContainer`),
  both built from the repo-root `Dockerfile`, each bound to this Worker via a
  Durable Object binding; `containers/src/index.ts` implements the two
  Durable Object classes (each starts its container role and proxies the
  request to it over `getTcpPort`) and a small top-level router (`/mcp` and
  `/health` to the transport container; `/digest/health` and
  `/digest/compose` to the digest-compose container).

**Why a separate Worker, not code added to this one.** This Worker already
owns the top-level `/health` path for its own liveness (see the router at
the bottom of `src/index.ts`). Adding the container routes here would either
collide with that path or force renaming an existing, tested route — exactly
the restructuring of this Worker's existing code this change was scoped to
avoid. A dedicated Worker gives the container routes their own unambiguous
origin and leaves every byte of `hosted/src/*.ts` untouched. See
`containers/wrangler.toml`'s own header comment for the full reasoning.

### Deploy steps

1. `npm ci` at the repo root (the Dockerfile's build stage does this itself
   during the container image build; this step is only needed here if you
   want to build/test the image locally first — see "Local build proof"
   below).
2. `cd containers && npm install`.
3. Set `containers/wrangler.toml`'s `HOSTED_WORKER_ORIGIN` var to this
   Worker's own deployed origin (the same value as this Worker's own
   `PUBLIC_BASE_URL`, step 8 above) — the transport container needs it for
   both `HOSTED_AUTH_URL` and `HOSTED_VAULT_URL`, and the digest-compose
   container needs it for `HOSTED_VAULT_URL` (see
   `containers/src/index.ts`'s `ensureRunning` calls for exactly which env
   var each role gets). Note: `ensureRunning` passes env only when an
   instance first starts, so changing a var (for example
   `HOSTED_WORKER_ORIGIN`) requires restarting the instance to take effect.
4. If this Worker's `DIGEST_COMPOSE_SECRET` (step 14 above) is set, mirror it
   here: `npx wrangler secret put DIGEST_COMPOSE_SECRET` in `containers/`,
   same value.
5. `cd containers && npm run deploy` (`wrangler deploy`). This builds the
   Docker image from the repo-root `Dockerfile` and pushes it to Cloudflare's
   container registry as part of the deploy — a working Docker CLI/daemon on
   the machine running this command is required (see "Local build proof"
   below for why that could not be exercised in this PR's build
   environment).
6. Back in this Worker's own `wrangler.toml`, set `DIGEST_SERVICE_URL` to
   `https://<containers-worker-origin>/digest` (`src/digest.ts` appends
   `/compose` itself, matching `containers/src/index.ts`'s
   `/digest/compose` route) and redeploy this Worker.
7. Point MCP clients at `https://<containers-worker-origin>/mcp` instead of a
   separately-hosted transport URL.

### Env vars per service (inside the container)

| Var | Service | Source |
| --- | --- | --- |
| `HOSTED_AUTH_URL` | transport | `containers/wrangler.toml`'s `HOSTED_WORKER_ORIGIN`, forwarded by `McpTransportContainer` |
| `HOSTED_VAULT_URL` | both | same |
| `HOSTED_TRANSPORT_PORT` | transport | fixed at `8787` by `containers/src/index.ts` |
| `DIGEST_SERVICE_PORT` | digest-compose | fixed at `8788` by `containers/src/index.ts` |
| `DIGEST_COMPOSE_SECRET` | digest-compose | `containers/wrangler.toml` secret, forwarded if set |
| `CONTAINER_SERVICE` | both | set by the Dockerfile default (`hosted-transport`) or overridden per container class by `containers/src/index.ts` |

None of these are baked into the image; every one is supplied at container
start time (`ContainerStartupOptions.env`), matching how every other secret
in this repo is handled — never committed, never in the image.

### Local build proof: deferred, and why

A working Docker CLI and daemon ARE available in this PR's build
environment, and `containers/wrangler.toml`'s shape was validated directly
with `npx wrangler deploy --dry-run --outdir dist --containers-rollout=none`
(wrangler v4 — v3.90, the version this repo's other Workers pin, rejects the
`[[containers]]` array syntax entirely with "containers should be an object,
but got an array"; `containers/package.json` pins `wrangler@^4` and
`@cloudflare/workers-types@^5` for this reason, one version ahead of
`hosted/`, `issuer/`, and `waitlist/`). That dry run confirmed both container
classes resolve to the repo-root `Dockerfile` and both Durable Object
bindings wire up correctly.

A full `docker build .` of the Dockerfile itself could not complete in this
build environment: the base-image pull (`node:22-alpine`) is blocked by an
organisation egress policy at the proxy layer (`production.cloudfront.docker.com`
returns 403 to the CONNECT), not by a Dockerfile defect. As a substitute
proof, the Dockerfile's actual build+run steps were exercised directly on
the host: `npm ci && npm run build` (the Dockerfile's build stage, verbatim)
followed by running the exact same commands the image's `CMD` runs —
`node dist/index.js hosted-transport` and `node dist/index.js hosted-digest`,
each with the same env vars a container instance would receive — and both
returned `200` on `GET /health`. This proves the build script and runtime
entrypoint are correct; it does not prove the Docker layer itself builds
end to end. Run `docker build -t affiliate-mcp-hosted-services .` from the
repo root in an environment with normal Docker Hub access before the first
deploy, as the final confirmation this PR could not complete itself.

### Streaming (SSE) through the container binding: verify before relying on it

The transport's `GET /mcp` long-lived SSE connections
(`StreamableHTTPServerTransport`, `src/hosted-transport/http-server.ts`) need
to pass through `container.getTcpPort(port).fetch(request)` unbuffered.
Cloudflare's container binding is documented as a plain HTTP/TCP proxy, which
is consistent with streaming passing through, but this repo's build
environment could not load `developers.cloudflare.com` directly to confirm
against a worked streaming example (see `containers/wrangler.toml`'s header
comment for the same 403-to-automated-fetch limitation). **Verify this first
at deploy**, with a real `GET /mcp` SSE round-trip against a staging deploy,
before depending on it in production.

### MCP session affinity: the transport container is pinned to one instance

`src/hosted-transport/http-server.ts` keeps its MCP session state (the
in-memory `sessions` map, keyed by `mcp-session-id`) in the one process
handling it. Cloudflare's own container-routing guidance states plainly that
the Durable Object id you route by IS your scaling strategy — session-sticky
routing across multiple container replicas needs a stable per-session key on
every request, and the transport's `mcp-session-id` does not exist until
after the `initialize` round-trip that creates it, so there is no key to
route the very first request by. Rather than guess at an unverified affinity
scheme, `containers/src/index.ts` routes every `/mcp` and `/health` request
to one fixed Durable Object name, and `containers/wrangler.toml` pins
`McpTransportContainer` to `max_instances = 1` to match. This is not a
capability regression (a single Node process was already the deployment
shape being replaced), but it does mean this path does not yet give the
transport horizontal scale. Raising `max_instances` above 1 needs either a
session-affinity design or moving the transport's session state out of
process — design that before relying on more than one instance.

### Fallback: any container host runs the same image

The repo-root `Dockerfile` is a standard multi-stage Node image with no
Cloudflare-specific step in it. Fly.io, Railway, a plain VPS with Docker, or
any other container host runs it unchanged — set `CONTAINER_SERVICE`,
`HOSTED_AUTH_URL`/`HOSTED_VAULT_URL`, and (for the digest-compose role)
`DIGEST_SERVICE_PORT`/`DIGEST_COMPOSE_SECRET` as plain environment variables,
same as step 14's original systemd-unit deploy shape
(`src/hosted-digest/index.ts`'s file header). This is the fallback if the
Cloudflare Containers streaming or session-affinity questions above do not
resolve favourably, or if Rob simply prefers to keep the Node services off
Cloudflare.

## Local checks

- `npm test` — request-link neutrality (including the identical over-limit
  response), the configured-origin magic link (a poisoned request Host never
  reaches the email), single-use token consumption, expiry, session
  sign/verify roundtrip, tamper rejection, health, CORS, that no log line
  ever contains an email address (H2); the vault's round-trip
  encrypt/decrypt, wrong-master-key failure, per-user isolation, complete
  deletion, master-key rotation, no-plaintext-in-logs, route auth, and
  list-never-returns-values (H3, `test/vault.test.ts` and
  `test/vault-routes.test.ts`); the H5 connect flow's sign-in gating,
  the rejection of a session token in any URL query parameter, POST-body
  navigation, per-network form rendering, store-then-test success and
  failure paths, that no batch/multi-network endpoint exists, that no HTML
  response ever carries an unmasked credential value, that no URL in any
  rendered page carries the session token, and that every connect response
  carries `cache-control: no-store` and `referrer-policy: no-referrer`
  (`test/connect-routes.test.ts`); and (H6) subscription-state resolution
  and complete billing deletion (`test/billing.test.ts`), the Stripe
  webhook-signature verifier plus the billing-portal session request shape
  (`test/stripe.test.ts`), the billing routes: checkout metadata, webhook
  idempotency and tier derivation, the ignored-checkout warning,
  `POST /billing/portal`'s own-customer-id scoping and `unknown_account`/
  `billing_not_configured` handling, full-session gating
  (`test/billing-routes.test.ts`); the billing page's auth-gating, tier-none
  subscribe buttons, Solo/Pro manage-and-upgrade actions, the
  checkout/portal hand-off calling the existing routes in-process with the
  right tier, no session token in any URL, and the Stripe-return landing
  showing the sign-in prompt with an honest status line rather than a
  fabricated result (`test/billing-page.test.ts`); token-scope enforcement
  across every session-gated surface (digest tokens accepted by exactly the
  two vault read routes, refused everywhere else, including
  `POST /billing/portal`: `test/scope.test.ts`), account deletion covering
  all three KV namespaces including the billing email and digest roster
  (`test/vault-routes.test.ts`), and the scheduled digest orchestration:
  in-process roster, digest-scoped 15-minute token minting verified against
  the real signing key, userId-only compose bodies, Worker-side email
  resolution, Solo/Pro digest-type split, send-time entitlement re-check,
  and per-failure isolation (`test/digest-scheduled.test.ts`). Resend,
  Stripe, the compose service, and every per-network connection test are
  mocked via a spy on `fetch`; KV is an in-memory fake. No live network
  calls.
- `npm run typecheck`.

## What this slice deliberately does not do

- No remote MCP transport, adapter wiring, rate limiting, or audit log HERE —
  H4 built all of that as a Node service in the root workspace
  (`src/hosted-transport/`), not in this Worker; see "H4: remote MCP transport
  lives in the root workspace, not here" above. This Worker's only H4-facing
  addition is the `GET /vault/credentials/:network/reveal` route that Node
  service calls, over HTTP, with the caller's own session token.
- No OAuth browser-redirect flow for any network — see "H5: guided connect
  flow" above for why all four are guided-paste.
- No automatic first-value report generated by this Worker. The H5 success
  page states this and points at the H4 Node transport instead of faking a
  report; see "First-value pointer, honestly bounded" above.
- Per-network ToS clearance for the four production networks was confirmed
  by Rob on 2026-07-14 — see "Hosted eligibility: ToS check" above.
- No session revocation. Session tokens are stateless (see `src/token.ts`);
  `DELETE /account` removes everything a token could reach but does not
  invalidate the token itself before its natural expiry. See the file-header
  comment in `src/routes/account.ts`.
- No KMS-backed master key. The v1 `MasterKeyProvider`
  (`workerSecretMasterKey`) wraps data keys with a Worker secret; see "Vault
  threat model" above for what that does and does not protect against, and
  the decision this slice's PR leaves open for Rob.
- No admin routes and no service credential that can enumerate tenants or
  mint sessions from outside this Worker — deliberately, by Rob's 2026-07-14
  decision. See "Digest orchestration and token scopes: threat model" above;
  tier administration outside the normal Stripe checkout/portal flow is
  manual `wrangler kv key put`, kept now only as a break-glass appendix
  ("Manual tier administration (break-glass only, now that Stripe is
  wired)").
- The billing page (`GET|POST /connect/billing`, "Billing (Stripe checkout,
  portal, and the billing page)" above) has no server-side polling or
  webhook-status view of its own: it reads `GET /billing/entitlement`
  in-process on every load, so a Checkout or Portal action is reflected the
  next time the page is opened, never instantly on the redirect back (Stripe's
  redirect cannot carry a session token; see that section for why this is
  stated plainly rather than worked around).

`src/shared/request-context.ts` (H1) is the seam H4 will use to run adapter
calls under a per-tenant identity; this slice does not touch it or wire any
adapter to it.
