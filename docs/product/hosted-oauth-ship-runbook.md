# Hosted connector OAuth: ship runbook

What it takes to ship the OAuth migration
(`docs/decisions/2026-07-15-hosted-connector-oauth.md`) to the live hosted
tier. Written after slices 1 to 3 merged to `main` (PRs #371, #372, #373) and
passed local runtime testing. Deploys to any live environment are Rob-only;
this runbook is the ordered checklist, not an authorisation to deploy.

## What is already built and merged

- **Slice 1 (#371):** OAuth 2.1 authorization server on the hosted Worker
  (`/authorize`, `/token`, `/register`, `/.well-known/oauth-authorization-server`),
  PKCE S256, consent reusing the magic-link identity. Access token is a
  short-lived full-scope `amcps_` session; refresh token is opaque and rotated.
- **Slice 2 (#372):** the transport enforces an optional maximum token lifetime
  (`HOSTED_MAX_TOKEN_LIFETIME_SECONDS`); `/auth/session/verify` returns `iss`.
- **Slice 3 (#373):** the browser connect/manage dashboard authenticates via an
  HttpOnly `SameSite=Strict` cookie set at magic-link callback, with a
  same-origin CSRF check on state-changing POSTs; the pasted-token surface is
  gone and the terminal step is a client-native "add connector" affordance.

Verified locally (`wrangler dev`): metadata discovery, dynamic client
registration, `/authorize` validation and the open-redirect guard, `/token`
error paths, `/auth/session/verify` returning `iss`, the no-cookie sign-in
prompt, the cookie dashboard not leaking the token into any page body, and the
cross-site-Origin POST returning 403. Plus 233 hosted and 43 transport tests.

## The gap between "built" and "usable by an MCP client"

The authorization server is complete, but an MCP client (Claude, ChatGPT)
discovers it by the MCP authorization framework's handshake: it calls the
**resource server** (the hosted MCP transport), receives a `401` carrying a
`WWW-Authenticate: Bearer resource_metadata="…"` header, fetches that
**protected resource metadata** (RFC 9728, `/.well-known/oauth-protected-resource`),
and follows it to the authorization server. The transport today returns a bare
`401 { error: "missing_session" | "invalid_session" }` with no
`WWW-Authenticate` header and serves no protected-resource metadata
(`src/hosted-transport/http-server.ts`). So a client pointed at the transport
cannot auto-discover the OAuth endpoints, because the transport and the Worker
are different origins and the transport advertises nothing.

This discovery wiring was not part of slices 1 to 3 and is the one code
follow-up required before OAuth works end to end with a real client. It is
small and transport-side (a `WWW-Authenticate` challenge on the 401 plus a
`/.well-known/oauth-protected-resource` document pointing at the Worker's
issuer). Track it as slice 2b.

## Ship in tiers

### Tier A — shippable now, independent value (Worker only)

Deploying the Worker removes the confusing token-paste page immediately: new
browser sign-ins land on the cookie dashboard, and the OAuth endpoints go live.
It does not break anything already connected (see Tier C).

1. Confirm `main` is green and the live `hosted/wrangler.toml` in the deploy
   environment has the real KV namespace ids and that `SESSION_SIGNING_KEY`,
   `VAULT_MASTER_KEY`, `RESEND_API_KEY` are already set (they are, from the
   H2 to H6 deploys). OAuth adds no new secret and no new KV namespace: the
   `oauth:*` records live in the existing `HOSTED_USERS`.
2. From `hosted/` in the deploy environment: `npm ci`, `npm test` (sanity),
   `npm run deploy`.
3. Post-deploy smoke against the live origin:
   - `GET /health` returns 200.
   - `GET /.well-known/oauth-authorization-server` returns the metadata with
     the correct live `issuer`.
   - Sign in by email and confirm the callback now redirects to `/connect`
     and sets the `hosted_session` cookie (no token page).
4. Redeploy the **hosted-transport** Node service (slice 2's `iss` cap logic).
   Leave `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` unset for now (dual-accept).

Deploy the Worker before enabling any lifetime cap, so `/auth/session/verify`
is already returning `iss` first.

### Tier B — required before an MCP client can use OAuth

5. **Done.** The H4 transport is deployed and live at
   `https://mcp.agenticaffiliate.ai` (Cloudflare Containers via
   `deploy-containers.yml`). Verified:
   `GET https://mcp.agenticaffiliate.ai/.well-known/oauth-protected-resource`
   returns 200 with `resource` = `https://mcp.agenticaffiliate.ai` and
   `authorization_servers` = `["https://hosted.agenticaffiliate.ai"]`. See
   `docs/product/hosted-transport-deploy-runbook.md` for the ordered deploy
   steps used.
6. Transport OAuth discovery is now **implemented** (slice 2b, PR #375): the
   transport's `401`s carry a `WWW-Authenticate` challenge and it serves
   `/.well-known/oauth-protected-resource` pointing at the Worker's issuer,
   both gated on the `HOSTED_TRANSPORT_PUBLIC_URL` env var (unset = discovery
   off, backward-compatible). Set `HOSTED_TRANSPORT_PUBLIC_URL` (the transport's
   own public origin) to enable client auto-discovery.
7. **Done.** `HOSTED_CONNECTOR_URL` (Worker var) is set in production to
   `https://mcp.agenticaffiliate.ai/mcp`, so the connect success page shows the
   real connector URL instead of the placeholder (implemented in slice 2b).
8. End-to-end test against a real MCP client (the H4 acceptance proof that was
   always a Rob-only follow-up): add affiliate-mcp as a custom connector in
   Claude, complete the browser OAuth + consent, and confirm a tool call runs
   under the caller's own identity. Confirm an existing `amcps_` bearer still
   authenticates the transport (dual-accept holds).

### Tier C — cutover (deliberate, after a deprecation window)

9. Announce the deprecation window to any existing hosted users holding a
   pasted bearer.
10. When the window closes, set `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` (about 7200)
    on the transport. This drops every long-lived pasted bearer at once while
    keeping short-lived OAuth access tokens, and is the documented revocation
    lever for outstanding bearers.

## Non-blocking hardening follow-ups (post-ship)

Surfaced by the independent reviews; none gate the tiers above:

- Refresh-token-family revocation on reuse detection (RFC 6819 §5.2.2.3).
- RFC 8707 resource-indicator audience binding on access tokens.
- A shorter dashboard-cookie TTL and a sign-out route
  (`clearSessionCookieHeader` is implemented and tested but unwired).
- A route-level test asserting a digest-scoped token is refused by the
  dashboard (the primitive is covered; the route assertion is a gap).

## Rollback

- Worker: `wrangler rollback` (or redeploy the previous version). The cookie
  and OAuth endpoints are additive; the removed token page has no dependents
  once the connect flow reads the cookie.
- Transport: unset `HOSTED_MAX_TOKEN_LIFETIME_SECONDS` to return to dual-accept
  instantly, or redeploy the previous build.
