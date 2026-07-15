# Hosted connector authentication: OAuth instead of a pasted bearer token

- **Date:** 2026-07-15
- **Status:** Proposed (decision pending Rob's acceptance)
- **Affects:** the live hosted connect flow (`hosted/src/index.ts`
  `renderSessionPage` and `handleSessionCallback`, `hosted/src/routes/connect.ts`,
  `hosted/src/token.ts`) and the transport-side verification
  (`src/hosted-transport/session-auth.ts`); `hosted/README.md`; slice H4/H5
  wording in `docs/product/hosted-mvp-workstream.md`
- **Builds on:** [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md),
  [`2026-07-13-build-hosted-without-presell.md`](./2026-07-13-build-hosted-without-presell.md)
- **Relates to:** [`2026-07-12-pricing-billing-and-licence.md`](./2026-07-12-pricing-billing-and-licence.md)

## Context

The hosted tier is live. A user signs in with an email magic link
(`/auth/request-link`, `/auth/callback`), and the Worker then mints a
**30-day, full-account, Ed25519-signed bearer token** (`amcps_…`,
`hosted/src/token.ts`) and renders it into a copyable page
(`renderSessionPage`) whose instruction is: "Copy this session token into your
MCP client's connection settings." The MCP client presents that raw token on
every call; the transport verifies it (`resolveValidSession`;
`src/hosted-transport/session-auth.ts`).

Two problems, both now hitting real users:

1. **The connect step does not tell the user what to do.** "Paste it into your
   MCP client's connection settings" names no client, no setting, and no steps.
   This is the exact confusion that prompted this record: a user copied the
   token and had nowhere obvious to put it. The single most important moment of
   the hosted funnel is unclear.
2. **The credential is a poor security shape.** The token is a bearer that, in
   its own words, lets "anyone holding it act as your account", is valid for 30
   days, has no refresh or revocation short of expiry, and is designed to be
   copied by hand and pasted into another application's settings. Every one of
   those properties widens the blast radius of a leak.

The MCP ecosystem has a standard answer: the MCP authorization framework, in
which the MCP client performs an OAuth authorization-code flow with the server
and stores the resulting token itself. The user authenticates in the browser
and pastes nothing. Claude's custom-connector flow and ChatGPT's connector flow
both drive this. The hosted Worker already has the browser identity step (magic
link) such a flow needs.

Because this changes the authentication contract of a live surface that fronts
per-user credentials, it is recorded and taken to Rob before implementation.

## Decision

Replace the pasted bearer session token with **OAuth 2.1 authorization-code +
PKCE** as the authentication model for the hosted remote MCP transport, per the
MCP authorization framework.

1. **Identity reuse, not a new login.** The existing email magic-link sign-in
   remains the identity step. The OAuth authorization endpoint drives it and
   issues an authorization code; no passwords and no second account system.
2. **Client stores the token, the user does not.** The MCP client completes the
   code-for-token exchange and stores the access and refresh tokens itself. No
   token is rendered for the user to copy, and nothing is pasted into a client's
   settings. The terminal page becomes "you're connected", not "here is a token".
3. **Short-lived access tokens with refresh**, replacing the 30-day bearer. The
   full-vs-digest scope distinction in `hosted/src/token.ts` is preserved:
   digest-scoped tokens stay refused by non-digest surfaces.
4. **PKCE mandatory** for the public clients (desktop and web MCP clients) this
   serves. Dynamic client registration supported where the client uses it; a
   documented static registration path exists for clients that do not.
5. **Custody contract unchanged.** This decision is about how a client proves
   who the user is, not about what the tier holds or does with it. The
   `2026-07-12-hosted-credential-custody.md` contract (bring-your-own-key,
   read-only, decrypt at call time, serve only the key's owner, self-serve
   export and hard delete) is untouched. Nothing here expands custody.

This is distinct from slice H5's existing "OAuth where supported" language,
which refers to collecting a **network's** credentials (Awin, CJ, and similar)
during connect: a different OAuth surface, between the hosted service and each
affiliate network. This record governs only **client-to-hosted-transport**
authentication. The two must not be conflated.

## Migration (a live surface)

Because tokens are already in the wild, the swap is staged, not a hard cutover:

- The transport accepts both the existing `amcps_` bearer and OAuth access
  tokens during a deprecation window, then drops bearer acceptance.
- The connect page stops minting new pasteable bearers as soon as the OAuth
  flow is available; existing bearers keep working until their 30-day expiry or
  the window closes, whichever is first.
- A revocation path for outstanding bearers is documented before the window
  closes.

## Rejected alternatives

- **Keep the pasted bearer (status quo).** Simplest to run, but it is the live
  UX dead end and the leak-prone credential shape this record exists to remove.
- **Set-Cookie session.** Already rejected in `renderSessionPage`'s own comment:
  a cookie scoped to the Worker origin never reaches a non-browser MCP client,
  so it cannot authenticate the transport.
- **Keep the bearer but add per-client copy helpers** (precise "Settings ->
  Connectors -> Add custom connector" steps, copy-both button, deep links).
  A real near-term improvement to the paste flow that could ship as an interim,
  but still a manual paste of a long-lived full-account bearer, so not the
  destination.

## Consequences and implementation follow-ups

- **On acceptance**, `hosted/README.md` and the H4/H5 wording in
  `docs/product/hosted-mvp-workstream.md` are updated to describe the OAuth
  model instead of "per-user token auth".
- **Implementation is a sequenced set of hosted PRs**, each `active-risk`, one
  at a time, independent agent review plus green CI, Rob-authorised, deploys
  Rob-only:
  1. OAuth authorization and token endpoints on the Worker, PKCE, consent
     reusing magic-link identity; the connect terminal step stops minting a
     pasteable bearer.
  2. Transport-side auth accepts OAuth access tokens (dual-accept window per
     Migration), short TTL plus refresh, digest-scope refusal preserved.
  3. Connect-page rewrite to a client-native "add connector" affordance.
- **No implementation against this direction until this record is accepted.**
  Until then, only the optional interim copy polish (the retained alternative
  above) is in scope.
- **Stop condition.** If OAuth cannot be delivered inside the custody contract,
  stop for a further decision rather than expanding custody.
