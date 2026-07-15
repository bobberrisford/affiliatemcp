# Hosted MVP workstream brief

> Status: active workstream (started 2026-07-13 under
> [`2026-07-13-build-hosted-without-presell.md`](../decisions/2026-07-13-build-hosted-without-presell.md)).
> This is the multi-PR brief AGENTS.md requires before implementation.
> Bounded by the accepted custody record: bring-your-own-key, read-only,
> encrypted per-user keys decrypted at call time, serving only each key's
> owner. Browser handoffs and write actions stay local-only.

## User outcome

An agency account manager, brand manager, or multi-network publisher signs
in with a browser, connects Awin, CJ, Impact, or Rakuten through a guided
flow, and uses the same tools and workflows from Claude or ChatGPT with no
runtime, no terminal, and no laptop-awake constraint. The first paid-only
capability is the scheduled digest (earnings plus unpaid commissions).

## Dependency graph and slices

Each slice is one PR, `active-risk`, sequential (one at a time per the lane
rules), independent agent review plus green CI before merge, maintainer
authorisation per the standing delivery window or explicit approval.

1. **H1: request-scoped identity seam.** Credential, OAuth-token, brand, and
   client-strategy resolution move behind request-scoped interfaces with the
   local single-user implementation as the default. First real consumer: the
   existing local server running through the seam. Acceptance proof: the
   full existing test suite passes unchanged, plus new seam tests; zero
   behaviour change locally.
2. **H2: hosted service scaffold and user auth.** A new top-level `hosted/`
   workspace following the existing Worker pattern (issuer, telemetry,
   waitlist). Email magic-link sign-in (no passwords), session tokens,
   health and smoke tests, own CI job. Recommended runtime: Cloudflare
   Workers, matching the three existing Workers; the slice PR records the
   trade-offs (adapter fetch portability, CPU limits for large report
   aggregation) and is the point to reverse if Workers prove unfit.
3. **H3: encrypted credential vault.** Per-user envelope encryption with
   per-user data keys, decrypt only at call time, key-rotation procedure
   documented, deletion complete. Open custody question H3's threat-model
   note must resolve before merge, not silently default: a master key in
   Worker secrets is envelope encryption on managed infrastructure but not
   KMS-backed in the usual sense (the master key is exposed to application
   code); H3 either names an actual KMS or records Rob's explicit acceptance
   of the Worker-secret design. Acceptance proof: vault tests including
   rotation and hard delete; the threat-model note resolving the KMS
   question.
4. **H4: remote MCP transport.** Streamable HTTP MCP endpoint with per-user
   client authentication, per-tier rate limits, and a per-user audit log
   (network, operation, timestamp; never payloads). Client authentication is
   moving from the original pasted per-user bearer to an OAuth 2.1
   authorization-code + PKCE flow per the MCP authorization framework
   (`docs/decisions/2026-07-15-hosted-connector-oauth.md`): the authorization
   server (`/authorize`, `/token`, `/register`) lives in the `hosted/` Worker,
   and the transport accepts the resulting short-lived access tokens (the swap
   is staged — the transport enforces an optional maximum token lifetime
   (`HOSTED_MAX_TOKEN_LIFETIME_SECONDS`), so long-lived pasted bearers are
   dropped only when that cap is set, after a dual-accept window; see that
   decision's Migration section and `hosted/README.md`, "OAuth (slice 1)"). Adapters untouched; requests run through the H1 seam against
   H3 credentials. Runs as a Node service in the
   root workspace (`src/hosted-transport/`), not inside the `hosted/` Worker —
   see `hosted/README.md` ("H4: remote MCP transport lives in the root
   workspace, not here") for why. Acceptance proof for this slice's PR: an
   in-process MCP client end-to-end test (real streamable-HTTP transport, real
   `node:http` server, mocked hosted auth/vault HTTP calls), runnable in CI.
   An MCP client end-to-end test against a real staging deploy with a test
   credential remains a Rob-only follow-up once a deploy exists.
5. **H5: guided connect flow.** Browser onboarding for the four production
   networks: OAuth where supported, guided paste-once otherwise, connection
   test on save, automatic first-value report. ("OAuth where supported" here
   means a **network's** own OAuth for collecting that network's credentials,
   e.g. Rakuten's client-credentials exchange — distinct from, and not to be
   conflated with, the client-to-transport OAuth in
   `docs/decisions/2026-07-15-hosted-connector-oauth.md`.) Terms-of-service
   check per
   network recorded before it is offered hosted, and the flow instructs
   users to create scoped or read-only API keys where the network offers
   them, per the custody record's least-privilege clause. Acceptance proof:
   an end-to-end connect against a staging deploy for each of the four
   networks, with each ToS check recorded.
6. **H6: scheduled digest and billing tie-in.** The digest job runner and
   the Stripe subscription state enforced at the transport boundary,
   reusing the issuer's billing pattern. Acceptance proof: a digest
   delivered end to end to a test user on a staging deploy, and the
   entitlement-denied path proven at the transport boundary.

Cross-slice docs (trust page, PRIVACY.md hosted section) land with H3 and
H4 respectively, per the custody record's follow-ups.

## Risk gates

- Custody boundaries are non-negotiable slice to slice; any deviation stops
  the workstream for a decision.
- H2's runtime choice and H4's transport are the two highest-reversal-cost
  points; each PR must state what reversing would cost.
- Deploys to any live environment are Rob-only throughout.

## Stop conditions

- Rob pauses or redirects the workstream.
- A slice cannot meet the custody contract without expanding it.
- The H4 end-to-end proof cannot pass against a real MCP client.

## Deliberately excluded

Hosted write actions, browser handoffs, team seats, SOC 2 work, any network
beyond the four production adapters, and every marketing surface change
except repointing the pricing CTA as slices ship.
