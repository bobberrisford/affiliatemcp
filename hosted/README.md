# affiliate-mcp hosted

A Cloudflare Worker for the hosted service: user auth (workstream slice H2),
the encrypted credential vault (workstream slice H3), and the guided connect
flow (workstream slice H5), per `docs/product/hosted-mvp-workstream.md`.

Two KV namespaces, kept deliberately separate:

- `HOSTED_USERS` (H2) holds **no affiliate credentials and no affiliate
  data**. It knows a user id and an email-hash lookup, and nothing else.
- `HOSTED_VAULT` (H3) holds the encrypted credential vault: one wrapped data
  key per user and one encrypted blob per connected network. See "Vault
  (H3)" below for the design, and "Vault threat model" for the honest
  read on what the current master-key design does and does not protect
  against — **the master-key decision it raises was accepted by Rob on
  2026-07-14 (Worker-secret design for the MVP).**

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

## KV storage shapes (H2: `HOSTED_USERS`)

One namespace, four key shapes, no affiliate data in any of them:

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
GET  /connect                       list the four networks + connection status
GET  /connect/:network              guided credential form for one network
POST /connect/:network              store the credential, then connection-test it
GET  /connect/:network/retest       re-run the connection test, no resubmit
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

### Session gating on plain HTML pages

Every route above requires the same valid session `requireSession`
(`src/routes/guard.ts`) checks for the H3 vault routes, verified with the
identical primitive, `resolveValidSession` (`src/token.ts`). What differs is
transport, not trust: these are pages a browser navigates to directly, so a
custom `Authorization` header is not available without client-side
JavaScript, which this flow deliberately avoids. `resolveBrowserSession`
(`src/routes/connect.ts`) accepts the session token from the `Authorization`
header (parity with every API route) OR a `token` query parameter / hidden
form field, threaded from link to link across the flow. An unauthenticated
visitor sees a sign-in prompt page — an explanation, a link to the front-end
sign-in origin (`SITE_ORIGIN`), and a plain `<form method="get">` to paste in
a session token obtained from the H2 callback page — rather than
`requireSession`'s JSON 401, which would be meaningless to a human in a
browser tab.

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

- **Awin** — unverified. Rob must confirm against Awin's current API terms
  before this network is offered hosted in production.
- **CJ Affiliate** — unverified. Rob must confirm against CJ's current API
  terms before this network is offered hosted in production.
- **Impact** — unverified. Rob must confirm against Impact's current API
  terms before this network is offered hosted in production.
- **Rakuten Advertising** — unverified. Rob must confirm against Rakuten's
  current API terms before this network is offered hosted in production,
  including whether its API-access approval process (Publisher Solutions
  sign-off, `docs/networks/rakuten.md`) itself constrains third-party or
  hosted use of the resulting credentials.

This connect flow being buildable and testable is not the same thing as any
network being cleared to run hosted in production — the acceptance proof the
workstream brief sets for H5 ("an end-to-end connect against a staging
deploy for each of the four networks, with each ToS check recorded") still
needs this table replaced with an actual per-network review before a staging
or production deploy offers these networks to real users.

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
10. `npm run deploy`.

## Local checks

- `npm test` — request-link neutrality (including the identical over-limit
  response), the configured-origin magic link (a poisoned request Host never
  reaches the email), single-use token consumption, expiry, session
  sign/verify roundtrip, tamper rejection, health, CORS, that no log line
  ever contains an email address (H2), and the vault's round-trip
  encrypt/decrypt, wrong-master-key failure, per-user isolation, complete
  deletion, master-key rotation, no-plaintext-in-logs, route auth, and
  list-never-returns-values (H3, `test/vault.test.ts` and
  `test/vault-routes.test.ts`), and the H5 connect flow's sign-in gating,
  per-network form rendering, store-then-test success and failure paths, that
  no batch/multi-network endpoint exists, that no HTML response ever carries
  an unmasked credential value, and that every connect response carries
  `cache-control: no-store` (`test/connect-routes.test.ts`). Resend and every
  per-network connection test are mocked via a spy on `fetch`; KV is an
  in-memory fake. No live network calls.
- `npm run typecheck`.

## What this slice deliberately does not do

- No remote MCP transport, adapter wiring, rate limiting, or audit log HERE —
  H4 built all of that as a Node service in the root workspace
  (`src/hosted-transport/`), not in this Worker; see "H4: remote MCP transport
  lives in the root workspace, not here" above. This Worker's only H4-facing
  addition is the `GET /vault/credentials/:network/reveal` route that Node
  service calls, over HTTP, with the caller's own session token.
- No billing/entitlement enforcement (H6) — H5's connect flow (above) has now
  shipped.
- No OAuth browser-redirect flow for any network — see "H5: guided connect
  flow" above for why all four are guided-paste.
- No automatic first-value report generated by this Worker. The H5 success
  page states this and points at the H4 Node transport instead of faking a
  report; see "First-value pointer, honestly bounded" above.
- No per-network ToS clearance recorded yet — see "Hosted eligibility: ToS
  check" above; every one of the four is unverified pending Rob's review.
- No session revocation. Session tokens are stateless (see `src/token.ts`);
  `DELETE /account` removes everything a token could reach but does not
  invalidate the token itself before its natural expiry. See the file-header
  comment in `src/routes/account.ts`.
- No KMS-backed master key. The v1 `MasterKeyProvider`
  (`workerSecretMasterKey`) wraps data keys with a Worker secret; see "Vault
  threat model" above for what that does and does not protect against, and
  the decision this slice's PR leaves open for Rob.

`src/shared/request-context.ts` (H1) is the seam H4 will use to run adapter
calls under a per-tenant identity; this slice does not touch it or wire any
adapter to it.
